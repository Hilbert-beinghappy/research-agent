import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalRecord, Money, OperationRecord, ResearchProjectManifest } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes } from "../../src/kernel/integrity.ts";
import { operationTransitionPatch } from "../../src/kernel/operations.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";
import { approvalCoversRequest } from "../../src/security/approval.ts";
import { brokerProjectFile } from "../../src/security/broker-files.ts";
import { type ActionRequest, createActionRequest, evaluateActionPolicy } from "../../src/security/policy.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-policy-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Policy and file broker" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function currentManifest(expectedRevision?: number): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot, expectedRevision);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	return opened.manifest;
}

function operationRecord(operationId: string): OperationRecord {
	const now = new Date().toISOString();
	return {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId,
		taskId: null,
		operationKind: "tool",
		name: "project.file",
		implementationVersion: "0.1.0",
		status: "planned",
		session: null,
		actor: { type: "tool", id: "file-broker-test" },
		modelExecution: null,
		adapterExecution: null,
		inputs: [],
		inputFiles: [],
		outputs: [],
		outputFiles: [],
		rawRequest: null,
		rawResponse: null,
		approvalIds: [],
		usage: {
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			networkRequests: 0,
			cost: { amount: 0, currency: "USD" },
		},
		error: null,
		startedAt: null,
		finishedAt: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

function approvalRecord(
	request: ActionRequest,
	options: {
		scope: ApprovalRecord["scope"];
		decision?: ApprovalRecord["decision"];
		pathPatterns?: string[];
		maxCost?: Money | null;
		sessionId?: string | null;
	},
): ApprovalRecord {
	const now = new Date().toISOString();
	const approvalId = createOpaqueId("approval");
	return {
		kind: "approval",
		schemaVersion: "0.1.0",
		approvalId,
		taskId: null,
		operationId: options.scope === "permanent_deny" ? null : request.operationId,
		actionClass: request.actionClass,
		actionName: request.actionName,
		impactScope: [...request.paths],
		estimatedCost: request.estimatedCost,
		dataEgress: {
			destination: request.destination,
			dataClasses: [...request.dataClasses],
			fileRefs: [],
			recordRefs: [],
		},
		overwriteRisk: {
			paths: [...request.paths],
			destructive: request.destructive,
			recoverable: request.recoverable,
		},
		requestMessage: "Approve test action",
		requestedAt: now,
		policySnapshotHash: request.policySnapshotHash,
		decision: options.decision ?? "approved",
		scope: options.scope,
		scopeTarget: {
			projectId: request.projectId,
			sessionId: options.sessionId ?? null,
			actionFingerprint: request.actionFingerprint,
			destinationPattern: request.destination,
			pathPatterns: options.pathPatterns ?? [...request.paths],
			maxApprovedCost: options.maxCost ?? request.estimatedCost,
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

describe("policy, approvals, and file broker", () => {
	it("matches once, session, and project approvals without allowing scope expansion", async () => {
		const manifest = await currentManifest(0);
		const operationId = createOpaqueId("operation");
		const request = createActionRequest({
			projectId: manifest.projectId,
			operationId,
			sessionId: "session-1",
			actionClass: "project_overwrite",
			actionName: "project.file.write",
			destination: null,
			paths: ["artifacts/reviews/review.md"],
			dataClasses: ["public"],
			estimatedCost: { amount: 1, currency: "USD" },
			destructive: false,
			recoverable: true,
			fingerprintParameters: { contentHash: "test" },
			policy: manifest.policy,
		});

		const once = approvalRecord(request, { scope: "once" });
		expect(approvalCoversRequest(once, request)).toBe(true);
		expect(approvalCoversRequest(once, { ...request, operationId: createOpaqueId("operation") })).toBe(false);

		const session = approvalRecord(request, {
			scope: "session",
			sessionId: "session-1",
			pathPatterns: ["artifacts/reviews/**"],
			maxCost: { amount: 2, currency: "USD" },
		});
		expect(approvalCoversRequest(session, request)).toBe(true);
		expect(approvalCoversRequest(session, { ...request, sessionId: "session-2" })).toBe(false);

		const project = approvalRecord(request, {
			scope: "project",
			pathPatterns: ["artifacts/**"],
			maxCost: { amount: 2, currency: "USD" },
		});
		expect(approvalCoversRequest(project, request)).toBe(true);
		expect(approvalCoversRequest(project, { ...request, paths: ["notes/private.md"] })).toBe(false);
		expect(approvalCoversRequest(project, { ...request, estimatedCost: { amount: 3, currency: "USD" } })).toBe(false);
		expect(approvalCoversRequest(project, { ...request, destination: "external.example" })).toBe(false);
		expect(approvalCoversRequest(project, { ...request, dataClasses: ["public", "confidential"] })).toBe(false);

		const deny = approvalRecord(request, {
			scope: "permanent_deny",
			decision: "denied",
			pathPatterns: ["artifacts/**"],
			maxCost: { amount: 2, currency: "USD" },
		});
		expect(evaluateActionPolicy(manifest.policy, request, [project, deny])).toMatchObject({ decision: "deny" });
		expect(
			evaluateActionPolicy(
				manifest.policy,
				{ ...request, estimatedCost: { amount: 3, currency: "USD" }, dataClasses: ["public", "confidential"] },
				[project, deny],
			),
		).toMatchObject({ decision: "deny" });
	});

	it("auto-creates, requires approval to overwrite/delete, and blocks protected paths", async () => {
		const operationId = createOpaqueId("operation");
		await createRecord(projectRoot, operationRecord(operationId), { expectedManifestRevision: 0, operationId });
		const operationResult = await readRecord(projectRoot, "operation", operationId);
		if (!operationResult.ok || operationResult.value.kind !== "operation") throw new Error("expected operation");
		await updateRecord(projectRoot, "operation", operationId, {
			expectedManifestRevision: 1,
			expectedRecordRevision: 0,
			operationId,
			changes: operationTransitionPatch(operationResult.value, "running"),
		});

		const path = "artifacts/reviews/review.md";
		await expect(
			brokerProjectFile(projectRoot, {
				operationId,
				sessionId: "session-1",
				expectedManifestRevision: 2,
				path,
				content: "v1",
				dataClasses: [],
			}),
		).resolves.toMatchObject({ ok: true, value: { path, deleted: false, approvalId: null } });
		await expect(readFile(join(projectRoot, ...path.split("/")), "utf8")).resolves.toBe("v1");
		await expect(
			brokerProjectFile(projectRoot, {
				operationId,
				sessionId: "session-1",
				expectedManifestRevision: 3,
				path,
				content: "v1",
				dataClasses: [],
			}),
		).resolves.toMatchObject({ ok: true, value: { path, deleted: false, approvalId: null } });
		await expect(currentManifest(3)).resolves.toMatchObject({ revision: 3 });

		await expect(
			brokerProjectFile(projectRoot, {
				operationId,
				sessionId: "session-1",
				expectedManifestRevision: 3,
				path,
				content: "v2",
				dataClasses: [],
			}),
		).resolves.toMatchObject({ ok: false, status: "PERMISSION_BLOCKED", errors: [{ code: "APPROVAL_REQUIRED" }] });
		await expect(readFile(join(projectRoot, ...path.split("/")), "utf8")).resolves.toBe("v1");

		let manifest = await currentManifest(3);
		const overwriteRequest = createActionRequest({
			projectId: manifest.projectId,
			operationId,
			sessionId: "session-1",
			actionClass: "project_overwrite",
			actionName: "project.file.write",
			destination: null,
			paths: [path],
			dataClasses: [],
			estimatedCost: null,
			destructive: false,
			recoverable: true,
			fingerprintParameters: { contentHash: hashBytes("v2") },
			policy: manifest.policy,
		});
		const overwriteApproval = approvalRecord(overwriteRequest, { scope: "once" });
		await createRecord(projectRoot, overwriteApproval, { expectedManifestRevision: 3, operationId });
		await expect(
			brokerProjectFile(projectRoot, {
				operationId,
				sessionId: "session-1",
				expectedManifestRevision: 4,
				path,
				content: "v2",
				dataClasses: [],
			}),
		).resolves.toMatchObject({ ok: true, value: { approvalId: overwriteApproval.approvalId } });
		await expect(readFile(join(projectRoot, ...path.split("/")), "utf8")).resolves.toBe("v2");
		const linkedOperation = await readRecord(projectRoot, "operation", operationId);
		if (!linkedOperation.ok || linkedOperation.value.kind !== "operation") throw new Error("expected operation");
		expect(linkedOperation.value.approvalIds).toContain(overwriteApproval.approvalId);
		await expect(
			brokerProjectFile(projectRoot, {
				operationId,
				sessionId: "session-1",
				expectedManifestRevision: 6,
				path,
				content: "v3",
				dataClasses: [],
			}),
		).resolves.toMatchObject({ ok: false, errors: [{ code: "APPROVAL_REQUIRED" }] });
		await expect(readFile(join(projectRoot, ...path.split("/")), "utf8")).resolves.toBe("v2");

		manifest = await currentManifest(6);
		const deleteRequest = createActionRequest({
			projectId: manifest.projectId,
			operationId,
			sessionId: "session-1",
			actionClass: "destructive_file_action",
			actionName: "project.file.delete",
			destination: null,
			paths: [path],
			dataClasses: [],
			estimatedCost: null,
			destructive: true,
			recoverable: true,
			fingerprintParameters: { contentHash: null },
			policy: manifest.policy,
		});
		const deleteApproval = approvalRecord(deleteRequest, { scope: "once" });
		await createRecord(projectRoot, deleteApproval, { expectedManifestRevision: 6, operationId });
		await expect(
			brokerProjectFile(projectRoot, {
				operationId,
				sessionId: "session-1",
				expectedManifestRevision: 7,
				path,
				content: null,
				dataClasses: [],
			}),
		).resolves.toMatchObject({ ok: true, value: { deleted: true, approvalId: deleteApproval.approvalId } });
		await expect(access(join(projectRoot, ...path.split("/")))).rejects.toThrow();

		await expect(
			brokerProjectFile(projectRoot, {
				operationId,
				sessionId: "session-1",
				expectedManifestRevision: 9,
				path: ".research/records/claims/injected.json",
				content: "{}",
				dataClasses: [],
			}),
		).resolves.toMatchObject({ ok: false, errors: [{ code: "PROTECTED_PROJECT_PATH" }] });
		await expect(currentManifest(9)).resolves.toMatchObject({ revision: 9 });
	});
});
