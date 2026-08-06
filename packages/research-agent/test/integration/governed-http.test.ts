import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecordedHttpTransport } from "../../src/adapters/http/transport.ts";
import type { ApprovalRecord, Money, OperationRecord, ResearchProjectManifest } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../../src/kernel/integrity.ts";
import { operationTransitionPatch } from "../../src/kernel/operations.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";
import { commitProjectTransaction } from "../../src/project/transactions.ts";
import { brokerProjectFile } from "../../src/security/broker-files.ts";
import { type HttpBrokerContext, type HttpRequestIntent, requestGovernedHttp } from "../../src/security/broker-http.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-http-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Governed HTTP" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function currentManifest(): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot);
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
		operationKind: "adapter",
		name: "source.fixture.search",
		implementationVersion: "0.1.0",
		status: "planned",
		session: null,
		actor: { type: "adapter", id: "source.fixture" },
		modelExecution: null,
		adapterExecution: {
			adapterId: "source.fixture",
			adapterVersion: "0.1.0",
			capabilitySnapshotHash: hashBytes("source.fixture:0.1.0"),
		},
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

async function createRunningOperation(): Promise<string> {
	const operationId = createOpaqueId("operation");
	let manifest = await currentManifest();
	const created = await createRecord(projectRoot, operationRecord(operationId), {
		expectedManifestRevision: manifest.revision,
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	manifest = await currentManifest();
	const result = await readRecord(projectRoot, "operation", operationId);
	if (!result.ok || result.value.kind !== "operation") throw new Error("expected operation");
	const updated = await updateRecord(projectRoot, "operation", operationId, {
		expectedManifestRevision: manifest.revision,
		expectedRecordRevision: result.value.audit.revision,
		operationId,
		changes: operationTransitionPatch(result.value, "running"),
	});
	if (!updated.ok) throw new Error(updated.errors[0].message);
	return operationId;
}

async function brokerContext(operationId: string): Promise<HttpBrokerContext> {
	const manifest = await currentManifest();
	return {
		operationId,
		sessionId: "session-fixture",
		policySnapshotHash: hashCanonicalJson(manifest.policy),
		signal: new AbortController().signal,
	};
}

function paidIntent(): HttpRequestIntent {
	return {
		method: "GET",
		url: "https://api.example.test/works?query=governance",
		headers: { accept: "application/json" },
		body: null,
		credential: {
			alias: "source-api",
			placement: { kind: "header", name: "authorization", prefix: "Bearer " },
		},
		dataClasses: ["public_query"],
		paid: true,
		estimatedCost: { amount: 0.02, currency: "USD" },
		costPerRequest: { amount: 0.01, currency: "USD" },
		maxAttempts: 2,
		idempotencyKey: "fixture:governance:page-1",
		responseBody: "text",
		maxResponseBytes: 1_024 * 1_024,
	};
}

function fingerprintFromApprovalRequired(details: unknown): string {
	if (
		details === null ||
		typeof details !== "object" ||
		Array.isArray(details) ||
		typeof (details as Record<string, unknown>).actionFingerprint !== "string"
	) {
		throw new Error("approval failure did not expose an action fingerprint");
	}
	return (details as Record<string, string>).actionFingerprint;
}

async function approvePaidIntent(operationId: string, actionFingerprint: string, cost: Money): Promise<string> {
	const manifest = await currentManifest();
	const now = new Date().toISOString();
	const approvalId = createOpaqueId("approval");
	const approval: ApprovalRecord = {
		kind: "approval",
		schemaVersion: "0.1.0",
		approvalId,
		taskId: null,
		operationId,
		actionClass: "paid_service_call",
		actionName: "http.request",
		impactScope: ["https://api.example.test"],
		estimatedCost: cost,
		dataEgress: {
			destination: "https://api.example.test",
			dataClasses: ["public_query"],
			fileRefs: [],
			recordRefs: [],
		},
		overwriteRisk: { paths: [], destructive: false, recoverable: true },
		requestMessage: "Approve recorded source fixture request",
		requestedAt: now,
		policySnapshotHash: hashCanonicalJson(manifest.policy),
		decision: "approved",
		scope: "once",
		scopeTarget: {
			projectId: manifest.projectId,
			sessionId: null,
			actionFingerprint,
			destinationPattern: "https://api.example.test",
			pathPatterns: [],
			maxApprovedCost: cost,
		},
		decidedAt: now,
		decidedBy: "user",
		expiresAt: null,
		note: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const result = await createRecord(projectRoot, approval, {
		expectedManifestRevision: manifest.revision,
		operationId,
	});
	if (!result.ok) throw new Error(result.errors[0].message);
	return approvalId;
}

async function setHardLimit(limit: Money, operationId: string): Promise<void> {
	const manifest = await currentManifest();
	await commitProjectTransaction(projectRoot, {
		expectedRevision: manifest.revision,
		writes: [],
		manifest: {
			...manifest,
			policy: { ...manifest.policy, budgetHardLimit: limit },
			lastCommittedOperationId: operationId,
			updatedAt: new Date().toISOString(),
			revision: manifest.revision + 1,
		},
	});
}

describe("governed HTTP broker", () => {
	it("approves paid egress, resolves credentials only for execution, retries 429, records cost, and enforces the hard limit", async () => {
		const operationId = await createRunningOperation();
		const intent = paidIntent();
		let credentialResolutions = 0;
		let transportCalls = 0;
		const blocked = await requestGovernedHttp(projectRoot, await brokerContext(operationId), intent, {
			transport: async () => {
				transportCalls += 1;
				throw new Error("transport must not run before approval");
			},
			resolveCredential: async () => {
				credentialResolutions += 1;
				return "credential-fixture-value";
			},
		});
		expect(blocked).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "APPROVAL_REQUIRED" }],
		});
		expect({ credentialResolutions, transportCalls }).toEqual({ credentialResolutions: 0, transportCalls: 0 });
		if (blocked.ok) throw new Error("expected approval failure");
		const approvalId = await approvePaidIntent(
			operationId,
			fingerprintFromApprovalRequired(blocked.errors[0].details),
			intent.estimatedCost ?? { amount: 0, currency: "USD" },
		);

		const replay = createRecordedHttpTransport([
			{
				request: { method: "GET", url: intent.url, body: null },
				response: {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "1" },
					body: '{"message":"rate limited"}',
				},
			},
			{
				request: { method: "GET", url: intent.url, body: null },
				response: {
					status: 200,
					headers: { "content-type": "application/json", "x-private-header": "not-recorded" },
					body: '{"items":[{"title":"Governance"}]}',
				},
			},
		]);
		const waits: number[] = [];
		const result = await requestGovernedHttp(projectRoot, await brokerContext(operationId), intent, {
			transport: async (request) => {
				transportCalls += 1;
				expect(request.headers.authorization).toBe("Bearer credential-fixture-value");
				return replay(request);
			},
			resolveCredential: async (alias) => {
				credentialResolutions += 1;
				expect(alias).toBe("source-api");
				return "credential-fixture-value";
			},
			wait: async (milliseconds) => {
				waits.push(milliseconds);
			},
			random: () => 0,
		});
		expect(result).toMatchObject({
			ok: true,
			value: {
				statusCode: 200,
				attempts: 2,
				networkRequests: 2,
				actualCost: { amount: 0.02, currency: "USD" },
				approvalId,
				headers: { "content-type": "application/json" },
			},
		});
		expect({ credentialResolutions, transportCalls, waits }).toEqual({
			credentialResolutions: 1,
			transportCalls: 2,
			waits: [1_000],
		});
		if (!result.ok) throw new Error(result.errors[0].message);

		const operation = await readRecord(projectRoot, "operation", operationId);
		if (!operation.ok || operation.value.kind !== "operation") throw new Error("expected operation");
		expect(operation.value).toMatchObject({
			approvalIds: [approvalId],
			rawRequest: result.value.requestFile,
			rawResponse: result.value.responseFile,
			usage: { networkRequests: 2, cost: { amount: 0.02, currency: "USD" } },
		});
		const requestReceipt = await readFile(join(projectRoot, ...result.value.requestFile.path.split("/")), "utf8");
		const responseReceipt = await readFile(join(projectRoot, ...result.value.responseFile.path.split("/")), "utf8");
		expect(requestReceipt).toContain('"alias":"source-api"');
		expect(responseReceipt).toContain("rate limited");
		expect(responseReceipt).toContain("Governance");
		expect(`${requestReceipt}${responseReceipt}${JSON.stringify(operation.value)}`).not.toContain(
			"credential-fixture-value",
		);

		const forged = await brokerProjectFile(projectRoot, {
			operationId,
			sessionId: "session-fixture",
			expectedManifestRevision: (await currentManifest()).revision,
			path: `.research/runs/${operationId}/forged.json`,
			content: "{}",
			dataClasses: [],
		});
		expect(forged).toMatchObject({ ok: false, errors: [{ code: "PROTECTED_PROJECT_PATH" }] });

		await setHardLimit({ amount: 0.02, currency: "USD" }, operationId);
		const nextOperationId = await createRunningOperation();
		let budgetTransportCalls = 0;
		const budgetBlocked = await requestGovernedHttp(
			projectRoot,
			await brokerContext(nextOperationId),
			{
				...intent,
				credential: null,
				estimatedCost: { amount: 0.01, currency: "USD" },
				costPerRequest: { amount: 0.01, currency: "USD" },
				maxAttempts: 1,
				idempotencyKey: "fixture:budget-block",
			},
			{
				transport: async () => {
					budgetTransportCalls += 1;
					throw new Error("budget must block transport");
				},
			},
		);
		expect(budgetBlocked).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "BUDGET_LIMIT" }],
		});
		expect(budgetTransportCalls).toBe(0);
	});

	it("does not retry permanent HTTP statuses and rejects raw credential headers", async () => {
		const operationId = await createRunningOperation();
		let transportCalls = 0;
		const intent: HttpRequestIntent = {
			method: "GET",
			url: "https://api.example.test/works/missing",
			headers: { accept: "application/json" },
			body: null,
			credential: null,
			dataClasses: ["public_identifier"],
			paid: false,
			estimatedCost: null,
			costPerRequest: { amount: 0, currency: "USD" },
			maxAttempts: 3,
			idempotencyKey: "fixture:not-found",
			responseBody: "text",
			maxResponseBytes: 1_024 * 1_024,
		};
		const result = await requestGovernedHttp(projectRoot, await brokerContext(operationId), intent, {
			transport: async () => {
				transportCalls += 1;
				return {
					status: 404,
					headers: { "content-type": "application/json" },
					body: '{"status":404}',
					bodyBytes: Buffer.byteLength('{"status":404}'),
				};
			},
			wait: async () => {
				throw new Error("404 must not back off");
			},
		});
		expect(result).toMatchObject({
			ok: false,
			status: "PERMANENT_FAILURE",
			errors: [{ code: "HTTP_NOT_FOUND", retryable: false }],
		});
		expect(transportCalls).toBe(1);
		const operation = await readRecord(projectRoot, "operation", operationId);
		if (!operation.ok || operation.value.kind !== "operation") throw new Error("expected operation");
		expect(operation.value.usage.networkRequests).toBe(1);
		expect(operation.value.rawResponse).not.toBeNull();

		const rawCredentialOperationId = await createRunningOperation();
		let unsafeTransportCalls = 0;
		const rejected = await requestGovernedHttp(
			projectRoot,
			await brokerContext(rawCredentialOperationId),
			{ ...intent, headers: { authorization: "Bearer raw-secret" }, idempotencyKey: "fixture:raw-secret" },
			{
				transport: async () => {
					unsafeTransportCalls += 1;
					throw new Error("unsafe request must not execute");
				},
			},
		);
		expect(rejected).toMatchObject({ ok: false, errors: [{ code: "HTTP_REQUEST_INVALID" }] });
		expect(unsafeTransportCalls).toBe(0);
		const untouched = await readRecord(projectRoot, "operation", rawCredentialOperationId);
		if (!untouched.ok || untouched.value.kind !== "operation") throw new Error("expected operation");
		expect(untouched.value).toMatchObject({ rawRequest: null, rawResponse: null, usage: { networkRequests: 0 } });

		const sensitiveOperationId = await createRunningOperation();
		let sensitiveTransportCalls = 0;
		const sensitive = await requestGovernedHttp(
			projectRoot,
			await brokerContext(sensitiveOperationId),
			{ ...intent, dataClasses: ["interview_transcript"], idempotencyKey: "fixture:sensitive" },
			{
				transport: async () => {
					sensitiveTransportCalls += 1;
					throw new Error("sensitive egress must not execute before approval");
				},
			},
		);
		expect(sensitive).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "APPROVAL_REQUIRED", details: { actionClass: "sensitive_egress" } }],
		});
		expect(sensitiveTransportCalls).toBe(0);

		const writeOperationId = await createRunningOperation();
		let writeTransportCalls = 0;
		const write = await requestGovernedHttp(
			projectRoot,
			await brokerContext(writeOperationId),
			{
				...intent,
				method: "POST",
				body: '{"title":"Public metadata"}',
				idempotencyKey: "fixture:external-write",
			},
			{
				transport: async () => {
					writeTransportCalls += 1;
					throw new Error("external write must not execute before approval");
				},
			},
		);
		expect(write).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "APPROVAL_REQUIRED", details: { actionClass: "external_write" } }],
		});
		expect(writeTransportCalls).toBe(0);
	});
});
