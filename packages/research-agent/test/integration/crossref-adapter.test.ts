import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecordedHttpTransport, type HttpTransport } from "../../src/adapters/http/transport.ts";
import type { AdapterContext, SourceSearchRequest } from "../../src/adapters/source/contract.ts";
import { CrossrefAdapter } from "../../src/adapters/source/crossref.ts";
import type { OperationRecord, ResearchProjectManifest } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashCanonicalJson } from "../../src/kernel/integrity.ts";
import { operationTransitionPatch } from "../../src/kernel/operations.ts";
import { failureResult } from "../../src/kernel/results.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";
import { requestGovernedHttp } from "../../src/security/broker-http.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "fixtures", "crossref");

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-crossref-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Crossref adapter fixture" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function fixture(name: string): Promise<string> {
	return readFile(join(fixtureDirectory, name), "utf8");
}

async function currentManifest(): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	return opened.manifest;
}

async function operationRecord(adapter: CrossrefAdapter, operationId: string): Promise<OperationRecord> {
	const now = new Date().toISOString();
	return {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId,
		taskId: null,
		operationKind: "adapter",
		name: "crossref.request",
		implementationVersion: "0.1.0",
		status: "planned",
		session: null,
		actor: { type: "adapter", id: "crossref" },
		modelExecution: null,
		adapterExecution: {
			adapterId: "crossref",
			adapterVersion: "0.1.0",
			capabilitySnapshotHash: hashCanonicalJson(await adapter.capabilities()),
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

async function adapterContext(
	adapter: CrossrefAdapter,
	transport: HttpTransport,
	waits: number[] = [],
): Promise<AdapterContext> {
	const operationId = createOpaqueId("operation");
	let manifest = await currentManifest();
	const created = await createRecord(projectRoot, await operationRecord(adapter, operationId), {
		expectedManifestRevision: manifest.revision,
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	manifest = await currentManifest();
	const operation = await readRecord(projectRoot, "operation", operationId);
	if (!operation.ok || operation.value.kind !== "operation") throw new Error("expected Crossref operation");
	const updated = await updateRecord(projectRoot, "operation", operationId, {
		expectedManifestRevision: manifest.revision,
		expectedRecordRevision: 0,
		operationId,
		changes: operationTransitionPatch(operation.value, "running"),
	});
	if (!updated.ok) throw new Error(updated.errors[0].message);
	manifest = await currentManifest();
	const taskId = createOpaqueId("task");
	const signal = new AbortController().signal;
	const context: AdapterContext = {
		projectId: manifest.projectId,
		taskId,
		operationId,
		policySnapshotHash: hashCanonicalJson(manifest.policy),
		signal,
		brokers: {
			requestHttp: (request) =>
				requestGovernedHttp(
					projectRoot,
					{
						operationId,
						sessionId: "crossref-fixture-session",
						policySnapshotHash: context.policySnapshotHash,
						signal,
					},
					request,
					{
						transport: async (transportRequest) => {
							expect(transportRequest.headers.accept).toBe("application/vnd.crossref-api-message+json");
							expect(transportRequest.headers["user-agent"]).toBe("pi-research-agent/0.1.0");
							return transport(transportRequest);
						},
						wait: async (milliseconds) => {
							waits.push(milliseconds);
						},
						random: () => 0,
					},
				),
		},
	};
	return context;
}

function searchRequest(overrides: Partial<SourceSearchRequest> = {}): SourceSearchRequest {
	return {
		queryText: "algorithmic governance",
		filters: { fromYear: 2020, toYear: 2024, types: ["journal-article"] },
		pageSize: 2,
		cursor: null,
		maxResults: 4,
		maxCost: { amount: 0, currency: "USD" },
		...overrides,
	};
}

function searchUrl(query: string, rows: number, cursor: string, filter?: string): string {
	const url = new URL("https://api.crossref.org/v1/works");
	url.searchParams.set("query.bibliographic", query);
	url.searchParams.set("rows", rows.toString());
	url.searchParams.set("cursor", cursor);
	if (filter !== undefined) url.searchParams.set("filter", filter);
	return url.toString();
}

function doiIdentifier(doi: string) {
	return {
		scheme: "doi" as const,
		value: `https://doi.org/${doi}`,
		normalizedValue: doi,
		verified: false,
		verificationId: null,
	};
}

describe("Crossref SourceAdapter", () => {
	it("replays search pagination, 429 backoff, and outgoing update relations without committing SourceRecords", async () => {
		const adapter = new CrossrefAdapter();
		await expect(adapter.capabilities()).resolves.toMatchObject({
			adapterId: "crossref",
			capabilities: ["health", "search", "lookup", "publication-status-relations"],
			supportsPagination: true,
			requiresCredentials: false,
			limits: { maxPageSize: 1000, cursorExpiresMinutes: 5, publicConcurrency: 1 },
		});
		const filter = "from-pub-date:2020-01-01,until-pub-date:2024-12-31,type:journal-article";
		const firstUrl = searchUrl("algorithmic governance", 2, "*", filter);
		const waits: number[] = [];
		const firstContext = await adapterContext(
			adapter,
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: firstUrl, body: null },
					response: { status: 429, headers: { "retry-after": "0" }, body: '{"message":"slow down"}' },
				},
				{
					request: { method: "GET", url: firstUrl, body: null },
					response: {
						status: 200,
						headers: { "content-type": "application/json" },
						body: await fixture("search-page-1.json"),
					},
				},
			]),
			waits,
		);
		const first = await adapter.search(searchRequest(), firstContext);
		expect(first).toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				candidates: [
					{ doi: "10.5555/governance.1", issuedDate: "2023-05-02", updates: [] },
					{
						doi: "10.5555/governance.2.correction",
						updates: [{ type: "correction", targetDoi: "10.5555/governance.2", updatedDate: "2024-01-12" }],
					},
				],
				nextCursor: { adapterId: "crossref", token: "cursor-page-2", returned: 2 },
				exhausted: false,
				actualCost: { amount: 0, currency: "USD" },
			},
		});
		expect(waits).toEqual([500]);
		if (!first.ok) throw new Error(first.errors[0].message);

		const secondUrl = searchUrl("algorithmic governance", 2, "cursor-page-2", filter);
		const secondContext = await adapterContext(
			adapter,
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: secondUrl, body: null },
					response: { status: 200, body: await fixture("search-page-2.json") },
				},
			]),
		);
		const second = await adapter.search(searchRequest({ cursor: first.value.nextCursor }), secondContext);
		expect(second).toMatchObject({
			ok: true,
			value: {
				candidates: [{ doi: "10.5555/governance.3", issuedDate: "2021-11" }],
				nextCursor: null,
				exhausted: true,
			},
		});
		await expect(
			adapter.search(
				searchRequest({
					cursor: {
						adapterId: "crossref",
						token: "expired-cursor",
						returned: 2,
						expiresAt: "2000-01-01T00:00:00.000Z",
					},
				}),
				secondContext,
			),
		).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "CROSSREF_REQUEST_INVALID", message: "Crossref cursor has expired; restart the search" }],
		});
		const manifest = await currentManifest();
		expect(manifest.recordSets.find(({ kind }) => kind === "source")).toMatchObject({ count: 0, contentHash: null });
		const operation = await readRecord(projectRoot, "operation", firstContext.operationId);
		if (!operation.ok || operation.value.kind !== "operation") throw new Error("expected Crossref operation");
		expect(operation.value).toMatchObject({
			rawRequest: { path: expect.stringContaining(firstContext.operationId) },
			rawResponse: { path: expect.stringContaining(firstContext.operationId) },
			usage: { networkRequests: 2, cost: { amount: 0, currency: "USD" } },
		});
	});

	it("maps notice-to-work status relations and rejects a conflicting DOI response", async () => {
		const adapter = new CrossrefAdapter();
		const lookupBody = await fixture("lookup-retracted.json");
		const lookupUrl = "https://api.crossref.org/v1/works/10.5555%2Fgovernance.3.retraction";
		const context = await adapterContext(
			adapter,
			createRecordedHttpTransport([
				{ request: { method: "GET", url: lookupUrl, body: null }, response: { status: 200, body: lookupBody } },
			]),
		);
		const result = await adapter.lookup(doiIdentifier("10.5555/governance.3.retraction"), context);
		expect(result).toMatchObject({
			ok: true,
			value: {
				candidate: {
					doi: "10.5555/governance.3.retraction",
					updates: [{ type: "retraction", targetDoi: "10.5555/governance.3", updatedDate: "2024-03-08" }],
				},
				rawResponse: { path: expect.stringContaining(context.operationId) },
			},
		});

		const statusUrl = new URL("https://api.crossref.org/v1/works");
		statusUrl.searchParams.set("filter", "updates:10.5555/governance.3");
		statusUrl.searchParams.set("rows", "1000");
		const statusContext = await adapterContext(
			adapter,
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: statusUrl.toString(), body: null },
					response: { status: 200, body: await fixture("status-retracted.json") },
				},
			]),
		);
		await expect(
			adapter.statusRelations(doiIdentifier("10.5555/governance.3"), statusContext),
		).resolves.toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				doi: "10.5555/governance.3",
				publicationStatus: "retracted",
				complete: true,
				statusRelations: [
					{
						type: "retraction",
						targetDoi: "10.5555/governance.3",
						noticeDoi: "10.5555/governance.3.retraction",
					},
				],
				rawResponse: { path: expect.stringContaining(statusContext.operationId) },
			},
		});

		const conflictUrl = "https://api.crossref.org/v1/works/10.5555%2Fdifferent";
		const conflictContext = await adapterContext(
			adapter,
			createRecordedHttpTransport([
				{ request: { method: "GET", url: conflictUrl, body: null }, response: { status: 200, body: lookupBody } },
			]),
		);
		await expect(adapter.lookup(doiIdentifier("10.5555/different"), conflictContext)).resolves.toMatchObject({
			ok: false,
			status: "DATA_CONFLICT",
			errors: [{ code: "CROSSREF_DOI_CONFLICT", category: "data_conflict" }],
		});
	});

	it("keeps valid candidates on malformed items and propagates exhausted 5xx failures", async () => {
		const adapter = new CrossrefAdapter();
		const partialUrl = searchUrl("partial fixture", 2, "*");
		const partialContext = await adapterContext(
			adapter,
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: partialUrl, body: null },
					response: { status: 200, body: await fixture("search-partial.json") },
				},
			]),
		);
		await expect(
			adapter.search(searchRequest({ queryText: "partial fixture", filters: null }), partialContext),
		).resolves.toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: { candidates: [{ doi: "10.5555/governance.valid" }] },
			errors: [{ code: "CROSSREF_ITEM_INVALID", details: { itemIndex: 1 } }],
		});

		const downUrl = searchUrl("service down", 1, "*");
		const downContext = await adapterContext(
			adapter,
			createRecordedHttpTransport(
				[1, 2, 3].map(() => ({
					request: { method: "GET" as const, url: downUrl, body: null },
					response: { status: 503, body: '{"message":"temporarily unavailable"}' },
				})),
			),
		);
		await expect(
			adapter.search(
				searchRequest({ queryText: "service down", filters: null, pageSize: 1, maxResults: 1 }),
				downContext,
			),
		).resolves.toMatchObject({
			ok: false,
			status: "RETRYABLE_FAILURE",
			errors: [{ code: "HTTP_RETRYABLE_STATUS", retryable: true, taskId: downContext.taskId }],
		});
		const operation = await readRecord(projectRoot, "operation", downContext.operationId);
		if (!operation.ok || operation.value.kind !== "operation") throw new Error("expected Crossref operation");
		expect(operation.value.usage.networkRequests).toBe(3);
	});

	it("uses a credential alias for polite-pool identity without embedding an email", async () => {
		const adapter = new CrossrefAdapter("crossref-mailto");
		let capturedRequest: Parameters<AdapterContext["brokers"]["requestHttp"]>[0] | null = null;
		let capturedUrl = "";
		const context: AdapterContext = {
			projectId: createOpaqueId("project"),
			taskId: createOpaqueId("task"),
			operationId: createOpaqueId("operation"),
			policySnapshotHash: hashCanonicalJson({}),
			signal: new AbortController().signal,
			brokers: {
				requestHttp: async (request) => {
					capturedRequest = request;
					capturedUrl = request.url;
					return failureResult(
						"EXTERNAL_SERVICE_FAILURE",
						"FIXTURE_STOP",
						"external_service",
						"Stop after request construction",
						context.operationId,
					);
				},
			},
		};
		await adapter.healthCheck(context);
		expect(capturedRequest).toMatchObject({
			url: "https://api.crossref.org/v1/works?rows=0",
			credential: { alias: "crossref-mailto", placement: { kind: "query", name: "mailto", prefix: "" } },
		});
		expect(capturedUrl).not.toContain("mailto=");
	});
});
