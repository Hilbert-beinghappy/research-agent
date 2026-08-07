// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conformAdapterPackage } from "../../src/adapters/conformance.ts";
import { registerAdapterPackage } from "../../src/adapters/registration.ts";
import { packProjectExchange } from "../../src/exchange/bundle.ts";
import { initializeProject } from "../../src/project/init.ts";
import { validateProject } from "../../src/project/validate.ts";
import { startOperation } from "../../src/tools/operations.ts";

const exampleAdapter = fileURLToPath(new URL("../../examples/adapters/open-catalog/", import.meta.url));
let root: string;
let project: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-research-adapter-registration-"));
	project = join(root, "project");
	await initializeProject(project, { title: "Adapter registration" });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("Adapter registration", () => {
	it("records a verified package and carries its exact requirement into exchange", async () => {
		const conformance = await conformAdapterPackage(exampleAdapter, "jsonl_process");
		const operation = await startOperation(project, {
			operationKind: "tool",
			name: "test.adapter.register",
			implementationVersion: "1.5.0",
			session: null,
		});
		if (!operation.ok) throw new Error(operation.errors[0].message);
		const registered = await registerAdapterPackage(project, exampleAdapter, {
			operationId: operation.value.operationId,
			conformance: conformance.report,
			isolationProfile: "jsonl_process",
		});
		expect(registered).toMatchObject({
			ok: true,
			value: {
				status: "active",
				manifest: { packageId: "example-open-catalog", contractVersion: 1 },
				conformance: { passed: true },
				isolationProfile: "jsonl_process",
			},
		});
		expect((await validateProject(project)).issues).toEqual([]);
		const exchange = await packProjectExchange(project, join(root, "exchange"));
		expect(exchange.requiredAdapters).toEqual([
			expect.objectContaining({
				packageId: "example-open-catalog",
				packageVersion: "1.0.0",
				packageHash: expect.any(Object),
				manifestHash: expect.any(Object),
			}),
		]);
	});

	it("rejects a conformance report from another package hash", async () => {
		const conformance = await conformAdapterPackage(exampleAdapter, "jsonl_process");
		const operation = await startOperation(project, {
			operationKind: "tool",
			name: "test.adapter.register.mismatch",
			implementationVersion: "1.5.0",
			session: null,
		});
		if (!operation.ok) throw new Error(operation.errors[0].message);
		const registered = await registerAdapterPackage(project, exampleAdapter, {
			operationId: operation.value.operationId,
			conformance: {
				...conformance.report,
				manifestHash: { algorithm: "sha256", value: "0".repeat(64) },
			},
			isolationProfile: "jsonl_process",
		});
		expect(registered).toMatchObject({
			ok: false,
			errors: [{ code: "ADAPTER_REGISTRATION_FAILED" }],
		});
		expect((await validateProject(project)).issues).toEqual([]);
	});
});
