import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecordedHttpTransport, type HttpTransport } from "../../src/adapters/http/transport.ts";
import type { AdapterContext, SourceSearchRequest } from "../../src/adapters/source/contract.ts";
import { OpenAlexAdapter } from "../../src/adapters/source/openalex.ts";
import type { FileRef } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../../src/kernel/integrity.ts";
import { successResult } from "../../src/kernel/results.ts";
import type { HttpReceipt, HttpRequestIntent } from "../../src/security/broker-http.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "fixtures", "openalex");
const selectedFields = [
	"id",
	"doi",
	"title",
	"publication_year",
	"publication_date",
	"type",
	"language",
	"cited_by_count",
	"is_retracted",
	"authorships",
	"ids",
	"primary_location",
	"open_access",
	"primary_topic",
	"relevance_score",
].join(",");

async function fixture(name: string): Promise<string> {
	return readFile(join(fixtureDirectory, name), "utf8");
}

function fileRef(path: string, body: string): FileRef {
	return {
		path,
		hash: hashBytes(body),
		mediaType: "application/json",
		bytes: Buffer.byteLength(body),
	};
}

function fixtureContext(transport: HttpTransport): {
	context: AdapterContext;
	intents: HttpRequestIntent[];
} {
	const operationId = createOpaqueId("operation");
	const intents: HttpRequestIntent[] = [];
	const signal = new AbortController().signal;
	let requestNumber = 0;
	const context: AdapterContext = {
		projectId: createOpaqueId("project"),
		taskId: createOpaqueId("task"),
		operationId,
		policySnapshotHash: hashCanonicalJson({}),
		signal,
		brokers: {
			requestHttp: async (intent) => {
				intents.push(intent);
				requestNumber += 1;
				const response = await transport({
					method: intent.method,
					url: intent.url,
					headers: intent.headers,
					body: intent.body,
					responseBody: intent.responseBody,
					maxResponseBytes: intent.maxResponseBytes,
					signal,
				});
				if (response.status < 200 || response.status >= 300)
					throw new Error(`unexpected fixture status ${response.status}`);
				return successResult<HttpReceipt>(
					{
						requestFile: fileRef(`.research/runs/${operationId}/request-${requestNumber}.json`, intent.url),
						responseFile: fileRef(`.research/runs/${operationId}/response-${requestNumber}.json`, response.body),
						statusCode: response.status,
						headers: response.headers,
						body: response.body,
						bodyEncoding: intent.responseBody,
						bodyBytes: response.bodyBytes,
						attempts: 1,
						networkRequests: 1,
						actualCost: intent.costPerRequest,
						approvalId: intent.paid ? createOpaqueId("approval") : null,
					},
					operationId,
				);
			},
		},
	};
	return { context, intents };
}

function searchRequest(overrides: Partial<SourceSearchRequest> = {}): SourceSearchRequest {
	return {
		queryText: "algorithmic governance",
		filters: { fromYear: 2020, toYear: 2024, types: ["article", "book-chapter"] },
		pageSize: 2,
		cursor: null,
		maxResults: 4,
		maxCost: { amount: 0.004, currency: "USD" },
		...overrides,
	};
}

function searchUrl(cursor: string): string {
	const url = new URL("https://api.openalex.org/works");
	url.searchParams.set("search", "algorithmic governance");
	url.searchParams.set("per_page", "2");
	url.searchParams.set("cursor", cursor);
	url.searchParams.set(
		"filter",
		"from_publication_date:2020-01-01,to_publication_date:2024-12-31,type:article|book-chapter",
	);
	url.searchParams.set("select", selectedFields);
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

describe("OpenAlex SourceAdapter", () => {
	it("reports an explicit Crossref/local degradation when no API key alias is configured", async () => {
		const adapter = new OpenAlexAdapter();
		const { context, intents } = fixtureContext(async () => {
			throw new Error("degraded OpenAlex must not reach transport");
		});
		await expect(adapter.capabilities()).resolves.toMatchObject({
			adapterId: "openalex",
			requiresCredentials: true,
			mayCostMoney: true,
			limits: { status: "degraded", degradedTo: ["crossref", "local"] },
		});
		await expect(adapter.healthCheck(context)).resolves.toMatchObject({
			ok: true,
			value: { status: "degraded", reason: "OPENALEX_API_KEY_REQUIRED" },
		});
		await expect(adapter.search(searchRequest(), context)).resolves.toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "OPENALEX_API_KEY_REQUIRED", details: { degradedTo: ["crossref", "local"] } }],
		});
		await expect(adapter.lookup(doiIdentifier("10.5555/governance.1"), context)).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "OPENALEX_API_KEY_REQUIRED" }],
		});
		expect(intents).toHaveLength(0);
	});

	it("checks the live pricing shape through an API-key alias and detects snapshot drift", async () => {
		const adapter = new OpenAlexAdapter("openalex-api-key");
		const rateLimitBody = await fixture("rate-limit.json");
		const { context, intents } = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: "https://api.openalex.org/rate-limit", body: null },
					response: { status: 200, body: rateLimitBody },
				},
			]),
		);
		const health = await adapter.healthCheck(context);
		expect(health).toMatchObject({
			ok: true,
			value: {
				status: "ok",
				reason: null,
				rateLimit: { dailyRemainingUsd: 0.96, endpointCostsUsd: { search: 0.001, singleton: 0 } },
				actualCost: { amount: 0, currency: "USD" },
			},
		});
		expect(JSON.stringify(health)).not.toContain("masked-fixture");
		expect(intents[0]).toMatchObject({
			url: "https://api.openalex.org/rate-limit",
			credential: { alias: "openalex-api-key", placement: { kind: "query", name: "api_key", prefix: "" } },
			paid: false,
		});
		expect(intents[0].url).not.toContain("api_key");

		const drift = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: "https://api.openalex.org/rate-limit", body: null },
					response: { status: 200, body: await fixture("rate-limit-price-drift.json") },
				},
			]),
		);
		await expect(adapter.healthCheck(drift.context)).resolves.toMatchObject({
			ok: true,
			value: { status: "degraded", reason: "OPENALEX_PRICING_CHANGED" },
		});
	});

	it("replays metered cursor pagination and keeps false retraction flags unknown", async () => {
		const adapter = new OpenAlexAdapter("openalex-api-key");
		const first = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: searchUrl("*"), body: null },
					response: { status: 200, body: await fixture("search-page-1.json") },
				},
			]),
		);
		const firstPage = await adapter.search(searchRequest(), first.context);
		expect(firstPage).toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				candidates: [
					{
						openalexId: "W1001",
						doi: "10.5555/governance.1",
						retractedFlag: false,
						publicationStatus: "unknown",
						primaryTopic: { name: "Public Administration" },
					},
					{
						openalexId: "W1002",
						retractedFlag: true,
						publicationStatus: "retracted",
					},
				],
				nextCursor: { adapterId: "openalex", token: "cursor-page-2", returned: 2, spentUsd: 0.001 },
				exhausted: false,
				actualCost: { amount: 0.001, currency: "USD" },
				providerCostUsd: 0.001,
			},
		});
		expect(first.intents[0]).toMatchObject({
			paid: true,
			estimatedCost: { amount: 0.003, currency: "USD" },
			costPerRequest: { amount: 0.001, currency: "USD" },
			maxAttempts: 3,
			credential: { alias: "openalex-api-key", placement: { kind: "query", name: "api_key" } },
		});
		if (!firstPage.ok) throw new Error(firstPage.errors[0].message);

		const second = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: searchUrl("cursor-page-2"), body: null },
					response: { status: 200, body: await fixture("search-page-2.json") },
				},
			]),
		);
		await expect(
			adapter.search(searchRequest({ cursor: firstPage.value.nextCursor }), second.context),
		).resolves.toMatchObject({
			ok: true,
			value: {
				candidates: [{ openalexId: "W1003", doi: null, publicationStatus: "unknown" }],
				nextCursor: null,
				exhausted: true,
			},
		});
	});

	it("blocks missing or insufficient budgets, preserves partial results, and detects lookup conflicts", async () => {
		const adapter = new OpenAlexAdapter("openalex-api-key");
		const blocked = fixtureContext(async () => {
			throw new Error("budget failure must not reach transport");
		});
		await expect(adapter.search(searchRequest({ maxCost: null }), blocked.context)).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "OPENALEX_BUDGET_REQUIRED" }],
		});
		await expect(
			adapter.search(searchRequest({ maxCost: { amount: 0.002, currency: "USD" } }), blocked.context),
		).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "OPENALEX_BUDGET_LIMIT", details: { worstCaseNextSpend: 0.003 } }],
		});
		expect(blocked.intents).toHaveLength(0);

		const partialUrl = new URL(searchUrl("*"));
		partialUrl.searchParams.set("search", "partial fixture");
		const partial = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: partialUrl.toString(), body: null },
					response: { status: 200, body: await fixture("search-partial.json") },
				},
			]),
		);
		await expect(
			adapter.search(searchRequest({ queryText: "partial fixture" }), partial.context),
		).resolves.toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: { candidates: [{ openalexId: "W1004" }] },
			errors: [{ code: "OPENALEX_ITEM_INVALID", details: { itemIndex: 1 } }],
		});

		const lookupPath = encodeURIComponent("doi:10.5555/governance.1");
		const lookupUrl = `https://api.openalex.org/works/${lookupPath}`;
		const lookup = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: lookupUrl, body: null },
					response: { status: 200, body: await fixture("lookup.json") },
				},
			]),
		);
		await expect(adapter.lookup(doiIdentifier("10.5555/governance.1"), lookup.context)).resolves.toMatchObject({
			ok: true,
			value: {
				candidate: { openalexId: "W1001", doi: "10.5555/governance.1", publicationStatus: "unknown" },
				actualCost: { amount: 0, currency: "USD" },
			},
		});
		expect(lookup.intents[0]).toMatchObject({ paid: false, estimatedCost: null, costPerRequest: { amount: 0 } });

		const conflictPath = encodeURIComponent("doi:10.5555/different");
		const conflict = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: `https://api.openalex.org/works/${conflictPath}`, body: null },
					response: { status: 200, body: await fixture("lookup.json") },
				},
			]),
		);
		await expect(adapter.lookup(doiIdentifier("10.5555/different"), conflict.context)).resolves.toMatchObject({
			ok: false,
			status: "DATA_CONFLICT",
			errors: [{ code: "OPENALEX_IDENTIFIER_CONFLICT" }],
		});
	});
});
