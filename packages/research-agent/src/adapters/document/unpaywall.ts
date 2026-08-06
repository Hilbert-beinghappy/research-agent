// SPDX-License-Identifier: Apache-2.0

import type {
	AccessStatus,
	FileRef,
	JsonValue,
	Money,
	ResearchError,
	ResearchResult,
	SourceIdentifier,
} from "../../contracts/schemas.ts";
import { hashBytes } from "../../kernel/integrity.ts";
import type { FailureStatus } from "../../kernel/results.ts";
import type { HttpReceipt, HttpRequestIntent } from "../../security/broker-http.ts";
import type { AdapterCapabilitySnapshot, AdapterContext } from "../source/contract.ts";

const UNPAYWALL_BASE_URL = "https://api.unpaywall.org/v2";
const UNPAYWALL_ADAPTER_VERSION = "0.1.0";

type JsonObject = { [key: string]: JsonValue };

export interface UnpaywallLocation {
	url: string;
	landingPageUrl: string | null;
	pdfUrl: string | null;
	hostType: "publisher" | "repository";
	version: "submittedVersion" | "acceptedVersion" | "publishedVersion" | null;
	isBest: boolean;
	license: string | null;
	licenseStatus: "known" | "unknown";
	oaDate: string | null;
	repositoryInstitution: string | null;
	evidence: string | null;
}

export interface UnpaywallLookupResult {
	doi: string;
	isOpenAccess: boolean;
	oaStatus: string | null;
	accessStatus: AccessStatus;
	locations: UnpaywallLocation[];
	bestLocation: UnpaywallLocation | null;
	rawResponse: FileRef;
	actualCost: Money;
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
		source: "unpaywall",
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

function parseObject(body: string): JsonObject {
	try {
		return objectValue(JSON.parse(body) as JsonValue, "Unpaywall response");
	} catch (error) {
		if (error instanceof SyntaxError) throw new TypeError("Unpaywall response is not valid JSON");
		throw error;
	}
}

function normalizeDoi(value: string): string {
	const doi = value
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/^doi:/i, "")
		.toLowerCase();
	if (!doi.startsWith("10.") || !doi.includes("/") || /\s/.test(doi)) throw new TypeError("Unpaywall DOI is invalid");
	return doi;
}

function nullableString(value: JsonValue | undefined, label: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a string or null`);
	return value.trim();
}

function locationUrl(value: JsonValue | undefined, label: string, required: boolean): string | null {
	const text = nullableString(value, label);
	if (text === null) {
		if (required) throw new TypeError(`${label} is required`);
		return null;
	}
	const url = new URL(text);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`${label} must use HTTP or HTTPS`);
	return url.toString();
}

function normalizeLocation(value: JsonValue, label: string): UnpaywallLocation {
	const location = objectValue(value, label);
	if (location.host_type !== "publisher" && location.host_type !== "repository") {
		throw new TypeError(`${label} has an invalid host_type`);
	}
	if (typeof location.is_best !== "boolean") throw new TypeError(`${label} is missing is_best`);
	const version = nullableString(location.version, `${label} version`);
	if (
		version !== null &&
		version !== "submittedVersion" &&
		version !== "acceptedVersion" &&
		version !== "publishedVersion"
	) {
		throw new TypeError(`${label} has an invalid version`);
	}
	const license = nullableString(location.license, `${label} license`);
	return {
		url: locationUrl(location.url, `${label} url`, true) as string,
		landingPageUrl: locationUrl(location.url_for_landing_page, `${label} landing page URL`, false),
		pdfUrl: locationUrl(location.url_for_pdf, `${label} PDF URL`, false),
		hostType: location.host_type,
		version,
		isBest: location.is_best,
		license,
		licenseStatus: license === null ? "unknown" : "known",
		oaDate: nullableString(location.oa_date, `${label} oa_date`),
		repositoryInstitution: nullableString(location.repository_institution, `${label} repository institution`),
		evidence: nullableString(location.evidence, `${label} evidence`),
	};
}

function parseError(
	context: AdapterContext,
	error: unknown,
	rawResponse?: HttpReceipt["responseFile"],
): ResearchResult<never> {
	return failure(
		context,
		"PERMANENT_FAILURE",
		rawResponse === undefined ? "UNPAYWALL_REQUEST_INVALID" : "UNPAYWALL_RESPONSE_INVALID",
		rawResponse === undefined ? "validation" : "parse",
		error instanceof Error ? error.message : "Unpaywall response is invalid",
		rawResponse === undefined ? null : { rawResponse },
	);
}

export class UnpaywallAdapter {
	private readonly emailCredentialAlias: string | null;
	private readonly generatedAt: string;

	constructor(emailCredentialAlias: string | null = null) {
		if (emailCredentialAlias !== null && emailCredentialAlias.trim().length === 0) {
			throw new TypeError("Unpaywall email credential alias must not be empty");
		}
		this.emailCredentialAlias = emailCredentialAlias;
		this.generatedAt = new Date().toISOString();
	}

	async capabilities(): Promise<AdapterCapabilitySnapshot> {
		return {
			adapterId: "unpaywall",
			adapterVersion: UNPAYWALL_ADAPTER_VERSION,
			contractVersion: "0.1.0",
			capabilities: ["health", "doi-oa-location"],
			supportsPagination: false,
			supportsResumeCursor: false,
			mayCostMoney: false,
			maySendDataExternally: true,
			requiresCredentials: true,
			supportedIdentifiers: ["doi"],
			limits: {
				status: this.emailCredentialAlias === null ? "degraded" : "configured",
				apiVersion: "v2",
				emailRequired: true,
				dailyRequestLimit: 100_000,
				healthProbe: "configuration_only",
				pricing: { asOf: "2026-08-06", currency: "USD", perCall: 0 },
			},
			generatedAt: this.generatedAt,
		};
	}

	async healthCheck(context: AdapterContext): Promise<ResearchResult<JsonValue>> {
		return success(context, {
			adapterId: "unpaywall",
			status: this.emailCredentialAlias === null ? "degraded" : "configured",
			reason: this.emailCredentialAlias === null ? "UNPAYWALL_EMAIL_REQUIRED" : null,
			serviceProbe: "not_available",
		});
	}

	private request(doi: string): HttpRequestIntent {
		if (this.emailCredentialAlias === null) throw new TypeError("Unpaywall email is not configured");
		const url = `${UNPAYWALL_BASE_URL}/${encodeURIComponent(doi)}`;
		return {
			method: "GET",
			url,
			headers: { accept: "application/json", "user-agent": `pi-research-agent/${UNPAYWALL_ADAPTER_VERSION}` },
			body: null,
			credential: {
				alias: this.emailCredentialAlias,
				placement: { kind: "query", name: "email", prefix: "" },
			},
			dataClasses: ["public_identifier"],
			paid: false,
			estimatedCost: null,
			costPerRequest: { amount: 0, currency: "USD" },
			maxAttempts: 3,
			idempotencyKey: `unpaywall:${hashBytes(url).value}`,
			responseBody: "text",
			maxResponseBytes: 2 * 1_024 * 1_024,
		};
	}

	async locate(identifier: SourceIdentifier, context: AdapterContext): Promise<ResearchResult<UnpaywallLookupResult>> {
		if (this.emailCredentialAlias === null) {
			return failure(
				context,
				"PERMISSION_BLOCKED",
				"UNPAYWALL_EMAIL_REQUIRED",
				"permission",
				"Unpaywall requires an email credential alias",
			);
		}
		if (identifier.scheme !== "doi") {
			return failure(
				context,
				"PERMANENT_FAILURE",
				"UNPAYWALL_DOI_REQUIRED",
				"validation",
				"Unpaywall location lookup requires a DOI",
			);
		}
		let doi: string;
		try {
			doi = normalizeDoi(identifier.normalizedValue);
		} catch (error) {
			return parseError(context, error);
		}
		const result = await context.brokers.requestHttp(this.request(doi));
		if (!result.ok) return brokerFailure(context, result);
		try {
			const body = parseObject(result.value.body);
			if (typeof body.doi !== "string") throw new TypeError("Unpaywall response is missing doi");
			const responseDoi = normalizeDoi(body.doi);
			if (responseDoi !== doi) {
				return failure(
					context,
					"DATA_CONFLICT",
					"UNPAYWALL_DOI_CONFLICT",
					"data_conflict",
					"Unpaywall response DOI differs from the requested DOI",
					{ requested: doi, response: responseDoi, rawResponse: result.value.responseFile },
				);
			}
			if (typeof body.is_oa !== "boolean") throw new TypeError("Unpaywall response is missing is_oa");
			if (!Array.isArray(body.oa_locations)) throw new TypeError("Unpaywall response is missing oa_locations");
			const errors: ResearchError[] = [...result.errors];
			const locations: UnpaywallLocation[] = [];
			for (const [index, location] of body.oa_locations.entries()) {
				try {
					locations.push(normalizeLocation(location, `Unpaywall location ${index}`));
				} catch (error) {
					errors.push({
						code: "UNPAYWALL_LOCATION_INVALID",
						category: "parse",
						message: error instanceof Error ? error.message : "Unpaywall location is invalid",
						retryable: false,
						source: "unpaywall",
						operationId: context.operationId,
						taskId: context.taskId,
						details: { locationIndex: index, rawResponse: result.value.responseFile },
						occurredAt: new Date().toISOString(),
						causeCode: null,
					});
				}
			}
			const bestLocation = locations.find(({ isBest }) => isBest) ?? null;
			const hasLocation = locations.length > 0;
			if (body.is_oa && !hasLocation) {
				errors.push({
					code: "UNPAYWALL_OA_LOCATION_MISSING",
					category: "parse",
					message: "Unpaywall marked the work open access but supplied no valid location",
					retryable: false,
					source: "unpaywall",
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
					doi,
					isOpenAccess: body.is_oa,
					oaStatus: nullableString(body.oa_status, "Unpaywall oa_status"),
					accessStatus: body.is_oa ? (hasLocation ? "open_access" : "unknown") : "paywalled",
					locations,
					bestLocation,
					rawResponse: result.value.responseFile,
					actualCost: result.value.actualCost,
				},
				errors,
			);
		} catch (error) {
			return parseError(context, error, result.value.responseFile);
		}
	}
}
