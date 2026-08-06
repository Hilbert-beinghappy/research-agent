// SPDX-License-Identifier: Apache-2.0

import { mkdir } from "node:fs/promises";
import { setTimeout as waitFor } from "node:timers/promises";
import { fetchHttpTransport, type HttpMethod, type HttpTransport } from "../adapters/http/transport.ts";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import type { FileRef, HashValue, JsonValue, Money, OperationRecord, ResearchResult } from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { hashBytes, hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { withPersistedRunningOperation } from "../kernel/operations.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { calculateRecordSetIndex, listProjectRecordIds, projectRecordPath } from "../project/record-index.ts";
import { readRecord } from "../project/records.ts";
import { commitProjectTransaction } from "../project/transactions.ts";
import { readApprovalRecords } from "./approval.ts";
import { createActionRequest, evaluateActionPolicy } from "./policy.ts";

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);
const SENSITIVE_QUERY_PARAMETERS = new Set(["access_token", "api_key", "apikey", "email", "key", "mailto", "token"]);
const RECORDED_RESPONSE_HEADERS = new Set([
	"content-length",
	"content-type",
	"date",
	"etag",
	"last-modified",
	"retry-after",
]);

export interface HttpCredentialReference {
	alias: string;
	placement: {
		kind: "header" | "query";
		name: string;
		prefix: string;
	};
}

export interface HttpRequestIntent {
	method: HttpMethod;
	url: string;
	headers: Record<string, string>;
	body: string | null;
	credential: HttpCredentialReference | null;
	dataClasses: string[];
	paid: boolean;
	estimatedCost: Money | null;
	costPerRequest: Money;
	maxAttempts: number;
	idempotencyKey: string;
	responseBody: "text" | "base64";
	maxResponseBytes: number;
}

export interface HttpBrokerContext {
	operationId: string;
	sessionId: string | null;
	policySnapshotHash: HashValue;
	signal: AbortSignal;
}

export interface HttpReceipt {
	requestFile: FileRef;
	responseFile: FileRef;
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	bodyEncoding: "text" | "base64";
	bodyBytes: number;
	attempts: number;
	networkRequests: number;
	actualCost: Money;
	approvalId: string | null;
}

export interface HttpBrokerOptions {
	transport?: HttpTransport;
	resolveCredential?: (alias: string, signal: AbortSignal) => Promise<string>;
	wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	random?: () => number;
}

interface NormalizedHttpIntent extends Omit<HttpRequestIntent, "url" | "headers"> {
	url: string;
	headers: Record<string, string>;
}

interface HttpAttemptReceipt {
	attempt: number;
	statusCode: number | null;
	headers: Record<string, string>;
	body: string | null;
	bodyBytes: number | null;
	errorCode: string | null;
	retryable: boolean;
}

function validateMoney(value: Money, label: string): void {
	if (!Number.isFinite(value.amount) || value.amount < 0 || value.currency.trim().length === 0) {
		throw new TypeError(`${label} must be a non-negative amount with a currency`);
	}
}

function normalizeIntent(intent: HttpRequestIntent): NormalizedHttpIntent {
	if (!Number.isInteger(intent.maxAttempts) || intent.maxAttempts < 1 || intent.maxAttempts > 5) {
		throw new TypeError("HTTP maxAttempts must be an integer from 1 to 5");
	}
	if (intent.idempotencyKey.trim().length === 0) throw new TypeError("HTTP idempotencyKey must not be empty");
	if (!Number.isInteger(intent.maxResponseBytes) || intent.maxResponseBytes < 1) {
		throw new TypeError("HTTP maxResponseBytes must be a positive integer");
	}
	if (intent.dataClasses.some((dataClass) => dataClass.trim().length === 0)) {
		throw new TypeError("HTTP data classes must not be empty");
	}
	if ((intent.method === "GET" || intent.method === "HEAD") && intent.body !== null) {
		throw new TypeError(`${intent.method} requests cannot have a body`);
	}
	const url = new URL(intent.url);
	if (url.protocol !== "https:") throw new TypeError("Governed HTTP only permits HTTPS destinations");
	if (url.username !== "" || url.password !== "" || url.hash !== "") {
		throw new TypeError("Governed HTTP URLs cannot contain credentials or fragments");
	}
	for (const name of url.searchParams.keys()) {
		if (SENSITIVE_QUERY_PARAMETERS.has(name.toLowerCase())) {
			throw new TypeError(`Raw credential-like query parameter is forbidden: ${name}`);
		}
	}
	const headers = Object.fromEntries(new Headers(intent.headers).entries());
	for (const name of Object.keys(headers)) {
		if (SENSITIVE_HEADERS.has(name)) throw new TypeError(`Raw credential header is forbidden: ${name}`);
	}
	if (intent.credential !== null) {
		const { alias, placement } = intent.credential;
		if (alias.trim().length === 0 || placement.name.trim().length === 0 || /[\r\n]/.test(placement.prefix)) {
			throw new TypeError("HTTP credential reference is invalid");
		}
		const name = placement.name.toLowerCase();
		if (placement.kind === "header" && name in headers) {
			throw new TypeError(`Credential header already exists: ${placement.name}`);
		}
		if (placement.kind === "query" && url.searchParams.has(placement.name)) {
			throw new TypeError(`Credential query parameter already exists: ${placement.name}`);
		}
	}
	validateMoney(intent.costPerRequest, "HTTP costPerRequest");
	if (intent.estimatedCost !== null) {
		validateMoney(intent.estimatedCost, "HTTP estimatedCost");
		if (intent.estimatedCost.currency !== intent.costPerRequest.currency) {
			throw new TypeError("HTTP estimate and per-request cost currencies must match");
		}
		if (intent.estimatedCost.amount < intent.costPerRequest.amount * intent.maxAttempts) {
			throw new TypeError("HTTP estimate must cover every permitted request attempt");
		}
	}
	if (!intent.paid && (intent.costPerRequest.amount !== 0 || (intent.estimatedCost?.amount ?? 0) !== 0)) {
		throw new TypeError("A free HTTP intent cannot declare a non-zero cost");
	}
	return { ...intent, url: url.toString(), headers };
}

function recordedHeaders(headers: Record<string, string>): Record<string, string> {
	const normalized = Object.fromEntries(new Headers(headers).entries());
	return Object.fromEntries(
		Object.entries(normalized).filter(
			([name]) =>
				RECORDED_RESPONSE_HEADERS.has(name) || name.startsWith("ratelimit-") || name.startsWith("x-ratelimit-"),
		),
	);
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(headers: Record<string, string>): number {
	const value = Object.fromEntries(new Headers(headers).entries())["retry-after"];
	if (value === undefined) return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function retryDelay(attempt: number, headers: Record<string, string>, random: () => number): number {
	const exponentialWithJitter = 500 * 2 ** (attempt - 1) + random() * 500;
	return Math.min(30_000, Math.max(exponentialWithJitter, retryAfterMilliseconds(headers)));
}

async function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
	await waitFor(milliseconds, undefined, { signal });
}

function transportErrorCode(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") return "ABORTED";
	if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
	return "TRANSPORT_ERROR";
}

function isRetryableTransportError(code: string): boolean {
	return code !== "ABORTED" && code !== "RESPONSE_TOO_LARGE";
}

async function projectSpend(projectRoot: string, currency: string): Promise<number | null> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Project schema is read-only");
	let amount = 0;
	// ponytail: O(n) ledger scan; add a derived cost index only when project benchmarks require it.
	for (const operationId of await listProjectRecordIds(opened.root, opened.manifest, "operation")) {
		const result = await readRecord(opened.root, "operation", operationId);
		if (!result.ok || result.value.kind !== "operation")
			throw new TypeError(`Invalid operation record: ${operationId}`);
		if (result.value.usage.cost.amount === 0) continue;
		if (result.value.usage.cost.currency !== currency) return null;
		amount += result.value.usage.cost.amount;
	}
	return amount;
}

async function commitOperationRunFile(
	projectRoot: string,
	operationId: string,
	stage: "request" | "response",
	content: string,
	approvalId: string | null,
	usageDelta: { networkRequests: number; cost: Money } | null,
	expectedManifestRevision?: number,
): Promise<FileRef> {
	return withPersistedRunningOperation(projectRoot, operationId, async (operation) => {
		if (stage === "request" ? operation.rawRequest !== null : operation.rawResponse !== null) {
			throw new Error(`Operation ${operationId} already has an HTTP ${stage} receipt`);
		}
		if (stage === "response" && operation.rawRequest === null) {
			throw new Error(`Operation ${operationId} has no HTTP request receipt`);
		}
		const opened = await openProject(projectRoot, expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Project schema is read-only");
		await mkdir(await resolveProjectPath(opened.root, `.research/runs/${operationId}`), { recursive: true });
		const path = `.research/runs/${operationId}/http-${stage}.json`;
		const fileRef: FileRef = {
			path,
			hash: hashBytes(content),
			mediaType: "application/json",
			bytes: Buffer.byteLength(content),
		};
		if (usageDelta !== null && operation.usage.cost.currency !== usageDelta.cost.currency) {
			throw new TypeError("Operation and HTTP cost currencies must match");
		}
		const now = new Date().toISOString();
		const candidate: OperationRecord = {
			...operation,
			rawRequest: stage === "request" ? fileRef : operation.rawRequest,
			rawResponse: stage === "response" ? fileRef : operation.rawResponse,
			approvalIds:
				approvalId === null ? operation.approvalIds : [...new Set([...operation.approvalIds, approvalId])],
			usage:
				usageDelta === null
					? operation.usage
					: {
							...operation.usage,
							networkRequests: operation.usage.networkRequests + usageDelta.networkRequests,
							cost: {
								amount: operation.usage.cost.amount + usageDelta.cost.amount,
								currency: usageDelta.cost.currency,
							},
						},
			audit: {
				...operation.audit,
				updatedAt: now,
				revision: operation.audit.revision + 1,
				updatedByOperationId: operationId,
			},
		};
		const validation = validatePersistedRecord(candidate);
		if (!validation.ok || validation.value.kind !== "operation") {
			throw new TypeError("HTTP receipt operation update is invalid");
		}
		const operationContent = `${canonicalStringify(validation.value)}\n`;
		const operationPath = projectRecordPath(opened.manifest, "operation", operationId);
		const operationIndex = await calculateRecordSetIndex(opened.root, opened.manifest, "operation", {
			id: operationId,
			hash: hashBytes(operationContent),
		});
		await commitProjectTransaction(opened.root, {
			expectedRevision: opened.manifest.revision,
			writes: [
				{ path, content, expectedHash: null },
				{
					path: operationPath,
					content: operationContent,
					expectedHash: await hashFile(await resolveProjectPath(opened.root, operationPath)),
				},
			],
			manifest: {
				...opened.manifest,
				recordSets: opened.manifest.recordSets.map((recordSet) =>
					recordSet.kind === "operation" ? { ...recordSet, ...operationIndex } : recordSet,
				),
				lastCommittedOperationId: operationId,
				updatedAt: now,
				revision: opened.manifest.revision + 1,
			},
		});
		return fileRef;
	});
}

function failureDetails(
	requestFile: FileRef,
	responseFile: FileRef,
	attempts: readonly HttpAttemptReceipt[],
	cost: Money,
): JsonValue {
	return {
		requestFile,
		responseFile,
		attempts: attempts.length,
		statusCode: attempts.at(-1)?.statusCode ?? null,
		headers: attempts.at(-1)?.headers ?? {},
		bodyBytes: attempts.at(-1)?.bodyBytes ?? null,
		actualCost: cost,
	};
}

function httpFailure(
	operationId: string,
	requestFile: FileRef,
	responseFile: FileRef,
	attempts: readonly HttpAttemptReceipt[],
	cost: Money,
): ResearchResult<HttpReceipt> {
	const last = attempts.at(-1);
	const details = failureDetails(requestFile, responseFile, attempts, cost);
	if (last?.errorCode === "ABORTED") {
		return failureResult(
			"PERMANENT_FAILURE",
			"HTTP_ABORTED",
			"cancelled",
			"HTTP request was aborted",
			operationId,
			details,
		);
	}
	if (last?.errorCode === "RESPONSE_TOO_LARGE") {
		return failureResult(
			"PERMANENT_FAILURE",
			"HTTP_RESPONSE_TOO_LARGE",
			"validation",
			"HTTP response exceeded the configured byte limit",
			operationId,
			details,
		);
	}
	if (last?.statusCode === null || last === undefined) {
		return failureResult(
			"RETRYABLE_FAILURE",
			"HTTP_TRANSPORT_FAILED",
			"network",
			"HTTP transport failed after permitted retries",
			operationId,
			details,
		);
	}
	if (last.statusCode === 408 || last.statusCode === 429 || last.statusCode >= 500) {
		return failureResult(
			"RETRYABLE_FAILURE",
			last.statusCode === 429 ? "HTTP_RATE_LIMITED" : "HTTP_RETRYABLE_STATUS",
			last.statusCode === 429 ? "rate_limit" : "external_service",
			`HTTP service returned retryable status ${last.statusCode}`,
			operationId,
			details,
		);
	}
	if (last.statusCode === 401 || last.statusCode === 403) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"HTTP_AUTHENTICATION_FAILED",
			"permission",
			`HTTP service rejected authentication with status ${last.statusCode}`,
			operationId,
			details,
		);
	}
	if (last.statusCode >= 300 && last.statusCode < 400) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"HTTP_REDIRECT_BLOCKED",
			"permission",
			"HTTP redirect requires a separately governed request",
			operationId,
			details,
		);
	}
	return failureResult(
		"PERMANENT_FAILURE",
		last.statusCode === 404 ? "HTTP_NOT_FOUND" : "HTTP_STATUS_FAILED",
		last.statusCode === 404 ? "not_found" : "external_service",
		`HTTP service returned status ${last.statusCode}`,
		operationId,
		details,
	);
}

export async function requestGovernedHttp(
	projectRoot: string,
	context: HttpBrokerContext,
	requestIntent: HttpRequestIntent,
	options: HttpBrokerOptions = {},
): Promise<ResearchResult<HttpReceipt>> {
	try {
		const intent = normalizeIntent(requestIntent);
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Project schema is read-only");
		if (hashCanonicalJson(opened.manifest.policy).value !== context.policySnapshotHash.value) {
			return failureResult(
				"DATA_CONFLICT",
				"POLICY_SNAPSHOT_CHANGED",
				"data_conflict",
				"Project policy changed before the HTTP request",
				context.operationId,
			);
		}
		const operationResult = await readRecord(opened.root, "operation", context.operationId);
		if (
			!operationResult.ok ||
			operationResult.value.kind !== "operation" ||
			operationResult.value.status !== "running"
		) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"OPERATION_NOT_RUNNING",
				"permission",
				`Operation ${context.operationId} is not persisted as running`,
				context.operationId,
			);
		}
		if (operationResult.value.rawRequest !== null || operationResult.value.rawResponse !== null) {
			return failureResult(
				"PERMANENT_FAILURE",
				"OPERATION_HTTP_ALREADY_RECORDED",
				"integrity",
				"Each Operation may execute one governed HTTP request",
				context.operationId,
			);
		}
		if (intent.paid && intent.estimatedCost === null) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"BUDGET_ESTIMATE_REQUIRED",
				"budget",
				"Paid HTTP requests require an explicit worst-case estimate",
				context.operationId,
			);
		}
		if (opened.manifest.policy.budgetHardLimit !== null && intent.estimatedCost !== null) {
			const limit = opened.manifest.policy.budgetHardLimit;
			if (limit.currency !== intent.estimatedCost.currency) {
				return failureResult(
					"PERMISSION_BLOCKED",
					"BUDGET_CURRENCY_MISMATCH",
					"budget",
					"HTTP estimate currency differs from the project hard limit",
					context.operationId,
				);
			}
			const spent = await projectSpend(opened.root, limit.currency);
			if (spent === null) {
				return failureResult(
					"PERMISSION_BLOCKED",
					"BUDGET_CURRENCY_MISMATCH",
					"budget",
					"Existing project spend uses a different currency from the hard limit",
					context.operationId,
				);
			}
			if (spent + intent.estimatedCost.amount > limit.amount) {
				return failureResult(
					"PERMISSION_BLOCKED",
					"BUDGET_LIMIT",
					"budget",
					"HTTP request would exceed the project hard limit",
					context.operationId,
					{ spent, estimate: intent.estimatedCost, limit },
				);
			}
		}
		const sendsSensitiveData =
			opened.manifest.policy.sensitivity === "restricted" ||
			intent.dataClasses.some((dataClass) => !dataClass.startsWith("public"));
		const actionRequest = createActionRequest({
			projectId: opened.manifest.projectId,
			operationId: context.operationId,
			sessionId: context.sessionId,
			actionClass: sendsSensitiveData
				? "sensitive_egress"
				: intent.paid
					? "paid_service_call"
					: "public_network_read",
			actionName: "http.request",
			destination: new URL(intent.url).origin,
			paths: [],
			dataClasses: intent.dataClasses,
			estimatedCost: intent.estimatedCost,
			destructive: false,
			recoverable: true,
			fingerprintParameters: {
				method: intent.method,
				url: intent.url,
				headers: intent.headers,
				bodyHash: intent.body === null ? null : hashBytes(intent.body),
				credential:
					intent.credential === null
						? null
						: {
								alias: intent.credential.alias,
								placement: {
									kind: intent.credential.placement.kind,
									name: intent.credential.placement.name,
									prefix: intent.credential.placement.prefix,
								},
							},
				idempotencyKey: intent.idempotencyKey,
				maxAttempts: intent.maxAttempts,
				costPerRequest: intent.costPerRequest,
			},
			policy: opened.manifest.policy,
		});
		const evaluation = evaluateActionPolicy(
			opened.manifest.policy,
			actionRequest,
			await readApprovalRecords(opened.root, opened.manifest),
		);
		if (evaluation.decision !== "allow") {
			return failureResult(
				"PERMISSION_BLOCKED",
				evaluation.decision === "deny" ? "ACTION_DENIED" : "APPROVAL_REQUIRED",
				"permission",
				evaluation.reason,
				context.operationId,
				{
					actionClass: actionRequest.actionClass,
					actionName: actionRequest.actionName,
					actionFingerprint: actionRequest.actionFingerprint,
					destination: actionRequest.destination,
					dataClasses: actionRequest.dataClasses,
					estimatedCost: actionRequest.estimatedCost,
				},
			);
		}

		const transportUrl = new URL(intent.url);
		const transportHeaders = new Headers(intent.headers);
		if (intent.credential !== null) {
			if (options.resolveCredential === undefined) {
				return failureResult(
					"PERMISSION_BLOCKED",
					"CREDENTIAL_UNAVAILABLE",
					"permission",
					`Credential alias is unavailable: ${intent.credential.alias}`,
					context.operationId,
				);
			}
			let secret: string;
			try {
				secret = await options.resolveCredential(intent.credential.alias, context.signal);
			} catch {
				return failureResult(
					"PERMISSION_BLOCKED",
					"CREDENTIAL_UNAVAILABLE",
					"permission",
					`Credential alias is unavailable: ${intent.credential.alias}`,
					context.operationId,
				);
			}
			if (secret.length === 0 || /[\r\n]/.test(secret)) throw new TypeError("Resolved HTTP credential is invalid");
			const value = `${intent.credential.placement.prefix}${secret}`;
			if (intent.credential.placement.kind === "header") {
				transportHeaders.set(intent.credential.placement.name, value);
			} else {
				transportUrl.searchParams.set(intent.credential.placement.name, value);
			}
		}
		const requestContent = `${canonicalStringify({
			version: 1,
			operationId: context.operationId,
			method: intent.method,
			url: intent.url,
			headers: intent.headers,
			body: intent.body,
			credential: intent.credential,
			dataClasses: intent.dataClasses,
			paid: intent.paid,
			estimatedCost: intent.estimatedCost,
			costPerRequest: intent.costPerRequest,
			maxAttempts: intent.maxAttempts,
			idempotencyKey: intent.idempotencyKey,
			responseBody: intent.responseBody,
			maxResponseBytes: intent.maxResponseBytes,
			createdAt: new Date().toISOString(),
		})}\n`;
		const requestFile = await commitOperationRunFile(
			opened.root,
			context.operationId,
			"request",
			requestContent,
			evaluation.approvalId,
			null,
			opened.manifest.revision,
		);

		const attempts: HttpAttemptReceipt[] = [];
		const transport = options.transport ?? fetchHttpTransport;
		const wait = options.wait ?? defaultWait;
		const random = options.random ?? Math.random;
		let networkRequests = 0;
		for (let attempt = 1; attempt <= intent.maxAttempts && !context.signal.aborted; attempt += 1) {
			try {
				networkRequests += 1;
				const response = await transport({
					method: intent.method,
					url: transportUrl.toString(),
					headers: Object.fromEntries(transportHeaders.entries()),
					body: intent.body,
					responseBody: intent.responseBody,
					maxResponseBytes: intent.maxResponseBytes,
					signal: context.signal,
				});
				const retryable = isRetryableStatus(response.status);
				attempts.push({
					attempt,
					statusCode: response.status,
					headers: recordedHeaders(response.headers),
					body: response.body,
					bodyBytes: response.bodyBytes,
					errorCode: null,
					retryable,
				});
				if ((response.status >= 200 && response.status < 300) || !retryable || attempt === intent.maxAttempts)
					break;
				await wait(retryDelay(attempt, response.headers, random), context.signal);
			} catch (error) {
				const errorCode = context.signal.aborted ? "ABORTED" : transportErrorCode(error);
				const retryable = isRetryableTransportError(errorCode);
				attempts.push({
					attempt,
					statusCode: null,
					headers: {},
					body: null,
					bodyBytes: null,
					errorCode,
					retryable,
				});
				if (!retryable || attempt === intent.maxAttempts) break;
				try {
					await wait(retryDelay(attempt, {}, random), context.signal);
				} catch {
					break;
				}
			}
		}
		if (context.signal.aborted && attempts.at(-1)?.errorCode !== "ABORTED") {
			attempts.push({
				attempt: attempts.length + 1,
				statusCode: null,
				headers: {},
				body: null,
				bodyBytes: null,
				errorCode: "ABORTED",
				retryable: false,
			});
		}
		const actualCost: Money = {
			amount: intent.costPerRequest.amount * networkRequests,
			currency: intent.costPerRequest.currency,
		};
		const finalAttempt = attempts.at(-1) ?? null;
		const responseContent = `${canonicalStringify({
			version: 1,
			operationId: context.operationId,
			bodyEncoding: intent.responseBody,
			attempts,
			networkRequests,
			actualCost,
			finishedAt: new Date().toISOString(),
		})}\n`;
		const responseFile = await commitOperationRunFile(
			opened.root,
			context.operationId,
			"response",
			responseContent,
			null,
			{ networkRequests, cost: actualCost },
		);
		if (
			finalAttempt?.statusCode === null ||
			finalAttempt === null ||
			finalAttempt.statusCode < 200 ||
			finalAttempt.statusCode >= 300
		) {
			return httpFailure(context.operationId, requestFile, responseFile, attempts, actualCost);
		}
		return successResult(
			{
				requestFile,
				responseFile,
				statusCode: finalAttempt.statusCode,
				headers: finalAttempt.headers,
				body: finalAttempt.body ?? "",
				bodyEncoding: intent.responseBody,
				bodyBytes: finalAttempt.bodyBytes ?? 0,
				attempts: attempts.length,
				networkRequests,
				actualCost,
				approvalId: evaluation.approvalId,
			},
			context.operationId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("DATA_CONFLICT:") || message.startsWith("Transaction target hash mismatch")) {
			return failureResult("DATA_CONFLICT", "HTTP_RECEIPT_CONFLICT", "data_conflict", message, context.operationId);
		}
		if (message.includes("not persisted as running")) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"OPERATION_NOT_RUNNING",
				"permission",
				message,
				context.operationId,
			);
		}
		return failureResult(
			"PERMANENT_FAILURE",
			error instanceof TypeError ? "HTTP_REQUEST_INVALID" : "HTTP_BROKER_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			message,
			context.operationId,
		);
	}
}
