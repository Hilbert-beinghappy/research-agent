// SPDX-License-Identifier: Apache-2.0

import type {
	JsonValue,
	PublicationStatus,
	ResearchError,
	ResearchResult,
	SourceIdentifier,
} from "../../contracts/schemas.ts";
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

const CROSSREF_BASE_URL = "https://api.crossref.org/v1";
const CROSSREF_ADAPTER_VERSION = "0.1.0";
const CROSSREF_MEDIA_TYPE = "application/vnd.crossref-api-message+json";

type JsonObject = { [key: string]: JsonValue };

interface CrossrefCursor {
	token: string;
	returned: number;
	expiresAt: string | null;
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
		source: "crossref",
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

function objectValue(value: JsonValue, label: string): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${label} must be an object`);
	return value;
}

function parseEnvelope(body: string, messageType: "work" | "work-list"): JsonObject {
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(body) as JsonValue;
	} catch {
		throw new TypeError("Crossref response is not valid JSON");
	}
	const envelope = objectValue(parsed, "Crossref response");
	if (envelope.status !== "ok" || envelope["message-type"] !== messageType) {
		throw new TypeError(`Crossref response is not a ${messageType}`);
	}
	return objectValue(envelope.message, "Crossref message");
}

function firstString(value: JsonValue | undefined): string | null {
	if (typeof value === "string") return value.trim() || null;
	if (!Array.isArray(value)) return null;
	const first = value.find((item) => typeof item === "string" && item.trim().length > 0);
	return typeof first === "string" ? first.trim() : null;
}

function stringArray(value: JsonValue | undefined): string[] {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				.map((item) => item.trim())
		: [];
}

function dateParts(value: JsonValue | undefined): string | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const parts = value["date-parts"];
	if (!Array.isArray(parts) || !Array.isArray(parts[0])) return null;
	const [year, month, day] = parts[0];
	if (!Number.isInteger(year) || typeof year !== "number") return null;
	const result = [year.toString().padStart(4, "0")];
	if (typeof month === "number" && Number.isInteger(month) && month >= 1 && month <= 12) {
		result.push(month.toString().padStart(2, "0"));
		if (typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31) {
			result.push(day.toString().padStart(2, "0"));
		}
	}
	return result.join("-");
}

function normalizeDoi(value: string): string {
	const doi = value
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.toLowerCase();
	if (!doi.startsWith("10.") || !doi.includes("/") || /\s/.test(doi)) throw new TypeError("Crossref DOI is invalid");
	return doi;
}

function updateRelations(value: JsonValue | undefined): JsonObject[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new TypeError("Crossref update-to must be an array");
	return value.map((entry) => {
		const relation = objectValue(entry, "Crossref update relation");
		const updatedDate = dateParts(relation.updated);
		if (typeof relation.type !== "string" || typeof relation.DOI !== "string" || updatedDate === null) {
			throw new TypeError("Crossref update relation is missing type, DOI, or updated date");
		}
		return {
			type: relation.type,
			targetDoi: normalizeDoi(relation.DOI),
			updatedDate,
			label: typeof relation.label === "string" ? relation.label : null,
			source: typeof relation.source === "string" ? relation.source : null,
		};
	});
}

function publicationStatus(relations: readonly JsonObject[]): PublicationStatus {
	const latestDate = relations
		.map(({ updatedDate }) => (typeof updatedDate === "string" ? updatedDate : ""))
		.sort()
		.at(-1);
	if (latestDate === undefined) return "unknown";
	const statuses = new Set<PublicationStatus>();
	for (const relation of relations) {
		if (relation.updatedDate !== latestDate || typeof relation.type !== "string") continue;
		const type = relation.type.toLowerCase();
		if (type.includes("reinstat")) statuses.add("normal");
		else if (type.includes("retract")) statuses.add("retracted");
		else if (type.includes("withdraw")) statuses.add("withdrawn");
		else if (type.includes("expression") && type.includes("concern")) statuses.add("expression_of_concern");
		else if (type.includes("correct") || type.includes("corrigend") || type.includes("errat")) {
			statuses.add("corrected");
		}
	}
	return statuses.size === 1 ? [...statuses][0] : "unknown";
}

function workCandidate(value: JsonValue): JsonObject {
	const work = objectValue(value, "Crossref work");
	if (typeof work.DOI !== "string") throw new TypeError("Crossref work is missing DOI");
	const updates = updateRelations(work["update-to"]);
	const authors = Array.isArray(work.author)
		? work.author.flatMap((value) => {
				if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
				return [
					{
						given: typeof value.given === "string" ? value.given : null,
						family: typeof value.family === "string" ? value.family : null,
						orcid: typeof value.ORCID === "string" ? value.ORCID : null,
					},
				];
			})
		: [];
	return {
		adapterId: "crossref",
		doi: normalizeDoi(work.DOI),
		title: firstString(work.title),
		authors,
		issuedDate: dateParts(work.issued),
		containerTitle: firstString(work["container-title"]),
		publisher: typeof work.publisher === "string" ? work.publisher : null,
		type: typeof work.type === "string" ? work.type : null,
		language: typeof work.language === "string" ? work.language : null,
		abstract: typeof work.abstract === "string" ? work.abstract : null,
		url: typeof work.URL === "string" ? work.URL : null,
		issn: stringArray(work.ISSN),
		isbn: stringArray(work.ISBN),
		score: typeof work.score === "number" && Number.isFinite(work.score) ? work.score : null,
		updates,
	};
}

function searchFilters(filters: JsonValue): string | null {
	if (filters === null) return null;
	const value = objectValue(filters, "Crossref search filters");
	const supported = new Set(["fromYear", "toYear", "types"]);
	const unknown = Object.keys(value).find((key) => !supported.has(key));
	if (unknown !== undefined) throw new TypeError(`Unsupported Crossref search filter: ${unknown}`);
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
			throw new TypeError(`Crossref ${name} must be a four-digit year or null`);
		}
	}
	if (typeof fromYear === "number" && typeof toYear === "number" && fromYear > toYear) {
		throw new TypeError("Crossref fromYear cannot exceed toYear");
	}
	const types = value.types;
	if (types !== undefined && (!Array.isArray(types) || types.some((type) => typeof type !== "string"))) {
		throw new TypeError("Crossref types must be an array of strings");
	}
	if (Array.isArray(types) && types.length > 1) {
		throw new TypeError("Crossref search accepts at most one work type per request");
	}
	const type = Array.isArray(types) ? types[0] : undefined;
	if (typeof type === "string" && !/^[a-z0-9-]+$/.test(type)) throw new TypeError("Crossref work type is invalid");
	const parts: string[] = [];
	if (typeof fromYear === "number") parts.push(`from-pub-date:${fromYear}-01-01`);
	if (typeof toYear === "number") parts.push(`until-pub-date:${toYear}-12-31`);
	if (typeof type === "string") parts.push(`type:${type}`);
	return parts.length === 0 ? null : parts.join(",");
}

function searchCursor(value: JsonValue): CrossrefCursor {
	if (value === null) return { token: "*", returned: 0, expiresAt: null };
	const cursor = objectValue(value, "Crossref cursor");
	if (
		cursor.adapterId !== "crossref" ||
		typeof cursor.token !== "string" ||
		cursor.token.length === 0 ||
		typeof cursor.returned !== "number" ||
		!Number.isInteger(cursor.returned) ||
		cursor.returned < 0 ||
		typeof cursor.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(cursor.expiresAt))
	) {
		throw new TypeError("Crossref cursor is invalid");
	}
	if (Date.parse(cursor.expiresAt) <= Date.now())
		throw new TypeError("Crossref cursor has expired; restart the search");
	return { token: cursor.token, returned: cursor.returned, expiresAt: cursor.expiresAt };
}

function parseError(
	context: AdapterContext,
	error: unknown,
	rawResponse?: HttpReceipt["responseFile"],
): ResearchResult<never> {
	return failure(
		context,
		"PERMANENT_FAILURE",
		rawResponse === undefined ? "CROSSREF_REQUEST_INVALID" : "CROSSREF_RESPONSE_INVALID",
		rawResponse === undefined ? "validation" : "parse",
		error instanceof Error ? error.message : "Crossref response is invalid",
		rawResponse === undefined ? null : { rawResponse },
	);
}

export class CrossrefAdapter implements SourceAdapter {
	private readonly generatedAt: string;
	private readonly mailtoCredentialAlias: string | null;

	constructor(mailtoCredentialAlias: string | null = null) {
		if (mailtoCredentialAlias !== null && mailtoCredentialAlias.trim().length === 0) {
			throw new TypeError("Crossref mailto credential alias must not be empty");
		}
		this.mailtoCredentialAlias = mailtoCredentialAlias;
		this.generatedAt = new Date().toISOString();
	}

	async capabilities(): Promise<AdapterCapabilitySnapshot> {
		return {
			adapterId: "crossref",
			adapterVersion: CROSSREF_ADAPTER_VERSION,
			adapterKind: "source",
			contractVersion: "1",
			capabilities: ["health", "search", "lookup", "publication-status-relations"],
			supportsPagination: true,
			supportsResumeCursor: true,
			mayCostMoney: false,
			maySendDataExternally: true,
			requiresCredentials: false,
			supportedIdentifiers: ["doi"],
			limits: { maxPageSize: 1000, cursorExpiresMinutes: 5, publicConcurrency: 1 },
			generatedAt: this.generatedAt,
		};
	}

	private request(url: URL, dataClass: string): HttpRequestIntent {
		return {
			method: "GET",
			url: url.toString(),
			headers: { accept: CROSSREF_MEDIA_TYPE, "user-agent": `pi-research-agent/${CROSSREF_ADAPTER_VERSION}` },
			body: null,
			credential:
				this.mailtoCredentialAlias === null
					? null
					: {
							alias: this.mailtoCredentialAlias,
							placement: { kind: "query", name: "mailto", prefix: "" },
						},
			dataClasses: [dataClass],
			paid: false,
			estimatedCost: null,
			costPerRequest: { amount: 0, currency: "USD" },
			maxAttempts: 3,
			idempotencyKey: `crossref:${hashBytes(url.toString()).value}`,
			responseBody: "text",
			maxResponseBytes: 10 * 1_024 * 1_024,
		};
	}

	async healthCheck(context: AdapterContext): Promise<ResearchResult<JsonValue>> {
		const url = new URL(`${CROSSREF_BASE_URL}/works`);
		url.searchParams.set("rows", "0");
		const result = await context.brokers.requestHttp(this.request(url, "public_service_probe"));
		if (!result.ok) return brokerFailure(context, result);
		try {
			parseEnvelope(result.value.body, "work-list");
			return success(context, {
				adapterId: "crossref",
				status: "ok",
				rawResponse: result.value.responseFile,
				actualCost: result.value.actualCost,
			});
		} catch (error) {
			return parseError(context, error, result.value.responseFile);
		}
	}

	async search(request: SourceSearchRequest, context: AdapterContext): Promise<ResearchResult<SourceSearchPage>> {
		let rawResponse: HttpReceipt["responseFile"] | undefined;
		try {
			const queryText = request.queryText.trim();
			if (queryText.length === 0) throw new TypeError("Crossref query must not be empty");
			if (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 1000) {
				throw new TypeError("Crossref pageSize must be an integer from 1 to 1000");
			}
			if (!Number.isInteger(request.maxResults) || request.maxResults < 1) {
				throw new TypeError("Crossref maxResults must be a positive integer");
			}
			const cursor = searchCursor(request.cursor);
			const remaining = request.maxResults - cursor.returned;
			if (remaining < 1) throw new TypeError("Crossref cursor has reached maxResults");
			const rows = Math.min(request.pageSize, remaining);
			const url = new URL(`${CROSSREF_BASE_URL}/works`);
			url.searchParams.set("query.bibliographic", queryText);
			url.searchParams.set("rows", rows.toString());
			url.searchParams.set("cursor", cursor.token);
			const filter = searchFilters(request.filters);
			if (filter !== null) url.searchParams.set("filter", filter);
			const result = await context.brokers.requestHttp(this.request(url, "public_query"));
			if (!result.ok) return brokerFailure(context, result);
			rawResponse = result.value.responseFile;

			const message = parseEnvelope(result.value.body, "work-list");
			if (!Array.isArray(message.items)) throw new TypeError("Crossref work-list is missing items");
			const errors: ResearchError[] = [...result.errors];
			const candidates: JsonValue[] = [];
			for (const [index, item] of message.items.entries()) {
				try {
					candidates.push(workCandidate(item));
				} catch (error) {
					errors.push({
						code: "CROSSREF_ITEM_INVALID",
						category: "parse",
						message: error instanceof Error ? error.message : "Crossref item is invalid",
						retryable: false,
						source: "crossref",
						operationId: context.operationId,
						taskId: context.taskId,
						details: { itemIndex: index, rawResponse: result.value.responseFile },
						occurredAt: new Date().toISOString(),
						causeCode: null,
					});
				}
			}
			const returned = cursor.returned + message.items.length;
			const exhausted = message.items.length < rows || returned >= request.maxResults;
			const nextToken = typeof message["next-cursor"] === "string" ? message["next-cursor"] : null;
			if (!exhausted && nextToken === null) {
				errors.push({
					code: "CROSSREF_CURSOR_MISSING",
					category: "parse",
					message: "Crossref response omitted next-cursor before the result set was exhausted",
					retryable: false,
					source: "crossref",
					operationId: context.operationId,
					taskId: context.taskId,
					details: { rawResponse: result.value.responseFile },
					occurredAt: new Date().toISOString(),
					causeCode: null,
				});
			}
			return success(
				context,
				{
					candidates,
					nextCursor:
						exhausted || nextToken === null
							? null
							: {
									adapterId: "crossref",
									token: nextToken,
									returned,
									expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
								},
					exhausted,
					rawResponse: result.value.responseFile,
					actualCost: result.value.actualCost,
				},
				errors,
			);
		} catch (error) {
			return parseError(context, error, rawResponse);
		}
	}

	async statusRelations(identifier: SourceIdentifier, context: AdapterContext): Promise<ResearchResult<JsonValue>> {
		if (identifier.scheme !== "doi") {
			return failure(
				context,
				"PERMANENT_FAILURE",
				"CROSSREF_IDENTIFIER_UNSUPPORTED",
				"validation",
				`Crossref status lookup does not support ${identifier.scheme}`,
			);
		}
		let doi: string;
		try {
			doi = normalizeDoi(identifier.normalizedValue);
		} catch (error) {
			return parseError(context, error);
		}
		const url = new URL(`${CROSSREF_BASE_URL}/works`);
		url.searchParams.set("filter", `updates:${doi}`);
		url.searchParams.set("rows", "1000");
		const result = await context.brokers.requestHttp(this.request(url, "public_identifier"));
		if (!result.ok) return brokerFailure(context, result);
		try {
			const message = parseEnvelope(result.value.body, "work-list");
			if (!Array.isArray(message.items)) throw new TypeError("Crossref status response is missing items");
			const errors: ResearchError[] = [...result.errors];
			const relations: JsonObject[] = [];
			for (const [index, item] of message.items.entries()) {
				try {
					const notice = objectValue(item, "Crossref update notice");
					if (typeof notice.DOI !== "string") throw new TypeError("Crossref update notice is missing DOI");
					const noticeDoi = normalizeDoi(notice.DOI);
					const noticeTitle = firstString(notice.title);
					for (const relation of updateRelations(notice["update-to"])) {
						if (relation.targetDoi === doi) relations.push({ ...relation, noticeDoi, noticeTitle });
					}
				} catch (error) {
					errors.push({
						code: "CROSSREF_STATUS_ITEM_INVALID",
						category: "parse",
						message: error instanceof Error ? error.message : "Crossref status item is invalid",
						retryable: false,
						source: "crossref",
						operationId: context.operationId,
						taskId: context.taskId,
						details: { itemIndex: index, rawResponse: result.value.responseFile },
						occurredAt: new Date().toISOString(),
						causeCode: null,
					});
				}
			}
			const totalResults = message["total-results"];
			if (
				typeof totalResults !== "number" ||
				!Number.isInteger(totalResults) ||
				totalResults > message.items.length
			) {
				errors.push({
					code: "CROSSREF_STATUS_INCOMPLETE",
					category: "parse",
					message: "Crossref status response does not prove a complete result set",
					retryable: false,
					source: "crossref",
					operationId: context.operationId,
					taskId: context.taskId,
					details: { returned: message.items.length, totalResults, rawResponse: result.value.responseFile },
					occurredAt: new Date().toISOString(),
					causeCode: null,
				});
			}
			return success(
				context,
				{
					doi,
					publicationStatus: publicationStatus(relations),
					statusRelations: relations,
					complete: errors.length === 0,
					rawResponse: result.value.responseFile,
					actualCost: result.value.actualCost,
				},
				errors,
			);
		} catch (error) {
			return parseError(context, error, result.value.responseFile);
		}
	}

	async lookup(identifier: SourceIdentifier, context: AdapterContext): Promise<ResearchResult<JsonValue>> {
		if (identifier.scheme !== "doi") {
			return failure(
				context,
				"PERMANENT_FAILURE",
				"CROSSREF_IDENTIFIER_UNSUPPORTED",
				"validation",
				`Crossref lookup does not support ${identifier.scheme}`,
			);
		}
		let doi: string;
		try {
			doi = normalizeDoi(identifier.normalizedValue);
		} catch (error) {
			return parseError(context, error);
		}
		const url = new URL(`${CROSSREF_BASE_URL}/works/${encodeURIComponent(doi)}`);
		const result = await context.brokers.requestHttp(this.request(url, "public_identifier"));
		if (!result.ok) return brokerFailure(context, result);
		try {
			const candidate = workCandidate(parseEnvelope(result.value.body, "work"));
			if (candidate.doi !== doi) {
				return failure(
					context,
					"DATA_CONFLICT",
					"CROSSREF_DOI_CONFLICT",
					"data_conflict",
					"Crossref response DOI differs from the requested DOI",
					{ requestedDoi: doi, responseDoi: candidate.doi, rawResponse: result.value.responseFile },
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
