// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterProtocolBrokerRequest } from "@research-agent/contracts/adapter-protocol";
import { describe, expect, it } from "vitest";
import { conformAdapterPackage } from "../../src/adapters/conformance.ts";
import { runAdapterProcess } from "../../src/adapters/runner.ts";
import type { ApprovalRecord } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { createResearchSdk } from "../../src/sdk/index.ts";
import { type ActionRequest, createActionRequest, evaluateActionPolicy } from "../../src/security/policy.ts";

const adapterRoot = fileURLToPath(new URL("../../examples/adapters/community-http-source/", import.meta.url));

function projectApproval(request: ActionRequest): ApprovalRecord {
	const now = "2026-08-07T00:00:00.000Z";
	const approvalId = createOpaqueId("approval");
	return {
		kind: "approval",
		schemaVersion: "1.5.0",
		approvalId,
		taskId: null,
		operationId: request.operationId,
		actionClass: request.actionClass,
		actionName: request.actionName,
		impactScope: request.paths,
		estimatedCost: request.estimatedCost,
		dataEgress: {
			destination: request.destination,
			dataClasses: request.dataClasses,
			fileRefs: [],
			recordRefs: [],
		},
		overwriteRisk: {
			paths: request.paths,
			destructive: request.destructive,
			recoverable: request.recoverable,
		},
		requestMessage: "Approve the Adapter HTTP intent",
		requestedAt: now,
		policySnapshotHash: request.policySnapshotHash,
		decision: "approved",
		scope: "project",
		scopeTarget: {
			projectId: request.projectId,
			sessionId: null,
			actionFingerprint: request.actionFingerprint,
			destinationPattern: request.destination,
			pathPatterns: request.paths,
			maxApprovedCost: request.estimatedCost,
		},
		decidedAt: now,
		decidedBy: "user",
		expiresAt: null,
		note: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: request.operationId,
			updatedByOperationId: request.operationId,
		},
	};
}

describe.skipIf(process.platform !== "darwin")("Scenario E: sandboxed third-party Adapter", () => {
	it("requires Host approval for HTTP and leaves core usable after denial or crash", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-research-scenario-e-"));
		try {
			const projectRoot = join(root, "project");
			const staging = join(root, "staging");
			const crashStaging = join(root, "crash-staging");
			const opened = await initializeProject(projectRoot, {
				title: "Public administration Adapter safety scenario",
				domain: "public-administration",
			});
			if (opened.compatibility !== "current") throw new Error("Expected current project");
			await Promise.all([mkdir(staging), mkdir(crashStaging)]);
			const conformance = await conformAdapterPackage(adapterRoot, "strong_isolation");
			expect(conformance.report).toMatchObject({ passed: true, adapterId: "community-http-source" });

			const policy = { ...opened.manifest.policy, defaultNetworkDecision: "ask" as const };
			let approval: ApprovalRecord | null = null;
			let observedRequest: ActionRequest | null = null;
			const invoke = async (cwd: string) =>
				runAdapterProcess({
					launch: {
						executable: process.execPath,
						args: [join(adapterRoot, "entry.mjs")],
						cwd,
						readRoots: [adapterRoot],
						isolation: "strong_isolation",
					},
					request: {
						protocol: "pi-research-adapter-jsonl",
						version: 1,
						messageId: createOpaqueId("operation"),
						type: "request",
						method: "search",
						payload: {
							queryText: "algorithmic transparency",
							filters: {},
							pageSize: 1,
							cursor: null,
							maxResults: 1,
							maxCost: null,
						},
					},
					broker: async (intent: AdapterProtocolBrokerRequest) => {
						const payload = intent.payload;
						if (
							payload === null ||
							typeof payload !== "object" ||
							Array.isArray(payload) ||
							typeof payload.url !== "string"
						) {
							throw new TypeError("Expected an HTTP URL intent");
						}
						const request = createActionRequest({
							projectId: opened.manifest.projectId,
							operationId: intent.requestId,
							sessionId: null,
							actionClass: "public_network_read",
							actionName: "adapter.http",
							destination: new URL(payload.url).origin,
							paths: ["sources/parsed"],
							dataClasses: ["public_metadata"],
							estimatedCost: null,
							destructive: false,
							recoverable: true,
							fingerprintParameters: { method: "GET", url: payload.url },
							policy,
						});
						observedRequest = request;
						const decision = evaluateActionPolicy(policy, request, approval === null ? [] : [approval]);
						return decision.decision === "allow"
							? {
									ok: true,
									value: { title: "Approved broker result", doi: "10.5555/scenario-e" },
									error: null,
								}
							: {
									ok: false,
									value: null,
									error: {
										code: "APPROVAL_REQUIRED",
										message: decision.reason,
										retryable: false,
										details: null,
									},
								};
					},
					timeoutMs: 5_000,
					maxOutputBytes: 1_048_576,
				});

			await expect(invoke(staging)).resolves.toMatchObject({
				ok: false,
				errors: [{ code: "APPROVAL_REQUIRED" }],
			});
			if (observedRequest === null) throw new Error("Expected a governed HTTP request");
			approval = projectApproval(observedRequest);
			await expect(invoke(staging)).resolves.toMatchObject({
				ok: true,
				value: { candidates: [{ title: "Approved broker result", doi: "10.5555/scenario-e" }] },
			});

			const crashed = await runAdapterProcess({
				launch: {
					executable: process.execPath,
					args: ["--input-type=module", "--eval", "process.exit(17)"],
					cwd: crashStaging,
					isolation: "strong_isolation",
				},
				request: {
					protocol: "pi-research-adapter-jsonl",
					version: 1,
					messageId: "crash-request",
					type: "request",
					method: "search",
					payload: null,
				},
				broker: async () => ({ ok: false, value: null, error: null }),
				timeoutMs: 5_000,
				maxOutputBytes: 1_048_576,
			});
			expect(crashed).toMatchObject({ ok: false, errors: [{ code: "ADAPTER_CRASH" }] });

			const sdk = await createResearchSdk([projectRoot]);
			await expect(
				sdk.invoke({
					protocol: "pi-research-rpc",
					version: 1,
					requestId: "validate-after-crash",
					method: "project.validate",
					params: { projectId: opened.manifest.projectId },
				}),
			).resolves.toMatchObject({ ok: true, value: { valid: true } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
