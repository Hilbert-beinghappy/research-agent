// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { UnpaywallAdapter } from "../adapters/document/unpaywall.ts";
import type { AdapterContext, SourceAdapter } from "../adapters/source/contract.ts";
import { CrossrefAdapter } from "../adapters/source/crossref.ts";
import { OpenAlexAdapter } from "../adapters/source/openalex.ts";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type ActionClass,
	type ApprovalRecord,
	type FileRef,
	type JsonValue,
	type Money,
	type OperationRecord,
	RESEARCH_SCHEMA_VERSION,
	type RecordRef,
	type ResearchError,
	type ResearchResult,
	type SemanticProvenance,
	type SessionLink,
	type SourceRecord,
} from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { type FailureStatus, failureResult, successResult } from "../kernel/results.ts";
import { type OpenedProject, openProject } from "../project/open.ts";
import {
	listProjectRecordIds,
	type ProjectRecord,
	projectRecordId,
	projectRecordRevision,
} from "../project/record-index.ts";
import { createRecord, readRecord, updateRecord } from "../project/records.ts";
import { readApprovalRecords } from "../security/approval.ts";
import {
	type HttpBrokerOptions,
	type HttpReceipt,
	type HttpRequestIntent,
	requestGovernedHttp,
} from "../security/broker-http.ts";
import { type ActionRequest, evaluateActionPolicy } from "../security/policy.ts";
import { finishOperation, type StartOperationInput, startOperation } from "../tools/operations.ts";
import { CommitEvidenceParameters } from "./tool-schemas.ts";

export type CurrentProject = Extract<OpenedProject, { compatibility: "current" }>;

export const RESEARCH_TOOL_NAMES = [
	"research_search_sources",
	"research_import_sources",
	"research_documents",
	"research_query_corpus",
	"research_commit_evidence",
	"research_verify_citations",
	"research_artifacts",
	"research_knowledge",
	"research_monitor",
	"research_design",
	"research_analysis",
	"research_qualitative",
	"research_manuscript",
	"research_review",
] as const;

export interface ToolOutcome<Value> {
	result: ResearchResult<Value>;
	outputs?: RecordRef[];
	outputFiles?: FileRef[];
}

export interface RegisterResearchToolsOptions {
	version: string;
	requireProject(ctx: ExtensionContext): Promise<CurrentProject>;
	appendProjectLink(project: CurrentProject): void;
	http?: HttpBrokerOptions;
	credentialAliases?: {
		crossrefMailto?: string;
		openalexApiKey?: string;
		unpaywallEmail?: string;
	};
}

export function toolResponse<Value>(result: ResearchResult<Value>): AgentToolResult<ResearchResult<Value>> {
	return {
		content: [{ type: "text", text: canonicalStringify(result as unknown as JsonValue) }],
		details: result,
	};
}

export function jsonValue(value: unknown): JsonValue {
	return canonicalizeJson(value);
}

export function jsonResult<Value>(result: ResearchResult<Value>): ResearchResult<JsonValue> {
	return result.ok ? { ...result, value: jsonValue(result.value) } : result;
}

export function withoutOperation<Value>(result: ResearchResult<Value>): ResearchResult<Value> {
	if (result.ok && result.status === "SUCCESS") return successResult(result.value, null);
	const [first, ...rest] = result.errors;
	const errors = [{ ...first, operationId: null }, ...rest.map((error) => ({ ...error, operationId: null }))] as [
		ResearchError,
		...ResearchError[],
	];
	return result.ok
		? { ...result, errors, meta: { ...result.meta, operationId: null } }
		: { ...result, errors, meta: { ...result.meta, operationId: null } };
}

function sessionLink(ctx: ExtensionContext): SessionLink {
	return {
		piSessionId: ctx.sessionManager.getSessionId(),
		piSessionFileHash: null,
		linkedAt: new Date().toISOString(),
		firstEntryId: null,
		lastEntryId: null,
	};
}

export function modelSemanticProvenance(
	ctx: ExtensionContext,
	toolCallId: string,
	params: Static<typeof CommitEvidenceParameters>,
	operationId: string,
): ResearchResult<SemanticProvenance> {
	if (ctx.model === undefined) {
		return failureResult(
			"PERMANENT_FAILURE",
			"MODEL_PROVENANCE_UNAVAILABLE",
			"integrity",
			"Current model identity is unavailable",
			operationId,
		);
	}
	const entries = ctx.sessionManager.buildContextEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const call = entry.message.content.find(
			(content) =>
				content.type === "toolCall" && content.id === toolCallId && content.name === "research_commit_evidence",
		);
		if (call?.type !== "toolCall") continue;
		if (
			entry.message.provider !== ctx.model.provider ||
			entry.message.model !== ctx.model.id ||
			canonicalStringify(call.arguments) !== canonicalStringify(params)
		) {
			break;
		}
		const publicToolSchema = JSON.parse(JSON.stringify(CommitEvidenceParameters)) as unknown;
		return successResult(
			{
				method: "model_suggested",
				operationId,
				modelProvider: entry.message.provider,
				modelId: entry.message.responseModel ?? entry.message.model,
				promptHash: hashCanonicalJson(
					jsonValue({ systemPrompt: ctx.getSystemPrompt(), entries: entries.slice(0, index) }),
				),
				toolSchemaHash: hashCanonicalJson(
					jsonValue({ name: "research_commit_evidence", parameters: publicToolSchema }),
				),
				turnId: entry.id,
			},
			operationId,
		);
	}
	return failureResult(
		"PERMANENT_FAILURE",
		"MODEL_PROVENANCE_UNAVAILABLE",
		"integrity",
		"The current persisted model tool-call turn could not be verified",
		operationId,
	);
}

export function authorizeModelVisiblePayload(
	project: CurrentProject,
	ctx: ExtensionContext,
	dataClasses: readonly string[],
	message: string,
): ResearchResult<never> | null {
	if (ctx.model === undefined) {
		return failureResult(
			"PERMANENT_FAILURE",
			"MODEL_PROVENANCE_UNAVAILABLE",
			"integrity",
			"Current model identity is unavailable",
			null,
		);
	}
	if (modelUsesLocalEndpoint(ctx.model)) return null;
	const policy = project.manifest.policy;
	if (
		!policy.modelEgressAllowed ||
		(policy.allowedModelProviders.length > 0 && !policy.allowedModelProviders.includes(ctx.model.provider)) ||
		(policy.allowedDataClassesForModelEgress.length > 0 &&
			dataClasses.some((dataClass) => !policy.allowedDataClassesForModelEgress.includes(dataClass)))
	) {
		return failureResult("PERMISSION_BLOCKED", "MODEL_EGRESS_DENIED", "permission", message, null);
	}
	return null;
}

export function modelUsesLocalEndpoint(model: ExtensionContext["model"]): boolean {
	if (model === undefined) return false;
	try {
		const { hostname, protocol } = new URL(model.baseUrl);
		if (protocol !== "http:" && protocol !== "https:") return false;
		const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
		return (
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host === "::1" ||
			(isIP(host) === 4 && host.startsWith("127."))
		);
	} catch {
		return false;
	}
}

export function thrownFailure<Value>(error: unknown, operationId: string | null): ResearchResult<Value> {
	return failureResult(
		"PERMANENT_FAILURE",
		error instanceof TypeError ? "RESEARCH_TOOL_INVALID" : "RESEARCH_TOOL_FAILED",
		error instanceof TypeError ? "validation" : "runtime",
		error instanceof Error ? error.message : "Research tool failed",
		operationId,
	);
}

export function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

export async function trackedTool<Value>(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	name: string,
	effect: (operation: OperationRecord) => Promise<ToolOutcome<Value>>,
	inputs: RecordRef[] = [],
	inputFiles: FileRef[] = [],
	implementationVersion = options.version,
): Promise<ResearchResult<Value>> {
	const started = await startOperation(project.root, {
		operationKind: "tool",
		name,
		implementationVersion,
		session: sessionLink(ctx),
		inputs,
		inputFiles,
	});
	if (!started.ok) return started;
	let outcome: ToolOutcome<Value>;
	try {
		outcome = await effect(started.value);
	} catch (error) {
		outcome = { result: thrownFailure(error, started.value.operationId) };
	}
	const finished = await finishOperation(
		project.root,
		started.value.operationId,
		outcome.result,
		outcome.outputs,
		outcome.outputFiles,
	);
	if (!finished.ok) return finished;
	const reopened = await openProject(project.root);
	if (reopened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"RESEARCH_PROJECT_READ_ONLY",
			"migration",
			"Research project schema became read-only",
			started.value.operationId,
		);
	}
	options.appendProjectLink(reopened);
	return { ...outcome.result, meta: { ...outcome.result.meta, operationId: started.value.operationId } };
}

export function objectValue(value: JsonValue, label: string): { [key: string]: JsonValue } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
	return value;
}

export function moneyValue(value: JsonValue): Money | null {
	if (value === null) return null;
	const money = objectValue(value, "Approval cost");
	return typeof money.amount === "number" && Number.isFinite(money.amount) && typeof money.currency === "string"
		? { amount: money.amount, currency: money.currency }
		: null;
}

const ACTION_CLASSES = new Set<ActionClass>([
	"local_read",
	"project_create",
	"project_append",
	"project_overwrite",
	"destructive_file_action",
	"public_network_read",
	"paid_service_call",
	"external_write",
	"sensitive_egress",
	"unknown_script_execution",
	"dependency_install",
	"commercial_runtime",
	"publish_or_submit",
]);

export async function linkApprovalToOperation(
	projectRoot: string,
	operationId: string,
	approvalId: string,
): Promise<ResearchResult<OperationRecord>> {
	const current = await readRecord(projectRoot, "operation", operationId);
	if (!current.ok) return propagatedFailure(current, operationId);
	if (current.value.kind !== "operation" || current.value.status !== "running") {
		return failureResult(
			"PERMANENT_FAILURE",
			"APPROVAL_OPERATION_INVALID",
			"integrity",
			`Operation ${operationId} is not running`,
			operationId,
		);
	}
	if (current.value.approvalIds.includes(approvalId)) return successResult(current.value, operationId);
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"APPROVAL_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const updated = await updateRecord(projectRoot, "operation", operationId, {
		expectedManifestRevision: opened.manifest.revision,
		expectedRecordRevision: current.value.audit.revision,
		operationId,
		changes: { approvalIds: [...current.value.approvalIds, approvalId] },
	});
	if (!updated.ok) return propagatedFailure(updated, operationId);
	const stored = await readRecord(projectRoot, "operation", operationId);
	if (!stored.ok) return propagatedFailure(stored, operationId);
	return stored.value.kind === "operation"
		? successResult(stored.value, operationId)
		: failureResult(
				"PERMANENT_FAILURE",
				"APPROVAL_OPERATION_READBACK_INVALID",
				"integrity",
				`Operation ${operationId} could not be read back after approval`,
				operationId,
			);
}

export async function approveAction(
	projectRoot: string,
	operationId: string,
	ctx: ExtensionContext,
	request: ActionRequest,
	title: string,
	message: string,
	recordRefs: RecordRef[],
	fileRefs: FileRef[],
): Promise<ResearchResult<string>> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"APPROVAL_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const evaluation = evaluateActionPolicy(
		opened.manifest.policy,
		request,
		await readApprovalRecords(opened.root, opened.manifest),
	);
	if (evaluation.decision === "deny") {
		return failureResult("PERMISSION_BLOCKED", "ACTION_DENIED", "permission", evaluation.reason, operationId);
	}
	if (evaluation.decision === "allow" && evaluation.approvalId !== null) {
		const linked = await linkApprovalToOperation(opened.root, operationId, evaluation.approvalId);
		return linked.ok ? successResult(evaluation.approvalId, operationId) : propagatedFailure(linked, operationId);
	}
	if (evaluation.decision === "allow") {
		return failureResult(
			"PERMANENT_FAILURE",
			"APPROVAL_POLICY_MISMATCH",
			"integrity",
			"Action expected an approval but project policy returned an unscoped allow",
			operationId,
		);
	}
	if (!ctx.hasUI) {
		return failureResult("PERMISSION_BLOCKED", "APPROVAL_REQUIRED", "permission", message, operationId, {
			actionClass: request.actionClass,
			actionName: request.actionName,
			paths: request.paths,
		});
	}
	const approved = await ctx.ui.confirm(title, message);
	const current = await openProject(opened.root);
	if (current.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"APPROVAL_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	if (hashCanonicalJson(current.manifest.policy).value !== request.policySnapshotHash.value) {
		return failureResult(
			"DATA_CONFLICT",
			"APPROVAL_POLICY_CHANGED",
			"data_conflict",
			"Project policy changed while approval was pending",
			operationId,
		);
	}
	const now = new Date().toISOString();
	const approvalId = createOpaqueId("approval");
	const approval: ApprovalRecord = {
		kind: "approval",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		approvalId,
		taskId: null,
		operationId,
		actionClass: request.actionClass,
		actionName: request.actionName,
		impactScope: [...request.paths],
		estimatedCost: request.estimatedCost,
		dataEgress: {
			destination: request.destination,
			dataClasses: [...request.dataClasses],
			fileRefs,
			recordRefs,
		},
		overwriteRisk: {
			paths: [...request.paths],
			destructive: request.destructive,
			recoverable: request.recoverable,
		},
		requestMessage: message,
		requestedAt: now,
		policySnapshotHash: request.policySnapshotHash,
		decision: approved ? "approved" : "denied",
		scope: "once",
		scopeTarget: {
			projectId: request.projectId,
			sessionId: request.sessionId,
			actionFingerprint: request.actionFingerprint,
			destinationPattern: request.destination,
			pathPatterns: [...request.paths],
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
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const created = await createRecord(current.root, approval, {
		expectedManifestRevision: current.manifest.revision,
		operationId,
	});
	if (!created.ok) return propagatedFailure(created, operationId);
	const linked = await linkApprovalToOperation(current.root, operationId, approvalId);
	if (!linked.ok) return propagatedFailure(linked, operationId);
	return approved
		? successResult(approvalId, operationId)
		: failureResult("PERMISSION_BLOCKED", "ACTION_DENIED", "permission", "User denied the action", operationId, {
				approvalId,
			});
}

export async function recordHttpApproval(
	projectRoot: string,
	operationId: string,
	ctx: ExtensionContext,
	details: JsonValue,
): Promise<ResearchResult<ApprovalRecord>> {
	const value = objectValue(details, "Approval request");
	const actionClass = value.actionClass;
	const actionName = value.actionName;
	const actionFingerprint = value.actionFingerprint;
	const destination = value.destination;
	const dataClasses = value.dataClasses;
	if (
		typeof actionClass !== "string" ||
		!ACTION_CLASSES.has(actionClass as ActionClass) ||
		typeof actionName !== "string" ||
		typeof actionFingerprint !== "string" ||
		(destination !== null && typeof destination !== "string") ||
		!Array.isArray(dataClasses) ||
		dataClasses.some((entry) => typeof entry !== "string")
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"APPROVAL_REQUEST_INVALID",
			"integrity",
			"HTTP broker returned an invalid approval request",
			operationId,
		);
	}
	if (!ctx.hasUI) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"APPROVAL_REQUIRED",
			"permission",
			"This HTTP request requires interactive approval",
			operationId,
			details,
		);
	}
	const approved = await ctx.ui.confirm(
		"Approve research service request",
		`Allow ${actionName} to ${destination ?? "the configured destination"}?`,
	);
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"APPROVAL_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const now = new Date().toISOString();
	const approvalId = createOpaqueId("approval");
	const approval: ApprovalRecord = {
		kind: "approval",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		approvalId,
		taskId: null,
		operationId,
		actionClass: actionClass as ActionClass,
		actionName,
		impactScope: destination === null ? [] : [destination],
		estimatedCost: moneyValue(value.estimatedCost ?? null),
		dataEgress: {
			destination,
			dataClasses: dataClasses as string[],
			fileRefs: [],
			recordRefs: [],
		},
		overwriteRisk: { paths: [], destructive: false, recoverable: true },
		requestMessage: `Allow ${actionName} to ${destination ?? "the configured destination"}`,
		requestedAt: now,
		policySnapshotHash: hashCanonicalJson(opened.manifest.policy),
		decision: approved ? "approved" : "denied",
		scope: "once",
		scopeTarget: {
			projectId: opened.manifest.projectId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionFingerprint,
			destinationPattern: destination,
			pathPatterns: [],
			maxApprovedCost: moneyValue(value.estimatedCost ?? null),
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
	const created = await createRecord(projectRoot, approval, {
		expectedManifestRevision: opened.manifest.revision,
		operationId,
	});
	if (!created.ok) return propagatedFailure(created, operationId);
	const linked = await linkApprovalToOperation(projectRoot, operationId, approvalId);
	if (!linked.ok) return propagatedFailure(linked, operationId);
	return approved
		? successResult(approval, operationId)
		: failureResult(
				"PERMISSION_BLOCKED",
				"ACTION_DENIED",
				"permission",
				"User denied the HTTP request",
				operationId,
				{ approvalId },
			);
}

export function defaultHttpOptions(options: RegisterResearchToolsOptions): HttpBrokerOptions {
	return {
		...options.http,
		resolveCredential:
			options.http?.resolveCredential ??
			(async (alias) => {
				const value = process.env[alias];
				if (value === undefined || value.length === 0) throw new Error(`Credential alias is unavailable: ${alias}`);
				return value;
			}),
	};
}

export async function governedRequest(
	projectRoot: string,
	operationId: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	intent: HttpRequestIntent,
	http: HttpBrokerOptions,
): Promise<ResearchResult<HttpReceipt>> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"HTTP_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const context = {
		operationId,
		sessionId: ctx.sessionManager.getSessionId(),
		policySnapshotHash: hashCanonicalJson(opened.manifest.policy),
		signal,
	};
	const first = await requestGovernedHttp(opened.root, context, intent, http);
	if (first.ok || first.errors[0].code !== "APPROVAL_REQUIRED") return first;
	const approval = await recordHttpApproval(opened.root, operationId, ctx, first.errors[0].details);
	if (!approval.ok) return approval;
	return requestGovernedHttp(opened.root, context, intent, http);
}

export async function childOperation<Value>(
	project: CurrentProject,
	ctx: ExtensionContext,
	input: Omit<StartOperationInput, "session">,
	effect: (operation: OperationRecord) => Promise<ToolOutcome<Value>>,
): Promise<{ operationId: string; result: ResearchResult<Value> }> {
	const started = await startOperation(project.root, { ...input, session: sessionLink(ctx) });
	if (!started.ok) return { operationId: started.meta.operationId ?? "", result: started };
	let outcome: ToolOutcome<Value>;
	try {
		outcome = await effect(started.value);
	} catch (error) {
		outcome = { result: thrownFailure(error, started.value.operationId) };
	}
	const finished = await finishOperation(
		project.root,
		started.value.operationId,
		outcome.result,
		outcome.outputs,
		outcome.outputFiles,
	);
	return {
		operationId: started.value.operationId,
		result: finished.ok
			? { ...outcome.result, meta: { ...outcome.result.meta, operationId: started.value.operationId } }
			: finished,
	};
}

export async function adapterOperation<Value>(
	project: CurrentProject,
	ctx: ExtensionContext,
	adapter: SourceAdapter | UnpaywallAdapter,
	capability: string,
	inputs: RecordRef[],
	signal: AbortSignal,
	http: HttpBrokerOptions,
	effect: (context: AdapterContext) => Promise<ResearchResult<Value>>,
	prepareIntent: ((intent: HttpRequestIntent) => HttpRequestIntent | null) | null = null,
): Promise<{ operationId: string; result: ResearchResult<Value> }> {
	const capabilities = await adapter.capabilities();
	return childOperation(
		project,
		ctx,
		{
			operationKind: "adapter",
			name: `${capabilities.adapterId}.${capability}`,
			implementationVersion: capabilities.adapterVersion,
			inputs,
			adapter: {
				adapterId: capabilities.adapterId,
				adapterVersion: capabilities.adapterVersion,
				capabilitySnapshotHash: hashCanonicalJson(capabilities),
			},
		},
		async (operation) => {
			const opened = await openProject(project.root);
			if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
			const result = await effect({
				projectId: opened.manifest.projectId,
				taskId: operation.taskId ?? operation.operationId,
				operationId: operation.operationId,
				policySnapshotHash: hashCanonicalJson(opened.manifest.policy),
				signal,
				brokers: {
					requestHttp: (intent) => {
						const prepared = prepareIntent === null ? intent : prepareIntent(intent);
						return prepared === null
							? Promise.resolve(
									failureResult(
										"PERMISSION_BLOCKED",
										"REQUEST_BUDGET_EXHAUSTED",
										"budget",
										"Research request budget is exhausted",
										operation.operationId,
									),
								)
							: governedRequest(opened.root, operation.operationId, ctx, signal, prepared, http);
					},
				},
			});
			return { result };
		},
	);
}

export function configuredAlias(explicit: string | undefined, environmentName: string): string | null {
	if (explicit !== undefined) return explicit;
	const value = process.env[environmentName];
	return value === undefined || value.length === 0 ? null : environmentName;
}

export function sourceAdapter(
	id: "crossref" | "openalex",
	options: RegisterResearchToolsOptions,
): CrossrefAdapter | OpenAlexAdapter {
	return id === "crossref"
		? new CrossrefAdapter(configuredAlias(options.credentialAliases?.crossrefMailto, "CROSSREF_MAILTO"))
		: new OpenAlexAdapter(configuredAlias(options.credentialAliases?.openalexApiKey, "OPENALEX_API_KEY"));
}

export async function sourcesByQueryHash(
	projectRoot: string,
	adapterId: string,
	queryHash: string,
): Promise<Array<{ source: SourceRecord; rawResponses: FileRef[] }>> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const matches: Array<{ source: SourceRecord; rawResponses: FileRef[] }> = [];
	for (const sourceId of await listProjectRecordIds(opened.root, opened.manifest, "source")) {
		const result = await readRecord(projectRoot, "source", sourceId);
		if (!result.ok || result.value.kind !== "source") throw new TypeError(`Invalid source record: ${sourceId}`);
		const discoveries = result.value.discovery.filter(
			(discovery) => discovery.adapterId === adapterId && discovery.queryHash?.value === queryHash,
		);
		if (discoveries.length > 0) {
			matches.push({ source: result.value, rawResponses: discoveries.map(({ rawRecord }) => rawRecord) });
		}
	}
	return matches.sort((left, right) => left.source.sourceId.localeCompare(right.source.sourceId));
}

export interface SearchRunSummary {
	queryId: string;
	adapterId: "crossref" | "openalex";
	status: "cached" | "succeeded" | "partially_succeeded" | "failed" | "budget_exhausted";
	resultCount: number;
	sourceIds: string[];
	rawResponses: FileRef[];
	operationIds: string[];
	requestCount: number;
	costUsd: number;
	candidateIds: string[];
}

export interface SearchSourcesValue {
	queryPlanId: string;
	runs: SearchRunSummary[];
	createdSourceIds: string[];
	reusedSourceIds: string[];
	rejected: JsonValue[];
	possibleDuplicates: JsonValue[];
	rawResponses: FileRef[];
	requestCount: number;
	cost: Money;
}

export function researchResult<Value>(
	value: Value,
	operationId: string,
	errors: ResearchError[],
	succeeded: boolean,
): ResearchResult<Value> {
	if (errors.length === 0) return successResult(value, operationId);
	if (succeeded) {
		return {
			ok: true,
			status: "PARTIAL_SUCCESS",
			value,
			errors,
			meta: { operationId, taskId: null, warnings: errors.map(({ message }) => message) },
		};
	}
	const status: FailureStatus = errors.some(({ retryable }) => retryable)
		? "RETRYABLE_FAILURE"
		: errors.some(({ category }) => category === "data_conflict")
			? "DATA_CONFLICT"
			: errors.some(({ category }) => category === "permission" || category === "budget")
				? "PERMISSION_BLOCKED"
				: errors.some(
							({ category }) =>
								category === "external_service" || category === "network" || category === "rate_limit",
						)
					? "EXTERNAL_SERVICE_FAILURE"
					: "PERMANENT_FAILURE";
	return {
		ok: false,
		status,
		value: null,
		errors,
		meta: { operationId, taskId: null, warnings: [] },
	};
}

export function withAdditionalErrors<Value>(
	result: ResearchResult<Value>,
	additional: readonly ResearchError[],
): ResearchResult<Value> {
	if (additional.length === 0) return result;
	const errors = [...additional, ...result.errors] as [ResearchError, ...ResearchError[]];
	const warnings = [...new Set([...result.meta.warnings, ...additional.map(({ message }) => message)])];
	return result.ok
		? { ok: true, status: "PARTIAL_SUCCESS", value: result.value, errors, meta: { ...result.meta, warnings } }
		: { ...result, errors, meta: { ...result.meta, warnings } };
}

export async function sourceRecord(
	projectRoot: string,
	sourceId: string,
	operationId: string,
): Promise<ResearchResult<SourceRecord>> {
	const result = await readRecord(projectRoot, "source", sourceId);
	if (!result.ok) return propagatedFailure(result, operationId);
	return result.value.kind === "source"
		? successResult(result.value, operationId)
		: failureResult(
				"PERMANENT_FAILURE",
				"SOURCE_RECORD_INVALID",
				"integrity",
				`Record ${sourceId} is not a source`,
				operationId,
			);
}

function fileKey(file: FileRef): string {
	return `${file.path}:${file.hash?.value ?? ""}:${file.mediaType ?? ""}:${file.bytes ?? ""}`;
}

export async function addOperationInputs(
	projectRoot: string,
	operationId: string,
	inputs: readonly RecordRef[],
	inputFiles: readonly FileRef[],
): Promise<ResearchResult<OperationRecord>> {
	const current = await readRecord(projectRoot, "operation", operationId);
	if (!current.ok) return propagatedFailure(current, operationId);
	if (current.value.kind !== "operation" || current.value.status !== "running") {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_OPERATION_NOT_RUNNING",
			"validation",
			`Operation ${operationId} is not running`,
			operationId,
		);
	}
	const mergedInputs = [
		...new Map(
			[...current.value.inputs, ...inputs].map((ref) => [`${ref.kind}:${ref.id}:${ref.revision}`, ref]),
		).values(),
	];
	const mergedFiles = [
		...new Map([...current.value.inputFiles, ...inputFiles].map((file) => [fileKey(file), file])).values(),
	];
	if (mergedInputs.length === current.value.inputs.length && mergedFiles.length === current.value.inputFiles.length) {
		return successResult(current.value, operationId);
	}
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const updated = await updateRecord(projectRoot, "operation", operationId, {
		expectedManifestRevision: opened.manifest.revision,
		expectedRecordRevision: current.value.audit.revision,
		operationId,
		changes: { inputs: mergedInputs, inputFiles: mergedFiles },
	});
	if (!updated.ok) return propagatedFailure(updated, operationId);
	const stored = await readRecord(projectRoot, "operation", operationId);
	return stored.ok && stored.value.kind === "operation"
		? successResult(stored.value, operationId)
		: failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_OPERATION_READBACK_INVALID",
				"integrity",
				"Updated evidence operation could not be read back",
				operationId,
			);
}

export async function resolveRecordInputs(projectRoot: string, refs: readonly RecordRef[]): Promise<RecordRef[]> {
	const resolved: RecordRef[] = [];
	for (const ref of refs) {
		const result = await readRecord(projectRoot, ref.kind, ref.id);
		if (!result.ok) throw new TypeError(result.errors[0].message);
		const revision = projectRecordRevision(result.value);
		if (ref.revision !== null && revision < ref.revision) {
			throw new TypeError(`Record input references future ${ref.kind} ${ref.id} revision ${ref.revision}`);
		}
		resolved.push({ ...ref, revision: ref.revision ?? revision });
	}
	return [...new Map(resolved.map((ref) => [`${ref.kind}:${ref.id}:${ref.revision}`, ref])).values()];
}

export function recordReference(record: ProjectRecord): RecordRef {
	return { kind: record.kind, id: projectRecordId(record), revision: projectRecordRevision(record) };
}

export function unavailableToolResult<Value>(error: unknown): AgentToolResult<ResearchResult<Value>> {
	return toolResponse(thrownFailure<Value>(error, null));
}
