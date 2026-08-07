// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ResearchRpcRequest, ResearchRpcResponse } from "@research-agent/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { successResult } from "../../src/kernel/results.ts";
import { initializeProject } from "../../src/project/init.ts";
import { runResearchRpcServer } from "../../src/rpc/server.ts";
import { createResearchSdk } from "../../src/sdk/index.ts";
import { finishOperation, startOperation } from "../../src/tools/operations.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-research-sdk-rpc-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function rpc(
	sdk: Awaited<ReturnType<typeof createResearchSdk>>,
	lines: string[],
): Promise<ResearchRpcResponse[]> {
	const input = new PassThrough();
	const output = new PassThrough();
	output.setEncoding("utf8");
	let text = "";
	output.on("data", (chunk: string) => {
		text += chunk;
	});
	const running = runResearchRpcServer(sdk, { input, output });
	input.end(`${lines.join("\n")}\n`);
	await running;
	return text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as ResearchRpcResponse);
}

describe("stable SDK and stdio RPC", () => {
	it("returns identical results for two configured canonical projects", async () => {
		const management = join(root, "API_KEY_SHOULD_NOT_LEAK");
		const publicAdministration = join(root, "public-administration");
		const managementManifest = await initializeProject(management, {
			title: "Management project",
			domain: "management",
		});
		const publicManifest = await initializeProject(publicAdministration, {
			title: "Public administration project",
			domain: "public-administration",
		});
		if (managementManifest.compatibility !== "current" || publicManifest.compatibility !== "current") {
			throw new Error("Expected current project fixtures");
		}
		await writeFile(join(management, "notes", "private.txt"), "PRIVATE_INTERVIEW_TEXT_SHOULD_NOT_LEAK");
		const managementProjectId = managementManifest.manifest.projectId;
		const publicProjectId = publicManifest.manifest.projectId;
		const operation = await startOperation(management, {
			operationKind: "tool",
			name: "sdk.fixture",
			implementationVersion: "2.0.0",
			session: null,
		});
		if (!operation.ok) throw new Error(operation.errors[0].message);
		await finishOperation(management, operation.value.operationId, successResult(null, operation.value.operationId));
		const sdk = await createResearchSdk([management, publicAdministration]);
		const requests = [
			{
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "capabilities",
				method: "system.capabilities",
				params: null,
			},
			{
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "projects",
				method: "projects.list",
				params: null,
			},
			{
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "open",
				method: "project.open",
				params: { projectId: managementProjectId },
			},
			{
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "validate",
				method: "project.validate",
				params: { projectId: publicProjectId },
			},
			{
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "doctor",
				method: "project.doctor",
				params: { projectId: managementProjectId },
			},
			{
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "list-records",
				method: "records.list",
				params: { projectId: managementProjectId, kind: "operation" },
			},
			{
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "read-record",
				method: "records.read",
				params: {
					projectId: managementProjectId,
					kind: "operation",
					id: operation.value.operationId,
				},
			},
		] as const satisfies readonly ResearchRpcRequest[];
		const direct = [];
		for (const request of requests) direct.push(await sdk.invoke(request));
		const responses = await rpc(
			sdk,
			requests.map((request) => JSON.stringify(request)),
		);
		expect(responses.map(({ result }) => result)).toEqual(direct);
		expect(responses[0]).toMatchObject({
			result: {
				ok: true,
				value: {
					version: 2,
					packageVersion: "2.0.0",
					projectSchemaVersion: "1.5.1",
					mutations: "pi-governed-surfaces-only",
					hostPaths: "redacted",
					evidenceSubmission: {
						supportedLevels: ["metadata", "abstract", "fulltext_unlocated", "fulltext_located"],
						unsupportedLevels: ["table_or_figure_located", "dataset_or_appendix_located"],
					},
				},
			},
		});
		expect(responses[1]?.result).toMatchObject({
			ok: true,
			value: [
				{ projectId: managementProjectId, projectLocator: `research-project:${managementProjectId}` },
				{ projectId: publicProjectId, projectLocator: `research-project:${publicProjectId}` },
			],
		});
		expect(responses[5]?.result).toMatchObject({ ok: true, value: [operation.value.operationId] });
		expect(responses[6]?.result).toMatchObject({ ok: true, value: { name: "sdk.fixture", status: "succeeded" } });
		const snapshot = JSON.stringify(responses);
		expect(snapshot).not.toContain(management);
		expect(snapshot).not.toContain(homedir());
		expect(snapshot).not.toContain("API_KEY_SHOULD_NOT_LEAK");
		expect(snapshot).not.toContain("PRIVATE_INTERVIEW_TEXT_SHOULD_NOT_LEAK");

		const hostPathSdk = await createResearchSdk([management], { includeHostPaths: true });
		await expect(
			hostPathSdk.invoke({
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "host-paths",
				method: "projects.list",
				params: null,
			}),
		).resolves.toMatchObject({ ok: true, value: [{ hostRoot: managementManifest.root }] });
	});

	it("keeps malformed or unconfigured requests inside unified failures", async () => {
		const project = join(root, "project");
		await initializeProject(project, { title: "RPC failure project" });
		const sdk = await createResearchSdk([project]);
		const responses = await rpc(sdk, [
			"not-json",
			JSON.stringify({
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "",
				method: "projects.list",
				params: null,
			}),
			JSON.stringify({
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "unconfigured",
				method: "project.open",
				params: { projectId: "not-configured" },
			}),
			JSON.stringify({
				protocol: "pi-research-rpc",
				version: 1,
				requestId: "path-injection",
				method: "project.open",
				params: { projectId: "not-configured", projectRoot: "/tmp" },
			}),
		]);
		expect(responses).toMatchObject([
			{ result: { ok: false, errors: [{ code: "RPC_JSON_INVALID" }] } },
			{ requestId: "invalid-request", result: { ok: false, errors: [{ code: "RPC_REQUEST_INVALID" }] } },
			{ requestId: "unconfigured", result: { ok: false, errors: [{ code: "SDK_NOT_FOUND" }] } },
			{ requestId: "path-injection", result: { ok: false, errors: [{ code: "RPC_REQUEST_INVALID" }] } },
		]);
	});
});
