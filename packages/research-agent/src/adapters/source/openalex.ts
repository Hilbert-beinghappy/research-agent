// SPDX-License-Identifier: Apache-2.0

import type { JsonValue, ResearchError, ResearchResult, SourceIdentifier } from "../../contracts/schemas.ts";
import { hashBytes } from "../../kernel/integrity.ts";
import type { FailureStatus } from "../../kernel/results.ts";
import type { HttpReceipt, HttpRequestIntent } from "../../security/broker-http.ts";
import type {
	AdapterCapabilitySnapshot,
	AdapterContext,
	SourceAdapter,
	SourceSearchPage,
	SourceSearchRequest,
} from "./contract.ts";

const OPENALEX_BASE_URL = "https://api.openalex.org";
const OPENALEX_ADAPTER_VERSION = "0.1.0";
const OPENALEX_SEARCH_COST_USD = 0.001;
const OPENALEX_MAX_ATTEMPTS = 3;
const MONEY_TOLERANCE_USD = 1e-12;
const OPENALEX_SELECT = [
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

type JsonObject = { [key: string]: JsonValue };

interface OpenAlexCursor {
	token: string;
	returned: number;
	spentUsd: number;
}

function failure<Value>(
	context: AdapterContext,
	status: FailureStatus,
	code: string,
	category: ResearchError["category"],
	message: string,
	details: JsonValue = null,
): ResearchResult<Value> {
	const error: ResearchError = {
		code,
		category,
		message,
		retryable: status === "RETRYABLE_FAILURE",
		source: "openalex",
		operationId: context.operationId,
		taskId: context.taskId,
		details,
		occurredAt: new Date().toISOString(),
		causeCode: null,
	};
	return {
		ok: false,
		status,
		value: null,
		errors: [error],
		meta: { operationId: context.operationId, taskId: context.taskId, warnings: [] },
	};
}

function success<Value>(context: AdapterContext, value: Value, errors: ResearchError[] = []): ResearchResult<Value> {
	return errors.length === 0
		? {
				ok: true,
				status: "SUCCESS",
				value,
				errors: [],
				meta: { operationId: context.operationId, taskId: context.taskId, warnings: [] },
			}
		: {
				ok: true,
				status: "PARTIAL_SUCCESS",
				value,
				errors,
				meta: {
					operationId: context.operationId,
					taskId: context.taskId,
					warnings: errors.map(({ message }) => message),
				},
			};
}

function brokerFailure<Value>(context: AdapterContext, result: ResearchResult<HttpReceipt>): ResearchResult<Value> {
	if (result.ok) throw new TypeError("Expected failed HTTP broker result");
	return {
		...result,
		errors: result.errors.map((error) => ({ ...error, taskId: context.taskId })),
		meta: { ...result.meta, taskId: context.taskId },
	};
}

function objectValue(value: JsonValue | undefined, label: string): JsonObject {
	if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value;
}

function parseObject(body: string, label: string): JsonObject {
	try {
		return objectValue(JSON.parse(body) as JsonValue, label);
	} catch (error) {
		if (error instanceof SyntaxError) throw new TypeError(`${label} is not valid JSON`);
		throw error;
	}
}

function normalizeDoi(value: string): string {
	const doi = value
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/^doi:/i, "")
		.toLowerCase();
	if (!doi.startsWith("10.") || !doi.includes("/") || /\s/.test(doi)) throw new TypeError("OpenAlex DOI is invalid");
	return doi;
}

function normalizeOpenAlexId(value: string): string {
	const id = value
		.trim()
		.replace(/^https?:\/\/openalex\.org\//i, "")
		.toUpperCase();
	if (!/^W\d+$/.test(id)) throw new TypeError("OpenAlex work ID is invalid");
	return id;
}

function nullableString(value: JsonValue | undefined): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function workCandidate(value: JsonValue): JsonObject {
	const work = objectValue(value, "OpenAlex work");
	if (typeof work.id !== "string") throw new TypeError("OpenAlex work is missing id");
	if (typeof work.is_retracted !== "boolean") throw new TypeError("OpenAlex work is missing is_retracted");
	const openalexId = normalizeOpenAlexId(work.id);
	const doi = typeof work.doi === "string" ? normalizeDoi(work.doi) : null;
	const authors = Array.isArray(work.authorships)
		? work.authorships.flatMap((entry) => {
				if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
				const author = entry.author;
				if (author === null || typeof author !== "object" || Array.isArray(author)) return [];
				return [
					{
						name: nullableString(author.display_name),
						openalexId:
							typeof author.id === "string" ? author.id.replace(/^https?:\/\/openalex\.org\//i, "") : null,
						orcid: nullableString(author.orcid),
						position: nullableString(entry.author_position),
					},
				];
			})
		: [];
	const primaryLocation =
		work.primary_location !== null &&
		typeof work.primary_location === "object" &&
		!Array.isArray(work.primary_location)
			? work.primary_location
			: null;
	const source =
		primaryLocation?.source !== null &&
		primaryLocation?.source !== undefined &&
		typeof primaryLocation.source === "object" &&
		!Array.isArray(primaryLocation.source)
			? primaryLocation.source
			: null;
	const openAccess =
		work.open_access !== null && typeof work.open_access === "object" && !Array.isArray(work.open_access)
			? work.open_access
			: null;
	const ids = work.ids !== null && typeof work.ids === "object" && !Array.isArray(work.ids) ? work.ids : null;
	const primaryTopic =
		work.primary_topic !== null && typeof work.primary_topic === "object" && !Array.isArray(work.primary_topic)
			? work.primary_topic
			: null;
	return {
		adapterId: "openalex",
		openalexId,
		doi,
		title: nullableString(work.title),
		authors,
		issuedDate: nullableString(work.publication_date),
		publicationYear:
			typeof work.publication_year === "number" && Number.isInteger(work.publication_year)
				? work.publication_year
				: null,
		type: nullableString(work.type),
		language: nullableString(work.language),
		containerTitle: nullableString(source?.display_name),
		issnL: nullableString(source?.issn_l),
		citedByCount:
			typeof work.cited_by_count === "number" && Number.isInteger(work.cited_by_count) ? work.cited_by_count : null,
		relevanceScore:
			typeof work.relevance_score === "number" && Number.isFinite(work.relevance_score)
				? work.relevance_score
				: null,
		identifiers: {
			pmid: nullableString(ids?.pmid),
			pmcid: nullableString(ids?.pmcid),
		},
		retractedFlag: work.is_retracted,
		publicationStatus: work.is_retracted ? "retracted" : "unknown",
		openAccess: {
			isOpen: typeof openAccess?.is_oa === "boolean" ? openAccess.is_oa : null,
			status: nullableString(openAccess?.oa_status),
			landingPageUrl: nullableString(primaryLocation?.landing_page_url),
			pdfUrl: nullableString(primaryLocation?.pdf_url),
			license: nullableString(primaryLocation?.license),
		},
		primaryTopic:
			primaryTopic === null
				? null
				: {
						id: nullableString(primaryTopic.id),
						name: nullableString(primaryTopic.display_name),
						score:
							typeof primaryTopic.score === "number" && Number.isFinite(primaryTopic.score)
								? primaryTopic.score
								: null,
					},
	};
}

function searchFilters(filters: JsonValue): string | null {
	if (filters === null) return null;
	const value = objectValue(filters, "OpenAlex search filters");
	const supported = new Set(["fromYear", "toYear", "types"]);
	const unknown = Object.keys(value).find((key) => !supported.has(key));
	if (unknown !== undefined) throw new TypeError(`Unsupported OpenAlex search filter: ${unknown}`);
	const fromYear = value.fromYear;
	const toYear = value.toYear;
	for (const [name, year] of [
		["fromYear", fromYear],
		["toYear", toYear],
	] as const) {
		if (
			year !== undefined &&
			year !== null &&
			(!Number.isInteger(year) || typeof year !== "number" || year < 1000 || year > 9999)
		) {
			throw new TypeError(`OpenAlex ${name} must be a four-digit year or null`);
		}
	}
	if (typeof fromYear === "number" && typeof toYear === "number" && fromYear > toYear) {
		throw new TypeError("OpenAlex fromYear cannot exceed toYear");
	}
	const types = value.types;
	const workTypes = Array.isArray(types) ? types.filter((type): type is string => typeof type === "string") : [];
	if (types !== undefined && (!Array.isArray(types) || workTypes.length !== types.length)) {
		throw new TypeError("OpenAlex types must be an array of strings");
	}
	if (workTypes.length > 100) throw new TypeError("OpenAlex accepts at most 100 work types");
	if (workTypes.some((type) => !/^[a-z0-9-]+$/.test(type))) {
		throw new TypeError("OpenAlex work type is invalid");
	}
	const parts: string[] = [];
	if (typeof fromYear === "number") parts.push(`from_publication_date:${fromYear}-01-01`);
	if (typeof toYear === "number") parts.push(`to_publication_date:${toYear}-12-31`);
	if (workTypes.length > 0) parts.push(`type:${workTypes.join("|")}`);
	return parts.length === 0 ? null : parts.join(",");
}

function searchCursor(value: JsonValue): OpenAlexCursor {
	if (value === null) return { token: "*", returned: 0, spentUsd: 0 };
	const cursor = objectValue(value, "OpenAlex cursor");
	if (
		cursor.adapterId !== "openalex" ||
		typeof cursor.token !== "string" ||
		cursor.token.length === 0 ||
		typeof cursor.returned !== "number" ||
		!Number.isInteger(cursor.returned) ||
		cursor.returned < 0 ||
		typeof cursor.spentUsd !== "number" ||
		!Number.isFinite(cursor.spentUsd) ||
		cursor.spentUsd < 0
	) {
		throw new TypeError("OpenAlex cursor is invalid");
	}
	return { token: cursor.token, returned: cursor.returned, spentUsd: cursor.spentUsd };
}

function parseError(
	context: AdapterContext,
	error: unknown,
	rawResponse?: HttpReceipt["responseFile"],
): ResearchResult<never> {
	return failure(
		context,
		"PERMANENT_FAILURE",
		rawResponse === undefined ? "OPENALEX_REQUEST_INVALID" : "OPENALEX_RESPONSE_INVALID",
		rawResponse === undefined ? "validation" : "parse",
		error instanceof Error ? error.message : "OpenAlex response is invalid",
		rawResponse === undefined ? null : { rawResponse },
	);
}

export class OpenAlexAdapter implements SourceAdapter {
	private readonly apiKeyCredentialAlias: string | null;
	private readonly generatedAt: string;

	constructor(apiKeyCredentialAlias: string | null = null) {
		if (apiKeyCredentialAlias !== null && apiKeyCredentialAlias.trim().length === 0) {
			throw new TypeError("OpenAlex API key credential alias must not be empty");
		}
		this.apiKeyCredentialAlias = apiKeyCredentialAlias;
		this.generatedAt = new Date().toISOString();
	}

	async capabilities(): Promise<AdapterCapabilitySnapshot> {
		return {
			adapterId: "openalex",
			adapterVersion: OPENALEX_ADAPTER_VERSION,
			adapterKind: "source",
			contractVersion: "1",
			capabilities: ["health", "search", "lookup", "retracted-flag", "topics", "open-access-metadata"],
			supportsPagination: true,
			supportsResumeCursor: true,
			mayCostMoney: true,
			maySendDataExternally: true,
			requiresCredentials: true,
			supportedIdentifiers: ["doi", "openalex"],
			limits: {
				status: this.apiKeyCredentialAlias === null ? "degraded" : "configured",
				degradedTo: this.apiKeyCredentialAlias === null ? ["crossref", "local"] : [],
				maxPageSize: 100,
				maxFilterValues: 100,
				pricing: {
					asOf: "2026-08-06",
					currency: "USD",
					searchPerCall: OPENALEX_SEARCH_COST_USD,
					singletonPerCall: 0,
					freeDailyCreditWithKey: 1,
				},
			},
			generatedAt: this.generatedAt,
		};
	}

	private unavailable<Value>(context: AdapterContext): ResearchResult<Value> {
		return failure(
			context,
			"PERMISSION_BLOCKED",
			"OPENALEX_API_KEY_REQUIRED",
			"permission",
			"OpenAlex API key is not configured; use Crossref or local sources",
			{ degradedTo: ["crossref", "local"] },
		);
	}

	private request(url: URL, dataClass: string, costPerRequest: number): HttpRequestIntent {
		if (this.apiKeyCredentialAlias === null) throw new TypeError("OpenAlex API key is not configured");
		return {
			method: "GET",
			url: url.toString(),
			headers: { accept: "application/json", "user-agent": `pi-research-agent/${OPENALEX_ADAPTER_VERSION}` },
			body: null,
			credential: {
				alias: this.apiKeyCredentialAlias,
				placement: { kind: "query", name: "api_key", prefix: "" },
			},
			dataClasses: [dataClass],
			paid: costPerRequest > 0,
			estimatedCost:
				costPerRequest === 0 ? null : { amount: costPerRequest * OPENALEX_MAX_ATTEMPTS, currency: "USD" },
			costPerRequest: { amount: costPerRequest, currency: "USD" },
			maxAttempts: OPENALEX_MAX_ATTEMPTS,
			idempotencyKey: `openalex:${hashBytes(url.toString()).value}`,
			responseBody: "text",
			maxResponseBytes: 10 * 1_024 * 1_024,
		};
	}

	async healthCheck(context: AdapterContext): Promise<ResearchResult<JsonValue>> {
		if (this.apiKeyCredentialAlias === null) {
			return success(context, {
				adapterId: "openalex",
				status: "degraded",
				reason: "OPENALEX_API_KEY_REQUIRED",
				degradedTo: ["crossref", "local"],
			});
		}
		const result = await context.brokers.requestHttp(
			this.request(new URL(`${OPENALEX_BASE_URL}/rate-limit`), "public_service_probe", 0),
		);
		if (!result.ok) return brokerFailure(context, result);
		try {
			const body = parseObject(result.value.body, "OpenAlex rate-limit response");
			const rateLimit = objectValue(body.rate_limit, "OpenAlex rate_limit");
			const costs = objectValue(rateLimit.endpoint_costs_usd, "OpenAlex endpoint costs");
			const searchCost = costs.search;
			if (typeof searchCost !== "number" || !Number.isFinite(searchCost) || searchCost < 0) {
				throw new TypeError("OpenAlex search price is invalid");
			}
			return success(context, {
				adapterId: "openalex",
				status: searchCost === OPENALEX_SEARCH_COST_USD ? "ok" : "degraded",
				reason: searchCost === OPENALEX_SEARCH_COST_USD ? null : "OPENALEX_PRICING_CHANGED",
				rateLimit: {
					dailyBudgetUsd: rateLimit.daily_budget_usd ?? null,
					dailyUsedUsd: rateLimit.daily_used_usd ?? null,
					dailyRemainingUsd: rateLimit.daily_remaining_usd ?? null,
					prepaidRemainingUsd: rateLimit.prepaid_remaining_usd ?? null,
					resetsAt: rateLimit.resets_at ?? null,
					endpointCostsUsd: costs,
				},
				rawResponse: result.value.responseFile,
				actualCost: result.value.actualCost,
			});
		} catch (error) {
			return parseError(context, error, result.value.responseFile);
		}
	}

	async search(request: SourceSearchRequest, context: AdapterContext): Promise<ResearchResult<SourceSearchPage>> {
		if (this.apiKeyCredentialAlias === null) return this.unavailable(context);
		let rawResponse: HttpReceipt["responseFile"] | undefined;
		try {
			const queryText = request.queryText.trim();
			if (queryText.length === 0) throw new TypeError("OpenAlex query must not be empty");
			if (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 100) {
				throw new TypeError("OpenAlex pageSize must be an integer from 1 to 100");
			}
			if (!Number.isInteger(request.maxResults) || request.maxResults < 1) {
				throw new TypeError("OpenAlex maxResults must be a positive integer");
			}
			const cursor = searchCursor(request.cursor);
			if (request.maxCost === null) {
				return failure(
					context,
					"PERMISSION_BLOCKED",
					"OPENALEX_BUDGET_REQUIRED",
					"budget",
					"OpenAlex search requires an explicit USD budget",
				);
			}
			if (
				request.maxCost.currency !== "USD" ||
				!Number.isFinite(request.maxCost.amount) ||
				request.maxCost.amount < 0
			) {
				throw new TypeError("OpenAlex maxCost must be a non-negative USD amount");
			}
			const worstCaseNextSpend = cursor.spentUsd + OPENALEX_SEARCH_COST_USD * OPENALEX_MAX_ATTEMPTS;
			if (worstCaseNextSpend > request.maxCost.amount + MONEY_TOLERANCE_USD) {
				return failure(
					context,
					"PERMISSION_BLOCKED",
					"OPENALEX_BUDGET_LIMIT",
					"budget",
					"OpenAlex search page would exceed the request budget",
					{ spentUsd: cursor.spentUsd, worstCaseNextSpend, maxCost: request.maxCost },
				);
			}
			const remaining = request.maxResults - cursor.returned;
			if (remaining < 1) throw new TypeError("OpenAlex cursor has reached maxResults");
			const rows = Math.min(request.pageSize, remaining);
			const url = new URL(`${OPENALEX_BASE_URL}/works`);
			url.searchParams.set("search", queryText);
			url.searchParams.set("per_page", rows.toString());
			url.searchParams.set("cursor", cursor.token);
			const filter = searchFilters(request.filters);
			if (filter !== null) url.searchParams.set("filter", filter);
			url.searchParams.set("select", OPENALEX_SELECT);
			const result = await context.brokers.requestHttp(this.request(url, "public_query", OPENALEX_SEARCH_COST_USD));
			if (!result.ok) return brokerFailure(context, result);
			rawResponse = result.value.responseFile;
			const body = parseObject(result.value.body, "OpenAlex search response");
			const meta = objectValue(body.meta, "OpenAlex search meta");
			if (!Array.isArray(body.results)) throw new TypeError("OpenAlex search response is missing results");
			const providerCostUsd = meta.cost_usd;
			if (typeof providerCostUsd !== "number" || !Number.isFinite(providerCostUsd) || providerCostUsd < 0) {
				throw new TypeError("OpenAlex response cost_usd is invalid");
			}
			if (providerCostUsd > result.value.actualCost.amount + MONEY_TOLERANCE_USD) {
				return failure(
					context,
					"DATA_CONFLICT",
					"OPENALEX_COST_CONFLICT",
					"data_conflict",
					"OpenAlex reported a higher cost than the approved request estimate",
					{
						providerCostUsd,
						approvedActualCost: result.value.actualCost,
						rawResponse: result.value.responseFile,
					},
				);
			}
			const errors: ResearchError[] = [...result.errors];
			const candidates: JsonValue[] = [];
			for (const [index, item] of body.results.entries()) {
				try {
					candidates.push(workCandidate(item));
				} catch (error) {
					errors.push({
						code: "OPENALEX_ITEM_INVALID",
						category: "parse",
						message: error instanceof Error ? error.message : "OpenAlex item is invalid",
						retryable: false,
						source: "openalex",
						operationId: context.operationId,
						taskId: context.taskId,
						details: { itemIndex: index, rawResponse: result.value.responseFile },
						occurredAt: new Date().toISOString(),
						causeCode: null,
					});
				}
			}
			const returned = cursor.returned + body.results.length;
			const nextToken = typeof meta.next_cursor === "string" ? meta.next_cursor : null;
			const exhausted = body.results.length < rows || returned >= request.maxResults || nextToken === null;
			const spentUsd = cursor.spentUsd + result.value.actualCost.amount;
			return success(
				context,
				{
					candidates,
					nextCursor: exhausted ? null : { adapterId: "openalex", token: nextToken, returned, spentUsd },
					exhausted,
					rawResponse: result.value.responseFile,
					actualCost: result.value.actualCost,
					providerCostUsd,
				},
				errors,
			);
		} catch (error) {
			return parseError(context, error, rawResponse);
		}
	}

	async lookup(identifier: SourceIdentifier, context: AdapterContext): Promise<ResearchResult<JsonValue>> {
		if (this.apiKeyCredentialAlias === null) return this.unavailable(context);
		let expected: string;
		let path: string;
		try {
			if (identifier.scheme === "doi") {
				expected = normalizeDoi(identifier.normalizedValue);
				path = `doi:${expected}`;
			} else if (identifier.scheme === "openalex") {
				expected = normalizeOpenAlexId(identifier.normalizedValue);
				path = expected;
			} else {
				return failure(
					context,
					"PERMANENT_FAILURE",
					"OPENALEX_IDENTIFIER_UNSUPPORTED",
					"validation",
					`OpenAlex lookup does not support ${identifier.scheme}`,
				);
			}
		} catch (error) {
			return parseError(context, error);
		}
		const url = new URL(`${OPENALEX_BASE_URL}/works/${encodeURIComponent(path)}`);
		const result = await context.brokers.requestHttp(this.request(url, "public_identifier", 0));
		if (!result.ok) return brokerFailure(context, result);
		try {
			const candidate = workCandidate(parseObject(result.value.body, "OpenAlex work response"));
			const actual = identifier.scheme === "doi" ? candidate.doi : candidate.openalexId;
			if (actual !== expected) {
				return failure(
					context,
					"DATA_CONFLICT",
					"OPENALEX_IDENTIFIER_CONFLICT",
					"data_conflict",
					"OpenAlex response identifier differs from the requested identifier",
					{ requested: expected, response: actual, rawResponse: result.value.responseFile },
				);
			}
			return success(context, {
				candidate,
				rawResponse: result.value.responseFile,
				actualCost: result.value.actualCost,
			});
		} catch (error) {
			return parseError(context, error, result.value.responseFile);
		}
	}
}
