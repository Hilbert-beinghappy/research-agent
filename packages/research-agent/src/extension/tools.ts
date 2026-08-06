// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { UnpaywallAdapter } from "../adapters/document/unpaywall.ts";
import { fetchHttpTransport } from "../adapters/http/transport.ts";
import type { RawImportFile } from "../adapters/import/local.ts";
import type { AdapterContext, SourceAdapter } from "../adapters/source/contract.ts";
import { CrossrefAdapter } from "../adapters/source/crossref.ts";
import { OpenAlexAdapter } from "../adapters/source/openalex.ts";
import { CITATION_VERIFIER_VERSION } from "../citations/verify.ts";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type ActionClass,
	type ApprovalRecord,
	type ArtifactRecord,
	type CitationVerification,
	type ClaimRecord,
	ClaimRecordSchema,
	ConceptRecordSchema,
	DesignBasisSchema,
	DesignDecisionSchema,
	DesignProvenanceRefSchema,
	type DocumentRecord,
	type EvidenceCard,
	EvidenceCardSchema,
	type FileRef,
	type JsonValue,
	JsonValueSchema,
	type Money,
	type OperationRecord,
	ProtocolRecordSchema,
	RESEARCH_SCHEMA_VERSION,
	type RecordRef,
	RecordRefSchema,
	type ResearchError,
	ResearchQuestionVersionSchema,
	type ResearchResult,
	type SessionLink,
	type SourceRecord,
	TheoryRelationSchema,
} from "../contracts/schemas.ts";
import { locateSourceDocument } from "../documents/locate.ts";
import { type EvidenceCardDraft, evidenceFingerprint, validateEvidenceCardDraft } from "../evidence/commit.ts";
import { queryCorpusRecords } from "../evidence/query.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { type FailureStatus, failureResult, successResult } from "../kernel/results.ts";
import { type OpenedProject, openProject } from "../project/open.ts";
import { listProjectRecordIds, projectRecordId, projectRecordRevision } from "../project/record-index.ts";
import { createRecord, readRecord, updateRecord } from "../project/records.ts";
import { readApprovalRecords } from "../security/approval.ts";
import { brokerProjectFile } from "../security/broker-files.ts";
import {
	type HttpBrokerOptions,
	type HttpReceipt,
	type HttpRequestIntent,
	requestGovernedHttp,
} from "../security/broker-http.ts";
import { type ActionRequest, createActionRequest, evaluateActionPolicy } from "../security/policy.ts";
import {
	type ArtifactToolValue,
	commitPreparedArtifact,
	prepareArtifact,
	validateArtifact,
} from "../tools/artifacts.ts";
import {
	commitDesignDraft,
	type DesignDraft,
	type DesignRecord,
	type DesignRecordKind,
	decideDesignRecord,
	markDesignAwaitingConfirmation,
} from "../tools/design.ts";
import { acquireDocument, parseDocument, recordDocumentLocation } from "../tools/documents.ts";
import {
	type ClaimDraft,
	commitClaim,
	commitEvidenceCard,
	deriveClaimSupportStatus,
	findActiveEvidenceCardByFingerprint,
} from "../tools/evidence.ts";
import { importSourceFiles } from "../tools/import-sources.ts";
import { finishOperation, type StartOperationInput, startOperation } from "../tools/operations.ts";
import { commitSourceCandidates, metadataObject, type SourceCandidateInput } from "../tools/sources.ts";
import { type CitationAdapterRun, verifyCitation } from "../tools/verify-citations.ts";

type CurrentProject = Extract<OpenedProject, { compatibility: "current" }>;

export const RESEARCH_TOOL_NAMES = [
	"research_search_sources",
	"research_import_sources",
	"research_documents",
	"research_query_corpus",
	"research_commit_evidence",
	"research_verify_citations",
	"research_artifacts",
	"research_design",
] as const;

const SearchSourcesParameters = Type.Object(
	{
		queryPlanId: Type.String({ minLength: 1 }),
		queries: Type.Array(
			Type.Object(
				{
					queryId: Type.String({ minLength: 1 }),
					text: Type.String({ minLength: 1 }),
					adapterIds: Type.Array(Type.Union([Type.Literal("crossref"), Type.Literal("openalex")]), {
						minItems: 1,
					}),
					filters: Type.Object(
						{
							fromYear: Type.Union([Type.Integer({ minimum: 1000, maximum: 9999 }), Type.Null()]),
							toYear: Type.Union([Type.Integer({ minimum: 1000, maximum: 9999 }), Type.Null()]),
							types: Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 }),
						},
						{ additionalProperties: false },
					),
					maxResults: Type.Integer({ minimum: 1, maximum: 10_000 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		budget: Type.Object(
			{
				maxUsd: Type.Number({ minimum: 0 }),
				maxRequests: Type.Integer({ minimum: 1 }),
				hardStop: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		refresh: Type.Union([Type.Literal("use-cache"), Type.Literal("revalidate")]),
	},
	{ additionalProperties: false },
);

const ImportSourcesParameters = Type.Object(
	{
		inputs: Type.Array(
			Type.Object(
				{
					path: Type.String({ minLength: 1 }),
					format: Type.Union([
						Type.Literal("auto"),
						Type.Literal("ris"),
						Type.Literal("bibtex"),
						Type.Literal("csl-json"),
						Type.Literal("pdf"),
					]),
					mode: Type.Union([Type.Literal("copy"), Type.Literal("reference")]),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		dedupe: Type.Union([Type.Literal("exact-only"), Type.Literal("exact-and-review-candidates")]),
	},
	{ additionalProperties: false },
);

const DocumentsParameters = Type.Object(
	{
		action: Type.Union([
			Type.Literal("locate"),
			Type.Literal("acquire"),
			Type.Literal("parse"),
			Type.Literal("retry_failed"),
		]),
		sourceIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		acquisitionPolicy: Type.Object(
			{
				allowOpenAccessDownload: Type.Boolean(),
				allowPublisherLandingPageOnly: Type.Boolean(),
				maxBytesPerFile: Type.Integer({ minimum: 1 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const QueryCorpusParameters = Type.Object(
	{
		query: Type.String({ minLength: 1 }),
		scope: Type.Union([
			Type.Literal("sources"),
			Type.Literal("documents"),
			Type.Literal("evidence"),
			Type.Literal("claims"),
			Type.Literal("all"),
		]),
		filters: Type.Record(Type.String(), JsonValueSchema),
		limit: Type.Integer({ minimum: 1, maximum: 100 }),
		maxCharsPerHit: Type.Integer({ minimum: 1, maximum: 4_000 }),
		cursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
	},
	{ additionalProperties: false },
);

const EvidenceDraftSchema = Type.Object(
	{
		sourceId: EvidenceCardSchema.properties.sourceId,
		documentId: EvidenceCardSchema.properties.documentId,
		evidenceLevel: EvidenceCardSchema.properties.evidenceLevel,
		locator: EvidenceCardSchema.properties.locator,
		excerpt: EvidenceCardSchema.properties.excerpt,
		excerptExactMatch: EvidenceCardSchema.properties.excerptExactMatch,
		paraphrase: EvidenceCardSchema.properties.paraphrase,
		evidenceStatement: EvidenceCardSchema.properties.evidenceStatement,
		claimLinks: EvidenceCardSchema.properties.claimLinks,
		extraction: Type.Object(
			{ method: Type.Union([Type.Literal("deterministic"), Type.Literal("imported")]) },
			{ additionalProperties: false },
		),
		confidence: EvidenceCardSchema.properties.confidence,
		rights: EvidenceCardSchema.properties.rights,
		humanStatus: Type.Literal("not_reviewed"),
		supersedesEvidenceId: EvidenceCardSchema.properties.supersedesEvidenceId,
	},
	{ additionalProperties: false },
);

const ClaimDraftSchema = Type.Object(
	{
		text: ClaimRecordSchema.properties.text,
		claimType: ClaimRecordSchema.properties.claimType,
		scope: ClaimRecordSchema.properties.scope,
		evidenceLinks: ClaimRecordSchema.properties.evidenceLinks,
		conflictEvidenceIds: ClaimRecordSchema.properties.conflictEvidenceIds,
	},
	{ additionalProperties: false },
);

const CommitEvidenceParameters = Type.Object(
	{
		evidenceCards: Type.Array(EvidenceDraftSchema),
		claims: Type.Array(ClaimDraftSchema),
		expectedRevision: Type.Integer({ minimum: 0 }),
		validationMode: Type.Literal("strict"),
	},
	{ additionalProperties: false },
);

const VerifyCitationsParameters = Type.Object(
	{
		sourceIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		providers: Type.Array(Type.Union([Type.Literal("crossref"), Type.Literal("openalex")]), { minItems: 1 }),
		refresh: Type.Union([Type.Literal("use-cache"), Type.Literal("revalidate")]),
		matchThresholds: Type.Object(
			{
				title: Type.Number({ minimum: 0, maximum: 1 }),
				author: Type.Number({ minimum: 0, maximum: 1 }),
				yearTolerance: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const ArtifactsParameters = Type.Object(
	{
		action: Type.Union([
			Type.Literal("generate_structured"),
			Type.Literal("commit_markdown"),
			Type.Literal("validate"),
		]),
		artifactType: Type.Union([
			Type.Literal("review"),
			Type.Literal("evidence-matrix"),
			Type.Literal("research-design"),
			Type.Literal("ris"),
			Type.Literal("bibtex"),
			Type.Literal("json"),
		]),
		content: Type.Optional(Type.String()),
		sourceRefs: Type.Array(RecordRefSchema, { minItems: 1 }),
		targetStatus: Type.Union([
			Type.Literal("exploratory"),
			Type.Literal("evidence_checked"),
			Type.Literal("submission_candidate"),
		]),
		outputPath: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const DesignBasisInputSchema = Type.Object(
	{
		summary: DesignBasisSchema.properties.summary,
		provenance: Type.Array(DesignProvenanceRefSchema),
		evidenceGap: DesignBasisSchema.properties.evidenceGap,
	},
	{ additionalProperties: false },
);

const DesignParameters = Type.Union([
	Type.Object(
		{
			action: Type.Literal("create_question"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			questionSeriesId: ResearchQuestionVersionSchema.properties.questionSeriesId,
			version: ResearchQuestionVersionSchema.properties.version,
			text: ResearchQuestionVersionSchema.properties.text,
			questionType: ResearchQuestionVersionSchema.properties.questionType,
			rationale: ResearchQuestionVersionSchema.properties.rationale,
			scope: ResearchQuestionVersionSchema.properties.scope,
			boundaryConditions: ResearchQuestionVersionSchema.properties.boundaryConditions,
			basis: DesignBasisInputSchema,
			supersedesResearchQuestionVersionId:
				ResearchQuestionVersionSchema.properties.supersedesResearchQuestionVersionId,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("create_concept"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			name: ConceptRecordSchema.properties.name,
			definition: ConceptRecordSchema.properties.definition,
			role: ConceptRecordSchema.properties.role,
			aliases: ConceptRecordSchema.properties.aliases,
			measurementNotes: ConceptRecordSchema.properties.measurementNotes,
			boundaryConditions: ConceptRecordSchema.properties.boundaryConditions,
			basis: DesignBasisInputSchema,
			supersedesConceptId: ConceptRecordSchema.properties.supersedesConceptId,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("create_relation"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			fromConceptId: TheoryRelationSchema.properties.fromConceptId,
			toConceptId: TheoryRelationSchema.properties.toConceptId,
			relationType: TheoryRelationSchema.properties.relationType,
			direction: TheoryRelationSchema.properties.direction,
			statement: TheoryRelationSchema.properties.statement,
			hypothesesOrPropositions: TheoryRelationSchema.properties.hypothesesOrPropositions,
			boundaryConditions: TheoryRelationSchema.properties.boundaryConditions,
			alternativeExplanations: TheoryRelationSchema.properties.alternativeExplanations,
			basis: DesignBasisInputSchema,
			supersedesTheoryRelationId: TheoryRelationSchema.properties.supersedesTheoryRelationId,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("create_decision"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			decisionType: DesignDecisionSchema.properties.decisionType,
			question: DesignDecisionSchema.properties.question,
			options: DesignDecisionSchema.properties.options,
			selectedOptionId: DesignDecisionSchema.properties.selectedOptionId,
			rationale: DesignDecisionSchema.properties.rationale,
			alternativesConsidered: DesignDecisionSchema.properties.alternativesConsidered,
			limitations: DesignDecisionSchema.properties.limitations,
			basis: DesignBasisInputSchema,
			critical: DesignDecisionSchema.properties.critical,
			supersedesDesignDecisionId: DesignDecisionSchema.properties.supersedesDesignDecisionId,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("create_protocol"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			title: ProtocolRecordSchema.properties.title,
			researchQuestionVersionId: ProtocolRecordSchema.properties.researchQuestionVersionId,
			designType: ProtocolRecordSchema.properties.designType,
			claimMode: ProtocolRecordSchema.properties.claimMode,
			method: ProtocolRecordSchema.properties.method,
			population: ProtocolRecordSchema.properties.population,
			unitOfAnalysis: ProtocolRecordSchema.properties.unitOfAnalysis,
			timeframe: ProtocolRecordSchema.properties.timeframe,
			samplingPlan: ProtocolRecordSchema.properties.samplingPlan,
			measurementPlan: ProtocolRecordSchema.properties.measurementPlan,
			dataCollectionPlan: ProtocolRecordSchema.properties.dataCollectionPlan,
			analysisPlan: ProtocolRecordSchema.properties.analysisPlan,
			identificationStrategy: ProtocolRecordSchema.properties.identificationStrategy,
			identificationAssumptions: ProtocolRecordSchema.properties.identificationAssumptions,
			preanalysisPlan: ProtocolRecordSchema.properties.preanalysisPlan,
			interviewPlan: ProtocolRecordSchema.properties.interviewPlan,
			caseSelectionPlan: ProtocolRecordSchema.properties.caseSelectionPlan,
			inclusionCriteria: ProtocolRecordSchema.properties.inclusionCriteria,
			exclusionCriteria: ProtocolRecordSchema.properties.exclusionCriteria,
			alternativeExplanations: ProtocolRecordSchema.properties.alternativeExplanations,
			boundaryConditions: ProtocolRecordSchema.properties.boundaryConditions,
			feasibilityLimits: ProtocolRecordSchema.properties.feasibilityLimits,
			ethicsChecklist: ProtocolRecordSchema.properties.ethicsChecklist,
			decisionIds: ProtocolRecordSchema.properties.decisionIds,
			conceptIds: ProtocolRecordSchema.properties.conceptIds,
			theoryRelationIds: ProtocolRecordSchema.properties.theoryRelationIds,
			basis: DesignBasisInputSchema,
			supersedesProtocolId: ProtocolRecordSchema.properties.supersedesProtocolId,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("confirm"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			recordKind: Type.Union([
				Type.Literal("research_question_version"),
				Type.Literal("concept"),
				Type.Literal("theory_relation"),
				Type.Literal("design_decision"),
				Type.Literal("protocol"),
			]),
			recordId: Type.String({ minLength: 1 }),
			expectedRecordRevision: Type.Integer({ minimum: 0 }),
			note: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
]);

interface ToolOutcome<Value> {
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

function toolResponse<Value>(result: ResearchResult<Value>): AgentToolResult<ResearchResult<Value>> {
	return {
		content: [{ type: "text", text: canonicalStringify(result as unknown as JsonValue) }],
		details: result,
	};
}

function withoutOperation<Value>(result: ResearchResult<Value>): ResearchResult<Value> {
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

function thrownFailure<Value>(error: unknown, operationId: string | null): ResearchResult<Value> {
	return failureResult(
		"PERMANENT_FAILURE",
		error instanceof TypeError ? "RESEARCH_TOOL_INVALID" : "RESEARCH_TOOL_FAILED",
		error instanceof TypeError ? "validation" : "runtime",
		error instanceof Error ? error.message : "Research tool failed",
		operationId,
	);
}

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

async function trackedTool<Value>(
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

function objectValue(value: JsonValue, label: string): { [key: string]: JsonValue } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
	return value;
}

function moneyValue(value: JsonValue): Money | null {
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

async function linkApprovalToOperation(
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

async function approveArtifactAction(
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
			"Artifact action expected an approval but project policy returned an unscoped allow",
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
		: failureResult(
				"PERMISSION_BLOCKED",
				"ACTION_DENIED",
				"permission",
				"User denied the artifact action",
				operationId,
				{ approvalId },
			);
}

async function recordHttpApproval(
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

function defaultHttpOptions(options: RegisterResearchToolsOptions): HttpBrokerOptions {
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

async function governedRequest(
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

async function childOperation<Value>(
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

async function adapterOperation<Value>(
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

function configuredAlias(explicit: string | undefined, environmentName: string): string | null {
	if (explicit !== undefined) return explicit;
	const value = process.env[environmentName];
	return value === undefined || value.length === 0 ? null : environmentName;
}

function sourceAdapter(
	id: "crossref" | "openalex",
	options: RegisterResearchToolsOptions,
): CrossrefAdapter | OpenAlexAdapter {
	return id === "crossref"
		? new CrossrefAdapter(configuredAlias(options.credentialAliases?.crossrefMailto, "CROSSREF_MAILTO"))
		: new OpenAlexAdapter(configuredAlias(options.credentialAliases?.openalexApiKey, "OPENALEX_API_KEY"));
}

async function sourcesByQueryHash(
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

interface SearchRunSummary {
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

interface SearchSourcesValue {
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

function researchResult<Value>(
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

function withAdditionalErrors<Value>(
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

async function searchSources(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: Static<typeof SearchSourcesParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<SearchSourcesValue>> {
	if (new Set(params.queries.map(({ queryId }) => queryId)).size !== params.queries.length) {
		return { result: thrownFailure(new TypeError("Search query IDs must be unique"), operation.operationId) };
	}
	const baseHttp = defaultHttpOptions(options);
	const baseTransport = baseHttp.transport ?? fetchHttpTransport;
	let requestCount = 0;
	const http: HttpBrokerOptions = {
		...baseHttp,
		transport: async (request) => {
			requestCount += 1;
			return baseTransport(request);
		},
	};
	const errors: ResearchError[] = [];
	const candidates: SourceCandidateInput[] = [];
	const runs: SearchRunSummary[] = [];
	let costUsd = 0;
	let successfulRuns = 0;

	for (const query of params.queries) {
		if (
			query.filters.fromYear !== null &&
			query.filters.toYear !== null &&
			query.filters.fromYear > query.filters.toYear
		) {
			errors.push(
				thrownFailure<never>(
					new TypeError(`Query ${query.queryId} has an inverted year range`),
					operation.operationId,
				).errors[0],
			);
			continue;
		}
		for (const adapterId of [...new Set(query.adapterIds)]) {
			const adapter = sourceAdapter(adapterId, options);
			const capabilities = await adapter.capabilities();
			const queryHash = hashCanonicalJson({
				adapterId,
				adapterVersion: capabilities.adapterVersion,
				query: query.text.normalize("NFKC").replace(/\s+/gu, " ").trim(),
				filters: query.filters,
				maxResults: query.maxResults,
			});
			if (params.refresh === "use-cache") {
				const cached = await sourcesByQueryHash(project.root, adapterId, queryHash.value);
				// ponytail: without a search-log record, only a full requested page proves a reusable cache hit.
				if (cached.length >= query.maxResults) {
					const selected = cached.slice(0, query.maxResults);
					runs.push({
						queryId: query.queryId,
						adapterId,
						status: "cached",
						resultCount: selected.length,
						sourceIds: selected.map(({ source }) => source.sourceId),
						rawResponses: selected.flatMap(({ rawResponses }) => rawResponses),
						operationIds: [],
						requestCount: 0,
						costUsd: 0,
						candidateIds: [],
					});
					successfulRuns += 1;
					continue;
				}
			}

			const startRequests = requestCount;
			const startCost = costUsd;
			const startCandidates = candidates.length;
			const startErrors = errors.length;
			const rawResponses: FileRef[] = [];
			const operationIds: string[] = [];
			let cursor: JsonValue = null;
			let returned = 0;
			let runFailed = false;
			while (returned < query.maxResults) {
				const remainingRequests = params.budget.maxRequests - requestCount;
				if (remainingRequests < 1) break;
				const remainingResults = query.maxResults - returned;
				const pageSize = Math.min(adapterId === "crossref" ? 1_000 : 100, remainingResults);
				const run = await adapterOperation(
					project,
					ctx,
					adapter,
					"search",
					[],
					signal,
					http,
					(context) =>
						adapter.search(
							{
								queryText: query.text,
								filters: query.filters,
								pageSize,
								cursor,
								maxResults: query.maxResults,
								maxCost: { amount: Math.max(0, params.budget.maxUsd - costUsd), currency: "USD" },
							},
							context,
						),
					(intent) => {
						const remaining = params.budget.maxRequests - requestCount;
						if (remaining < 1) return null;
						const maxAttempts = Math.min(intent.maxAttempts, remaining);
						return {
							...intent,
							maxAttempts,
							estimatedCost:
								intent.estimatedCost === null
									? null
									: {
											amount: intent.costPerRequest.amount * maxAttempts,
											currency: intent.costPerRequest.currency,
										},
						};
					},
				);
				operationIds.push(run.operationId);
				if (!run.result.ok) {
					errors.push(...run.result.errors);
					runFailed = true;
					break;
				}
				errors.push(...run.result.errors);
				rawResponses.push(run.result.value.rawResponse);
				costUsd += run.result.value.actualCost.amount;
				const retrievedAt = new Date().toISOString();
				for (const [index, candidate] of run.result.value.candidates.entries()) {
					const candidateId = `${query.queryId}:${adapterId}:${run.result.value.rawResponse.hash?.value ?? run.operationId}:${index}`;
					candidates.push({
						candidateId,
						adapterId,
						adapterVersion: capabilities.adapterVersion,
						retrievedAt,
						rawRecord: run.result.value.rawResponse,
						metadata: metadataObject(candidate),
						documentContentHash: null,
						requiresBibliographicMatch: false,
						queryText: query.text,
						queryHash,
						rank: returned + index + 1,
						requestOperationId: run.operationId,
						abstractRights: "metadata_only",
					});
				}
				returned += run.result.value.candidates.length;
				cursor = run.result.value.nextCursor;
				if (run.result.value.exhausted || cursor === null || run.result.value.candidates.length === 0) break;
			}
			const budgetExhausted = returned < query.maxResults && requestCount >= params.budget.maxRequests;
			if (budgetExhausted) {
				errors.push({
					code: "REQUEST_BUDGET_EXHAUSTED",
					category: "budget",
					message: `Search request budget stopped ${query.queryId}/${adapterId}`,
					retryable: false,
					source: "research-search-sources",
					operationId: operation.operationId,
					taskId: null,
					details: { maxRequests: params.budget.maxRequests, hardStop: params.budget.hardStop },
					occurredAt: new Date().toISOString(),
					causeCode: null,
				});
			}
			const resultCount = candidates.length - startCandidates;
			if (!runFailed || resultCount > 0) successfulRuns += 1;
			runs.push({
				queryId: query.queryId,
				adapterId,
				status: budgetExhausted
					? "budget_exhausted"
					: runFailed
						? "failed"
						: errors.length > startErrors
							? "partially_succeeded"
							: "succeeded",
				resultCount,
				sourceIds: [],
				rawResponses,
				operationIds,
				requestCount: requestCount - startRequests,
				costUsd: costUsd - startCost,
				candidateIds: candidates.slice(startCandidates).map(({ candidateId }) => candidateId),
			});
			if (params.budget.hardStop && budgetExhausted) break;
		}
		if (params.budget.hardStop && requestCount >= params.budget.maxRequests) break;
	}

	const committed = await commitSourceCandidates(project.root, operation.operationId, candidates);
	if (!committed.ok) return { result: committed };
	const sourceByCandidate = new Map(
		committed.value.candidateSources.map(({ candidateId, sourceId }) => [candidateId, sourceId]),
	);
	for (const run of runs) {
		if (run.status !== "cached") {
			run.sourceIds = [
				...new Set(
					run.candidateIds
						.map((candidateId) => sourceByCandidate.get(candidateId))
						.filter((sourceId): sourceId is string => sourceId !== undefined),
				),
			];
		}
	}
	const rawResponses = [
		...new Map(runs.flatMap(({ rawResponses }) => rawResponses).map((file) => [file.path, file])).values(),
	];
	const value: SearchSourcesValue = {
		queryPlanId: params.queryPlanId,
		runs,
		createdSourceIds: committed.value.createdSourceIds,
		reusedSourceIds: committed.value.reusedSourceIds,
		rejected: committed.value.rejected as unknown as JsonValue[],
		possibleDuplicates: [
			...committed.value.possibleDuplicates,
			...committed.value.existingSourceDuplicates,
		] as unknown as JsonValue[],
		rawResponses,
		requestCount,
		cost: { amount: costUsd, currency: "USD" },
	};
	return {
		result: researchResult(value, operation.operationId, errors, successfulRuns > 0),
		outputs: committed.value.sourceRefs,
		outputFiles: rawResponses,
	};
}

async function importRawRecord(
	project: CurrentProject,
	ctx: ExtensionContext,
	operationId: string,
	raw: RawImportFile,
): Promise<ResearchResult<FileRef>> {
	if (raw.storedFile !== null) return successResult(raw.storedFile, operationId);
	if (raw.referencePath === null) {
		return failureResult(
			"PERMANENT_FAILURE",
			"IMPORT_RAW_RECORD_MISSING",
			"integrity",
			"Reference import has no source path",
			operationId,
		);
	}
	const content = `${canonicalStringify({
		version: 1,
		mode: "reference",
		path: raw.referencePath,
		format: raw.format,
		contentHash: raw.contentHash,
		bytes: raw.bytes,
		mediaType: raw.mediaType,
	})}\n`;
	const path = `sources/imports/${raw.contentHash.value}.reference.json`;
	const file: FileRef = {
		path,
		hash: hashBytes(content),
		mediaType: "application/json",
		bytes: Buffer.byteLength(content),
	};
	try {
		const existing = await readFile(await resolveProjectPath(project.root, path));
		if (hashBytes(existing).value !== file.hash?.value) {
			return failureResult(
				"DATA_CONFLICT",
				"IMPORT_REFERENCE_RECEIPT_CONFLICT",
				"integrity",
				"Content-addressed import reference receipt contains different bytes",
				operationId,
				{ path },
			);
		}
		return successResult(file, operationId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return failureResult(
				"PERMANENT_FAILURE",
				"IMPORT_REFERENCE_RECEIPT_READ_FAILED",
				"runtime",
				error instanceof Error ? error.message : "Import reference receipt could not be read",
				operationId,
			);
		}
	}
	const opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"IMPORT_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const stored = await brokerProjectFile(project.root, {
		operationId,
		sessionId: ctx.sessionManager.getSessionId(),
		expectedManifestRevision: opened.manifest.revision,
		path,
		content,
		dataClasses: ["bibliographic_metadata_reference"],
	});
	return stored.ok ? successResult(file, operationId) : propagatedFailure(stored, operationId);
}

interface ImportSourcesValue {
	importedSourceIds: string[];
	reusedSourceIds: string[];
	skippedCandidateIds: string[];
	conflicts: JsonValue[];
	unmatchedDocuments: JsonValue[];
	inputs: JsonValue[];
	portable: boolean;
}

async function importSources(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof ImportSourcesParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<ImportSourcesValue>> {
	const opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
	}
	const imported = await importSourceFiles(project.root, {
		inputs: params.inputs,
		operationId: operation.operationId,
		sessionId: ctx.sessionManager.getSessionId(),
		expectedManifestRevision: opened.manifest.revision,
	});
	if (!imported.ok) return { result: imported };
	const rawRecords = new Map<number, FileRef>();
	const outputFiles: FileRef[] = [];
	const errors = [...imported.errors];
	for (const raw of imported.value.rawInputs) {
		const record = await importRawRecord(project, ctx, operation.operationId, raw);
		if (!record.ok) {
			errors.push(...record.errors);
			continue;
		}
		rawRecords.set(raw.inputIndex, record.value);
		outputFiles.push(record.value);
	}
	const retrievedAt = new Date().toISOString();
	const candidates: SourceCandidateInput[] = imported.value.sourceCandidates.flatMap((candidate) => {
		const rawRecord = rawRecords.get(candidate.inputIndex);
		return rawRecord === undefined
			? []
			: [
					{
						candidateId: candidate.candidateKey,
						adapterId: "local-import",
						adapterVersion: RESEARCH_SCHEMA_VERSION,
						retrievedAt,
						rawRecord,
						metadata: candidate.metadata,
						documentContentHash:
							candidate.format === "pdf"
								? (imported.value.rawInputs.find(({ inputIndex }) => inputIndex === candidate.inputIndex)
										?.contentHash ?? null)
								: null,
						requiresBibliographicMatch: candidate.requiresBibliographicMatch,
						queryText: null,
						queryHash: null,
						rank: candidate.entryIndex === null ? null : candidate.entryIndex + 1,
						requestOperationId: operation.operationId,
						abstractRights: "metadata_only",
					},
				];
	});
	const committed = await commitSourceCandidates(project.root, operation.operationId, candidates);
	if (!committed.ok) return { result: committed };
	const value: ImportSourcesValue = {
		importedSourceIds: committed.value.createdSourceIds,
		reusedSourceIds: committed.value.reusedSourceIds,
		skippedCandidateIds: committed.value.rejected.map(({ candidateId }) => candidateId),
		conflicts:
			params.dedupe === "exact-and-review-candidates"
				? ([
						...committed.value.possibleDuplicates,
						...committed.value.existingSourceDuplicates,
					] as unknown as JsonValue[])
				: [],
		unmatchedDocuments: imported.value.documentCandidates.map((candidate) => ({
			candidateKey: candidate.candidateKey,
			sourceCandidateKey: candidate.sourceCandidateKey,
			contentHash: candidate.contentHash,
			portable: candidate.portable,
			reason: "BIBLIOGRAPHIC_MATCH_REQUIRED",
		})),
		inputs: imported.value.rawInputs.map((raw) => ({
			inputIndex: raw.inputIndex,
			format: raw.format,
			mode: raw.mode,
			contentHash: raw.contentHash,
			portable: raw.portable,
		})),
		portable: imported.value.rawInputs.every(({ portable }) => portable),
	};
	return {
		result: researchResult(value, operation.operationId, errors, true),
		outputs: committed.value.sourceRefs,
		outputFiles: [...new Map(outputFiles.map((file) => [file.path, file])).values()],
	};
}

async function sourceRecord(
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

async function documentForSource(
	projectRoot: string,
	sourceId: string,
): Promise<ResearchResult<DocumentRecord> | null> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	for (const documentId of await listProjectRecordIds(opened.root, opened.manifest, "document")) {
		const result = await readRecord(opened.root, "document", documentId);
		if (!result.ok || result.value.kind !== "document") throw new TypeError(`Invalid document record: ${documentId}`);
		if (result.value.sourceId === sourceId) return Promise.resolve(successResult(result.value, null));
	}
	return null;
}

async function locateDocument(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	source: SourceRecord,
	aggregateOperationId: string,
	signal: AbortSignal,
): Promise<ResearchResult<DocumentRecord>> {
	const existing = await documentForSource(project.root, source.sourceId);
	if (existing !== null) return existing;
	const adapter = new UnpaywallAdapter(configuredAlias(options.credentialAliases?.unpaywallEmail, "UNPAYWALL_EMAIL"));
	const located = await adapterOperation(
		project,
		ctx,
		adapter,
		"locate",
		[{ kind: "source", id: source.sourceId, revision: source.audit.revision }],
		signal,
		defaultHttpOptions(options),
		(context) => locateSourceDocument(source, adapter, context),
	);
	if (!located.result.ok) return propagatedFailure(located.result, aggregateOperationId);
	const opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return thrownFailure(new TypeError("Research project schema is read-only"), aggregateOperationId);
	}
	const recorded = await recordDocumentLocation(project.root, {
		documentId: createOpaqueId("document"),
		sourceId: source.sourceId,
		operationId: aggregateOperationId,
		expectedManifestRevision: opened.manifest.revision,
		location: located.result.value,
	});
	if (!recorded.ok || located.result.errors.length === 0) return recorded;
	return {
		ok: true,
		status: "PARTIAL_SUCCESS",
		value: recorded.value,
		errors: located.result.errors,
		meta: {
			operationId: aggregateOperationId,
			taskId: null,
			warnings: located.result.errors.map(({ message }) => message),
		},
	};
}

async function acquireLocatedDocument(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	source: SourceRecord,
	document: DocumentRecord,
	policy: Static<typeof DocumentsParameters>["acquisitionPolicy"],
	signal: AbortSignal,
): Promise<ResearchResult<typeof document>> {
	if (document.localFile !== null) return successResult(document, null);
	const adapter = new UnpaywallAdapter(configuredAlias(options.credentialAliases?.unpaywallEmail, "UNPAYWALL_EMAIL"));
	const located = await adapterOperation(
		project,
		ctx,
		adapter,
		"locate",
		[{ kind: "source", id: source.sourceId, revision: source.audit.revision }],
		signal,
		defaultHttpOptions(options),
		(context) => locateSourceDocument(source, adapter, context),
	);
	if (!located.result.ok) return propagatedFailure(located.result, located.operationId);
	const candidate = located.result.value.bestLocation;
	if (candidate === null) {
		return withAdditionalErrors(successResult(document, located.operationId), located.result.errors);
	}
	if (candidate.kind !== "direct_pdf") {
		return withAdditionalErrors(
			policy.allowPublisherLandingPageOnly
				? successResult(document, located.operationId)
				: failureResult(
						"PERMISSION_BLOCKED",
						"DOCUMENT_DIRECT_PDF_REQUIRED",
						"permission",
						"Only a publisher landing page was located",
						located.operationId,
					),
			located.result.errors,
		);
	}
	const acquired = (
		await childOperation(
			project,
			ctx,
			{
				operationKind: "adapter",
				name: "document-http.acquire",
				implementationVersion: options.version,
				inputs: [
					{ kind: "source", id: source.sourceId, revision: source.audit.revision },
					{ kind: "document", id: document.documentId, revision: document.audit.revision },
				],
				inputFiles: [candidate.rawRecord],
				adapter: {
					adapterId: "document-http",
					adapterVersion: options.version,
					capabilitySnapshotHash: hashCanonicalJson({ adapterId: "document-http", version: options.version }),
				},
			},
			async (operation) => {
				const result = await acquireDocument(project.root, {
					documentId: document.documentId,
					operationId: operation.operationId,
					sessionId: ctx.sessionManager.getSessionId(),
					expectedDocumentRevision: document.audit.revision,
					candidate,
					allowOpenAccessDownload: policy.allowOpenAccessDownload,
					maxBytesPerFile: policy.maxBytesPerFile,
					expectedContentHash: null,
					requestHttp: (intent) =>
						governedRequest(
							project.root,
							operation.operationId,
							ctx,
							signal,
							intent,
							defaultHttpOptions(options),
						),
				});
				return {
					result,
					outputs: result.ok
						? [{ kind: "document", id: result.value.documentId, revision: result.value.audit.revision }]
						: [],
					outputFiles: result.ok && result.value.localFile !== null ? [result.value.localFile] : [],
				};
			},
		)
	).result;
	return withAdditionalErrors(acquired, located.result.errors);
}

async function parseLocatedDocument(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	source: SourceRecord,
	document: DocumentRecord,
	maxBytes: number,
): Promise<ResearchResult<typeof document>> {
	if (document.fullTextStatus === "parsed" || document.fullTextStatus === "parsed_with_warnings") {
		return successResult(document, null);
	}
	return (
		await childOperation(
			project,
			ctx,
			{
				operationKind: "tool",
				name: "pdf.parse",
				implementationVersion: options.version,
				inputs: [
					{ kind: "source", id: source.sourceId, revision: source.audit.revision },
					{ kind: "document", id: document.documentId, revision: document.audit.revision },
				],
				inputFiles: document.localFile === null ? [] : [document.localFile],
			},
			async (operation) => {
				const result = await parseDocument(project.root, {
					documentId: document.documentId,
					operationId: operation.operationId,
					sessionId: ctx.sessionManager.getSessionId(),
					expectedDocumentRevision: document.audit.revision,
					options: { maxBytes, maxPages: 2_000 },
				});
				return {
					result,
					outputs: result.ok
						? [{ kind: "document", id: result.value.documentId, revision: result.value.audit.revision }]
						: [],
					outputFiles: result.ok && result.value.parsedOutput !== null ? [result.value.parsedOutput] : [],
				};
			},
		)
	).result;
}

interface DocumentsValue {
	action: Static<typeof DocumentsParameters>["action"];
	documents: JsonValue[];
}

async function documents(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: Static<typeof DocumentsParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<DocumentsValue>> {
	const errors: ResearchError[] = [];
	const values: JsonValue[] = [];
	const outputs: RecordRef[] = [];
	const outputFiles: FileRef[] = [];
	let succeeded = false;
	for (const sourceId of [...new Set(params.sourceIds)]) {
		const source = await sourceRecord(project.root, sourceId, operation.operationId);
		if (!source.ok) {
			errors.push(...source.errors);
			continue;
		}
		let documentResult = await documentForSource(project.root, sourceId);
		if (params.action === "locate" || documentResult === null) {
			documentResult = await locateDocument(project, ctx, options, source.value, operation.operationId, signal);
		}
		if (documentResult === null || !documentResult.ok) {
			if (documentResult !== null) errors.push(...documentResult.errors);
			continue;
		}
		let document = documentResult.value;
		errors.push(...documentResult.errors);
		if (params.action === "acquire") {
			const acquired = await acquireLocatedDocument(
				project,
				ctx,
				options,
				source.value,
				document,
				params.acquisitionPolicy,
				signal,
			);
			if (!acquired.ok) {
				errors.push(...acquired.errors);
				continue;
			}
			document = acquired.value;
			errors.push(...acquired.errors);
		}
		if (params.action === "parse") {
			const parsed = await parseLocatedDocument(
				project,
				ctx,
				options,
				source.value,
				document,
				params.acquisitionPolicy.maxBytesPerFile,
			);
			if (!parsed.ok) {
				errors.push(...parsed.errors);
				continue;
			}
			document = parsed.value;
			errors.push(...parsed.errors);
		}
		if (params.action === "retry_failed" && document.failure?.retryable === true) {
			const retried =
				document.fullTextStatus === "parse_failed"
					? await parseLocatedDocument(
							project,
							ctx,
							options,
							source.value,
							document,
							params.acquisitionPolicy.maxBytesPerFile,
						)
					: await acquireLocatedDocument(
							project,
							ctx,
							options,
							source.value,
							document,
							params.acquisitionPolicy,
							signal,
						);
			if (!retried.ok) {
				errors.push(...retried.errors);
				continue;
			}
			document = retried.value;
			errors.push(...retried.errors);
		}
		succeeded = true;
		outputs.push({ kind: "document", id: document.documentId, revision: document.audit.revision });
		if (document.localFile !== null) outputFiles.push(document.localFile);
		if (document.parsedOutput !== null) outputFiles.push(document.parsedOutput);
		values.push({
			sourceId,
			documentId: document.documentId,
			fullTextStatus: document.fullTextStatus,
			accessStatus: document.acquisition.accessStatus,
			licenseExpression: document.acquisition.licenseExpression,
			localFile: document.localFile,
			pageCount: document.pageCount,
			failure: document.failure,
		});
	}
	return {
		result: researchResult({ action: params.action, documents: values }, operation.operationId, errors, succeeded),
		outputs,
		outputFiles: [...new Map(outputFiles.map((file) => [file.path, file])).values()],
	};
}

function fileKey(file: FileRef): string {
	return `${file.path}:${file.hash?.value ?? ""}:${file.mediaType ?? ""}:${file.bytes ?? ""}`;
}

async function addOperationInputs(
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

async function approveReviewedClaimLink(
	projectRoot: string,
	ctx: ExtensionContext,
	operationId: string,
	claim: ClaimRecord,
	evidenceFingerprintValue: string,
	existingEvidence: EvidenceCard | null,
): Promise<ResearchResult<string>> {
	const evidenceLabel = existingEvidence?.evidenceId ?? `draft ${evidenceFingerprintValue.slice(0, 12)}`;
	if (!ctx.hasUI) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"CLAIM_LINK_APPROVAL_REQUIRED",
			"permission",
			`Claim ${claim.claimId} was human-reviewed and requires interactive approval before adding evidence`,
			operationId,
			{ claimId: claim.claimId, evidenceFingerprint: evidenceFingerprintValue },
		);
	}
	const approved = await ctx.ui.confirm(
		"Update reviewed research claim",
		`Add evidence ${evidenceLabel} to reviewed claim ${claim.claimId}?`,
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
	const actionFingerprint = hashCanonicalJson({
		action: "research.claim.link_evidence",
		claimId: claim.claimId,
		claimRevision: claim.audit.revision,
		evidenceFingerprint: evidenceFingerprintValue,
	}).value;
	const approval: ApprovalRecord = {
		kind: "approval",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		approvalId,
		taskId: null,
		operationId,
		actionClass: "project_overwrite",
		actionName: "research.claim.link_evidence",
		impactScope: [`claim:${claim.claimId}`],
		estimatedCost: null,
		dataEgress: {
			destination: null,
			dataClasses: [],
			fileRefs: [],
			recordRefs: [
				{ kind: "claim", id: claim.claimId, revision: claim.audit.revision },
				...(existingEvidence === null
					? []
					: [
							{
								kind: "evidence" as const,
								id: existingEvidence.evidenceId,
								revision: existingEvidence.audit.revision,
							},
						]),
			],
		},
		overwriteRisk: { paths: [], destructive: false, recoverable: true },
		requestMessage: `Add evidence to reviewed claim ${claim.claimId}`,
		requestedAt: now,
		policySnapshotHash: hashCanonicalJson(opened.manifest.policy),
		decision: approved ? "approved" : "denied",
		scope: "once",
		scopeTarget: {
			projectId: opened.manifest.projectId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionFingerprint,
			destinationPattern: null,
			pathPatterns: [],
			maxApprovedCost: null,
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
		? successResult(approvalId, operationId)
		: failureResult(
				"PERMISSION_BLOCKED",
				"CLAIM_LINK_UPDATE_DENIED",
				"permission",
				`User denied adding evidence to reviewed claim ${claim.claimId}`,
				operationId,
				{ approvalId, claimId: claim.claimId, evidenceFingerprint: evidenceFingerprintValue },
			);
}

async function linkEvidenceToClaim(
	projectRoot: string,
	operationId: string,
	claimId: string,
	evidence: EvidenceCard,
	relation: EvidenceCard["claimLinks"][number]["relation"],
	assessment: string,
	reviewedUpdateApproved: boolean,
): Promise<ResearchResult<ClaimRecord>> {
	const current = await readRecord(projectRoot, "claim", claimId);
	if (!current.ok) return propagatedFailure(current, operationId);
	if (current.value.kind !== "claim") {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_CLAIM_INVALID",
			"integrity",
			`Record ${claimId} is not a claim`,
			operationId,
		);
	}
	const existing = current.value.evidenceLinks.find(({ evidenceId }) => evidenceId === evidence.evidenceId);
	const conflictLinked = relation !== "refutes" || current.value.conflictEvidenceIds.includes(evidence.evidenceId);
	const sameLink = existing !== undefined && existing.relation === relation && existing.assessment === assessment;
	if (sameLink && conflictLinked) return successResult(current.value, operationId);
	if (existing !== undefined && !sameLink) {
		return failureResult(
			"DATA_CONFLICT",
			"CLAIM_EVIDENCE_LINK_CONFLICT",
			"data_conflict",
			`Claim ${claimId} already links evidence ${evidence.evidenceId} differently`,
			operationId,
		);
	}
	if (current.value.humanConfirmation.status !== "not_reviewed" && !reviewedUpdateApproved) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"CLAIM_LINK_APPROVAL_REQUIRED",
			"permission",
			`Claim ${claimId} was human-reviewed and requires approval before adding evidence`,
			operationId,
			{ claimId, evidenceId: evidence.evidenceId },
		);
	}
	const evidenceLinks =
		existing === undefined
			? [...current.value.evidenceLinks, { evidenceId: evidence.evidenceId, relation, assessment }]
			: current.value.evidenceLinks;
	const supportStatus = deriveClaimSupportStatus(evidenceLinks);
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
	const updated = await updateRecord(projectRoot, "claim", claimId, {
		expectedManifestRevision: opened.manifest.revision,
		expectedRecordRevision: current.value.audit.revision,
		operationId,
		changes: {
			evidenceLinks,
			supportStatus,
			conflictEvidenceIds:
				relation === "refutes"
					? [...new Set([...current.value.conflictEvidenceIds, evidence.evidenceId])]
					: current.value.conflictEvidenceIds,
			publishability: supportStatus === "unassessed" || supportStatus === "unsupported" ? "blocked" : "exploratory",
		},
	});
	if (!updated.ok) return propagatedFailure(updated, operationId);
	const stored = await readRecord(projectRoot, "claim", claimId);
	if (!stored.ok) return propagatedFailure(stored, operationId);
	return stored.value.kind === "claim"
		? successResult(stored.value, operationId)
		: failureResult(
				"PERMANENT_FAILURE",
				"CLAIM_LINK_READBACK_INVALID",
				"integrity",
				`Updated claim ${claimId} could not be read back`,
				operationId,
			);
}

interface CommitEvidenceValue {
	claimIds: string[];
	evidenceIds: string[];
	rejected: JsonValue[];
	supportStatuses: JsonValue[];
	evidenceLevels: JsonValue[];
}

async function commitEvidence(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof CommitEvidenceParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<CommitEvidenceValue>> {
	const errors: ResearchError[] = [];
	const rejected: JsonValue[] = [];
	const claimIds: string[] = [];
	const evidenceIds: string[] = [];
	const supportStatuses = new Map<string, ClaimRecord["supportStatus"]>();
	const evidenceLevels: JsonValue[] = [];
	const outputs: RecordRef[] = [];

	for (const [index, draft] of params.claims.entries()) {
		const evidenceRefs: RecordRef[] = [];
		for (const evidenceId of [
			...draft.evidenceLinks.map(({ evidenceId }) => evidenceId),
			...draft.conflictEvidenceIds,
		]) {
			const evidence = await readRecord(project.root, "evidence", evidenceId);
			if (evidence.ok && evidence.value.kind === "evidence") {
				evidenceRefs.push({ kind: "evidence", id: evidenceId, revision: evidence.value.audit.revision });
			}
		}
		const inputUpdate = await addOperationInputs(project.root, operation.operationId, evidenceRefs, []);
		if (!inputUpdate.ok) return { result: inputUpdate };
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const committed = await commitClaim(project.root, {
			operationId: operation.operationId,
			expectedManifestRevision: opened.manifest.revision,
			draft: draft as ClaimDraft,
		});
		if (!committed.ok) {
			errors.push(...committed.errors);
			rejected.push({ kind: "claim", index, errors: committed.errors });
			continue;
		}
		claimIds.push(committed.value.claimId);
		supportStatuses.set(committed.value.claimId, committed.value.supportStatus);
		outputs.push({ kind: "claim", id: committed.value.claimId, revision: committed.value.audit.revision });
	}

	for (const [index, draft] of params.evidenceCards.entries()) {
		const source = await readRecord(project.root, "source", draft.sourceId);
		if (!source.ok || source.value.kind !== "source") {
			const failure = source.ok
				? failureResult(
						"PERMANENT_FAILURE",
						"EVIDENCE_SOURCE_INVALID",
						"integrity",
						`Record ${draft.sourceId} is not a source`,
						operation.operationId,
					)
				: source;
			errors.push(...failure.errors);
			rejected.push({ kind: "evidence", index, errors: failure.errors });
			continue;
		}
		const inputs: RecordRef[] = [
			{ kind: "source", id: source.value.sourceId, revision: source.value.audit.revision },
		];
		const inputFiles: FileRef[] = [];
		const linkedClaims = new Map<string, ClaimRecord>();
		if (draft.documentId !== null) {
			const document = await readRecord(project.root, "document", draft.documentId);
			if (!document.ok || document.value.kind !== "document") {
				const failure = document.ok
					? failureResult(
							"PERMANENT_FAILURE",
							"EVIDENCE_DOCUMENT_INVALID",
							"integrity",
							`Record ${draft.documentId} is not a document`,
							operation.operationId,
						)
					: document;
				errors.push(...failure.errors);
				rejected.push({ kind: "evidence", index, errors: failure.errors });
				continue;
			}
			inputs.push({ kind: "document", id: document.value.documentId, revision: document.value.audit.revision });
			if (document.value.localFile !== null) inputFiles.push(document.value.localFile);
			if (document.value.parsedOutput !== null) inputFiles.push(document.value.parsedOutput);
		}
		for (const { claimId } of draft.claimLinks) {
			const claim = await readRecord(project.root, "claim", claimId);
			if (claim.ok && claim.value.kind === "claim") {
				linkedClaims.set(claimId, claim.value);
				inputs.push({ kind: "claim", id: claimId, revision: claim.value.audit.revision });
			}
		}
		const inputUpdate = await addOperationInputs(project.root, operation.operationId, inputs, inputFiles);
		if (!inputUpdate.ok) return { result: inputUpdate };
		const evidenceDraft: EvidenceCardDraft = {
			...draft,
			extraction: {
				method: draft.extraction.method,
				operationId: operation.operationId,
				modelProvider: null,
				modelId: null,
				promptHash: null,
			},
		};
		const validated = await validateEvidenceCardDraft(project.root, evidenceDraft, operation.operationId);
		if (!validated.ok) {
			errors.push(...validated.errors);
			rejected.push({ kind: "evidence", index, errors: validated.errors });
			continue;
		}
		const fingerprint = evidenceFingerprint(validated.value.card).value;
		const existing = await findActiveEvidenceCardByFingerprint(project.root, fingerprint, operation.operationId);
		if (!existing.ok) return { result: existing };
		const approvedReviewedClaims = new Set<string>();
		let approvalBlocked = false;
		for (const link of draft.claimLinks) {
			const claim = linkedClaims.get(link.claimId);
			if (claim === undefined || claim.humanConfirmation.status === "not_reviewed") continue;
			const existingEvidenceId = existing.value?.evidenceId;
			const storedLink =
				existingEvidenceId === undefined
					? undefined
					: claim.evidenceLinks.find(({ evidenceId }) => evidenceId === existingEvidenceId);
			const alreadyLinked =
				storedLink?.relation === link.relation &&
				storedLink.assessment === link.rationale &&
				(link.relation !== "refutes" || claim.conflictEvidenceIds.includes(existingEvidenceId ?? ""));
			if (alreadyLinked) continue;
			const approval = await approveReviewedClaimLink(
				project.root,
				ctx,
				operation.operationId,
				claim,
				fingerprint,
				existing.value,
			);
			if (!approval.ok) {
				errors.push(...approval.errors);
				rejected.push({
					kind: "evidence",
					index,
					claimId: link.claimId,
					errors: approval.errors,
				});
				approvalBlocked = true;
				break;
			}
			approvedReviewedClaims.add(link.claimId);
		}
		if (approvalBlocked) continue;
		const beforeCommit = await openProject(project.root);
		if (beforeCommit.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const committed = await commitEvidenceCard(project.root, {
			operationId: operation.operationId,
			expectedManifestRevision: beforeCommit.manifest.revision,
			validationMode: params.validationMode,
			draft: evidenceDraft,
		});
		if (!committed.ok) {
			errors.push(...committed.errors);
			rejected.push({ kind: "evidence", index, errors: committed.errors });
			continue;
		}
		evidenceIds.push(committed.value.evidenceId);
		evidenceLevels.push({ evidenceId: committed.value.evidenceId, evidenceLevel: committed.value.evidenceLevel });
		outputs.push({ kind: "evidence", id: committed.value.evidenceId, revision: committed.value.audit.revision });
		for (const link of committed.value.claimLinks) {
			const linked = await linkEvidenceToClaim(
				project.root,
				operation.operationId,
				link.claimId,
				committed.value,
				link.relation,
				link.rationale,
				approvedReviewedClaims.has(link.claimId),
			);
			if (!linked.ok) {
				errors.push(...linked.errors);
				rejected.push({
					kind: "claim_link",
					claimId: link.claimId,
					evidenceId: committed.value.evidenceId,
					errors: linked.errors,
				});
				continue;
			}
			supportStatuses.set(linked.value.claimId, linked.value.supportStatus);
			outputs.push({ kind: "claim", id: linked.value.claimId, revision: linked.value.audit.revision });
		}
	}

	const value: CommitEvidenceValue = {
		claimIds: [...new Set(claimIds)],
		evidenceIds: [...new Set(evidenceIds)],
		rejected,
		supportStatuses: [...supportStatuses].map(([claimId, supportStatus]) => ({ claimId, supportStatus })),
		evidenceLevels,
	};
	return {
		result: researchResult(value, operation.operationId, errors, outputs.length > 0),
		outputs: [...new Map(outputs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()],
	};
}

async function cachedCitation(
	project: CurrentProject,
	source: SourceRecord,
	providers: readonly ("crossref" | "openalex")[],
): Promise<CitationVerification | null> {
	const expectedProviders = [...new Set(providers)].sort().join(",");
	for (const verificationId of await listProjectRecordIds(project.root, project.manifest, "citation_verification")) {
		const result = await readRecord(project.root, "citation_verification", verificationId);
		if (!result.ok || result.value.kind !== "citation_verification") {
			throw new TypeError(`Invalid citation verification record: ${verificationId}`);
		}
		const verification = result.value;
		if (
			verification.sourceId !== source.sourceId ||
			verification.expiresAt === null ||
			Date.parse(verification.expiresAt) <= Date.now() ||
			verification.finalStatus === "service_unavailable" ||
			verification.finalStatus === "incomplete" ||
			[...new Set(verification.verificationSources.map(({ adapterId }) => adapterId))].sort().join(",") !==
				expectedProviders
		) {
			continue;
		}
		const creator = await readRecord(project.root, "operation", verification.audit.createdByOperationId);
		if (
			creator.ok &&
			creator.value.kind === "operation" &&
			creator.value.implementationVersion === CITATION_VERIFIER_VERSION &&
			creator.value.inputs.some(
				(input) =>
					input.kind === "source" && input.id === source.sourceId && input.revision === source.audit.revision,
			)
		) {
			return verification;
		}
	}
	return null;
}

interface VerifyCitationsValue {
	verifications: JsonValue[];
	cachedVerificationIds: string[];
}

async function verifyCitations(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: Static<typeof VerifyCitationsParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<VerifyCitationsValue>> {
	const errors: ResearchError[] = [];
	const verifications: JsonValue[] = [];
	const cachedVerificationIds: string[] = [];
	const outputs: RecordRef[] = [];
	for (const sourceId of [...new Set(params.sourceIds)]) {
		const source = await sourceRecord(project.root, sourceId, operation.operationId);
		if (!source.ok) {
			errors.push(...source.errors);
			continue;
		}
		if (params.refresh === "use-cache") {
			const cached = await cachedCitation(project, source.value, params.providers);
			if (cached !== null) {
				cachedVerificationIds.push(cached.verificationId);
				outputs.push({
					kind: "citation_verification",
					id: cached.verificationId,
					revision: cached.audit.revision,
				});
				verifications.push({
					sourceId,
					verificationId: cached.verificationId,
					finalStatus: cached.finalStatus,
					publicationStatus: cached.publicationStatus,
					cached: true,
				});
				continue;
			}
		}
		const providerRuns: CitationAdapterRun[] = [];
		for (const provider of [...new Set(params.providers)]) {
			const adapter = sourceAdapter(provider, options);
			const identifier =
				provider === "crossref"
					? source.value.identifiers.find(({ scheme }) => scheme === "doi")
					: (source.value.identifiers.find(({ scheme }) => scheme === "doi") ??
						source.value.identifiers.find(({ scheme }) => scheme === "openalex"));
			const lookup = await adapterOperation<JsonValue>(
				project,
				ctx,
				adapter,
				"lookup",
				[{ kind: "source", id: sourceId, revision: source.value.audit.revision }],
				signal,
				defaultHttpOptions(options),
				(context) =>
					identifier === undefined
						? Promise.resolve(
								failureResult<JsonValue>(
									"PERMANENT_FAILURE",
									"CITATION_IDENTIFIER_REQUIRED",
									"validation",
									`${provider} cannot verify this source without a supported identifier`,
									context.operationId,
								),
							)
						: adapter.lookup(identifier, context),
			);
			providerRuns.push({ check: "lookup", operationId: lookup.operationId, result: lookup.result });
			errors.push(...lookup.result.errors);
			if (provider === "crossref") {
				const status = await adapterOperation<JsonValue>(
					project,
					ctx,
					adapter,
					"publication-status",
					[{ kind: "source", id: sourceId, revision: source.value.audit.revision }],
					signal,
					defaultHttpOptions(options),
					(context) =>
						identifier === undefined
							? Promise.resolve(
									failureResult<JsonValue>(
										"PERMANENT_FAILURE",
										"CITATION_IDENTIFIER_REQUIRED",
										"validation",
										"Crossref publication status requires a DOI",
										context.operationId,
									),
								)
							: (adapter as CrossrefAdapter).statusRelations(identifier, context),
				);
				providerRuns.push({
					check: "publication_status",
					operationId: status.operationId,
					result: status.result,
				});
				errors.push(...status.result.errors);
			}
		}
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const verified = await verifyCitation(project.root, {
			sourceId,
			citationKey: null,
			providerRuns,
			refresh: params.refresh,
			matchThresholds: params.matchThresholds,
			operationId: operation.operationId,
			expectedManifestRevision: opened.manifest.revision,
		});
		if (!verified.ok) {
			errors.push(...verified.errors);
			continue;
		}
		outputs.push({
			kind: "citation_verification",
			id: verified.value.verificationId,
			revision: verified.value.audit.revision,
		});
		verifications.push({
			sourceId,
			verificationId: verified.value.verificationId,
			finalStatus: verified.value.finalStatus,
			publicationStatus: verified.value.publicationStatus,
			fieldChecks: verified.value.fieldChecks,
			conflicts: verified.value.conflicts,
			cached: false,
		});
	}
	return {
		result: researchResult(
			{ verifications, cachedVerificationIds },
			operation.operationId,
			errors,
			verifications.length > 0,
		),
		outputs,
	};
}

async function artifactTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof ArtifactsParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<ArtifactToolValue>> {
	if (params.action === "validate") {
		if (params.sourceRefs.length !== 1 || params.sourceRefs[0]?.kind !== "artifact") {
			return {
				result: failureResult(
					"PERMANENT_FAILURE",
					"ARTIFACT_VALIDATE_INPUT_INVALID",
					"validation",
					"validate requires exactly one ArtifactRecord reference",
					operation.operationId,
				),
			};
		}
		const artifactRef = params.sourceRefs[0];
		const artifactResult = await readRecord(project.root, "artifact", artifactRef.id);
		if (!artifactResult.ok) return { result: propagatedFailure(artifactResult, operation.operationId) };
		if (artifactResult.value.kind !== "artifact") {
			return {
				result: failureResult(
					"PERMANENT_FAILURE",
					"ARTIFACT_RECORD_INVALID",
					"integrity",
					`Record ${artifactRef.id} is not an artifact`,
					operation.operationId,
				),
			};
		}
		const artifact: ArtifactRecord = artifactResult.value;
		const inputUpdate = await addOperationInputs(
			project.root,
			operation.operationId,
			[{ kind: "artifact", id: artifact.artifactId, revision: artifact.audit.revision }],
			[artifact.outputFile],
		);
		if (!inputUpdate.ok) return { result: propagatedFailure(inputUpdate, operation.operationId) };
		const result = await validateArtifact(
			project.root,
			artifact.artifactId,
			artifactRef.revision,
			params.artifactType,
			params.targetStatus,
			operation.operationId,
		);
		return result.ok
			? {
					result,
					outputs: [
						{
							kind: "artifact",
							id: result.value.artifact.artifactId,
							revision: result.value.artifact.audit.revision,
						},
					],
					outputFiles: [result.value.artifact.outputFile],
				}
			: { result };
	}

	const prepared = await prepareArtifact(
		project.root,
		{
			action: params.action,
			artifactType: params.artifactType,
			content: params.content ?? null,
			sourceRefs: params.sourceRefs,
			targetStatus: params.targetStatus,
			outputPath: params.outputPath ?? null,
		},
		operation.operationId,
	);
	if (!prepared.ok) return { result: prepared };
	const inputUpdate = await addOperationInputs(
		project.root,
		operation.operationId,
		prepared.value.snapshot.sourceRecords,
		prepared.value.snapshot.sourceFiles,
	);
	if (!inputUpdate.ok) return { result: propagatedFailure(inputUpdate, operation.operationId) };

	let submissionApprovalId: string | null = null;
	if (params.targetStatus === "submission_candidate" && prepared.value.validation.status !== "failed") {
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const request = createActionRequest({
			projectId: opened.manifest.projectId,
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionClass: "publish_or_submit",
			actionName: "research.artifact.mark_submission_candidate",
			destination: null,
			paths: [prepared.value.outputFile.path],
			dataClasses: ["research_artifact"],
			estimatedCost: null,
			destructive: false,
			recoverable: true,
			fingerprintParameters: {
				artifactType: params.artifactType,
				inputAggregateHash: prepared.value.inputAggregateHash,
				validationHash: hashCanonicalJson(prepared.value.validation),
			},
			policy: opened.manifest.policy,
		});
		const approval = await approveArtifactAction(
			opened.root,
			operation.operationId,
			ctx,
			request,
			"Confirm submission candidate",
			`Mark this evidence-checked review as a submission candidate? This does not confirm overall paper quality.${prepared.value.validation.checks
				.filter(({ status }) => status === "warning")
				.map(({ message }) => `\n- ${message}`)
				.join("")}`,
			prepared.value.snapshot.sourceRecords,
			prepared.value.snapshot.sourceFiles,
		);
		if (!approval.ok) return { result: approval };
		submissionApprovalId = approval.value;
	}

	let committed = await commitPreparedArtifact(
		project.root,
		prepared.value,
		operation.operationId,
		ctx.sessionManager.getSessionId(),
		submissionApprovalId,
	);
	if (!committed.ok && committed.errors[0].code === "APPROVAL_REQUIRED") {
		const details = objectValue(committed.errors[0].details, "Artifact file approval");
		const actionClass = details.actionClass;
		if (actionClass !== "project_create" && actionClass !== "project_overwrite") return { result: committed };
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const request = createActionRequest({
			projectId: opened.manifest.projectId,
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionClass,
			actionName: "project.file.write",
			destination: null,
			paths: [prepared.value.outputFile.path],
			dataClasses: ["research_artifact"],
			estimatedCost: null,
			destructive: false,
			recoverable: true,
			fingerprintParameters: { contentHash: prepared.value.outputFile.hash },
			policy: opened.manifest.policy,
		});
		const approval = await approveArtifactAction(
			opened.root,
			operation.operationId,
			ctx,
			request,
			"Overwrite research artifact",
			`Write ${prepared.value.outputFile.path}, replacing its current contents?`,
			prepared.value.snapshot.sourceRecords,
			prepared.value.snapshot.sourceFiles,
		);
		if (!approval.ok) return { result: approval };
		committed = await commitPreparedArtifact(
			project.root,
			prepared.value,
			operation.operationId,
			ctx.sessionManager.getSessionId(),
			submissionApprovalId,
		);
	}
	return committed.ok
		? {
				result: committed,
				outputs: [
					{
						kind: "artifact",
						id: committed.value.artifact.artifactId,
						revision: committed.value.artifact.audit.revision,
					},
				],
				outputFiles: [committed.value.artifact.outputFile],
			}
		: { result: committed };
}

function unavailableToolResult<Value>(error: unknown): AgentToolResult<ResearchResult<Value>> {
	return toolResponse(thrownFailure<Value>(error, null));
}

async function sourceInputs(projectRoot: string, sourceIds: readonly string[]): Promise<RecordRef[]> {
	const inputs: RecordRef[] = [];
	for (const sourceId of [...new Set(sourceIds)]) {
		const result = await readRecord(projectRoot, "source", sourceId);
		if (result.ok && result.value.kind === "source") {
			inputs.push({ kind: "source", id: sourceId, revision: result.value.audit.revision });
		}
	}
	return inputs;
}

function designDraft(params: Static<typeof DesignParameters>): DesignDraft {
	switch (params.action) {
		case "create_question":
			return {
				kind: "research_question_version",
				value: {
					questionSeriesId: params.questionSeriesId,
					version: params.version,
					text: params.text,
					questionType: params.questionType,
					rationale: params.rationale,
					scope: params.scope,
					boundaryConditions: params.boundaryConditions,
					basis: params.basis,
					supersedesResearchQuestionVersionId: params.supersedesResearchQuestionVersionId,
				},
			};
		case "create_concept":
			return {
				kind: "concept",
				value: {
					name: params.name,
					definition: params.definition,
					role: params.role,
					aliases: params.aliases,
					measurementNotes: params.measurementNotes,
					boundaryConditions: params.boundaryConditions,
					basis: params.basis,
					supersedesConceptId: params.supersedesConceptId,
				},
			};
		case "create_relation":
			return {
				kind: "theory_relation",
				value: {
					fromConceptId: params.fromConceptId,
					toConceptId: params.toConceptId,
					relationType: params.relationType,
					direction: params.direction,
					statement: params.statement,
					hypothesesOrPropositions: params.hypothesesOrPropositions,
					boundaryConditions: params.boundaryConditions,
					alternativeExplanations: params.alternativeExplanations,
					basis: params.basis,
					supersedesTheoryRelationId: params.supersedesTheoryRelationId,
				},
			};
		case "create_decision":
			return {
				kind: "design_decision",
				value: {
					decisionType: params.decisionType,
					question: params.question,
					options: params.options,
					selectedOptionId: params.selectedOptionId,
					rationale: params.rationale,
					alternativesConsidered: params.alternativesConsidered,
					limitations: params.limitations,
					basis: params.basis,
					critical: params.critical,
					supersedesDesignDecisionId: params.supersedesDesignDecisionId,
				},
			};
		case "create_protocol":
			return {
				kind: "protocol",
				value: {
					title: params.title,
					researchQuestionVersionId: params.researchQuestionVersionId,
					designType: params.designType,
					claimMode: params.claimMode,
					method: params.method,
					population: params.population,
					unitOfAnalysis: params.unitOfAnalysis,
					timeframe: params.timeframe,
					samplingPlan: params.samplingPlan,
					measurementPlan: params.measurementPlan,
					dataCollectionPlan: params.dataCollectionPlan,
					analysisPlan: params.analysisPlan,
					identificationStrategy: params.identificationStrategy,
					identificationAssumptions: params.identificationAssumptions,
					preanalysisPlan: params.preanalysisPlan,
					interviewPlan: params.interviewPlan,
					caseSelectionPlan: params.caseSelectionPlan,
					inclusionCriteria: params.inclusionCriteria,
					exclusionCriteria: params.exclusionCriteria,
					alternativeExplanations: params.alternativeExplanations,
					boundaryConditions: params.boundaryConditions,
					feasibilityLimits: params.feasibilityLimits,
					ethicsChecklist: params.ethicsChecklist,
					decisionIds: params.decisionIds,
					conceptIds: params.conceptIds,
					theoryRelationIds: params.theoryRelationIds,
					basis: params.basis,
					supersedesProtocolId: params.supersedesProtocolId,
				},
			};
		case "confirm":
			throw new TypeError("Confirmation is not a design draft");
	}
}

function requestedDesignInputs(params: Static<typeof DesignParameters>): RecordRef[] {
	if (params.action === "confirm") {
		return [{ kind: params.recordKind, id: params.recordId, revision: params.expectedRecordRevision }];
	}
	const refs: RecordRef[] = [...params.basis.provenance];
	if (params.action === "create_question" && params.supersedesResearchQuestionVersionId !== null) {
		refs.push({
			kind: "research_question_version",
			id: params.supersedesResearchQuestionVersionId,
			revision: null,
		});
	}
	if (params.action === "create_concept" && params.supersedesConceptId !== null) {
		refs.push({ kind: "concept", id: params.supersedesConceptId, revision: null });
	}
	if (params.action === "create_relation") {
		refs.push(
			{ kind: "concept", id: params.fromConceptId, revision: null },
			{ kind: "concept", id: params.toConceptId, revision: null },
		);
		if (params.supersedesTheoryRelationId !== null) {
			refs.push({ kind: "theory_relation", id: params.supersedesTheoryRelationId, revision: null });
		}
	}
	if (params.action === "create_decision" && params.supersedesDesignDecisionId !== null) {
		refs.push({ kind: "design_decision", id: params.supersedesDesignDecisionId, revision: null });
	}
	if (params.action === "create_protocol") {
		refs.push({ kind: "research_question_version", id: params.researchQuestionVersionId, revision: null });
		refs.push(...params.decisionIds.map((id) => ({ kind: "design_decision" as const, id, revision: null })));
		refs.push(...params.conceptIds.map((id) => ({ kind: "concept" as const, id, revision: null })));
		refs.push(...params.theoryRelationIds.map((id) => ({ kind: "theory_relation" as const, id, revision: null })));
		if (params.supersedesProtocolId !== null) {
			refs.push({ kind: "protocol", id: params.supersedesProtocolId, revision: null });
		}
	}
	return refs;
}

async function resolveDesignInputs(projectRoot: string, refs: readonly RecordRef[]): Promise<RecordRef[]> {
	const resolved: RecordRef[] = [];
	for (const ref of refs) {
		const result = await readRecord(projectRoot, ref.kind, ref.id);
		if (!result.ok) throw new TypeError(result.errors[0].message);
		const revision = projectRecordRevision(result.value);
		if (ref.revision !== null && revision < ref.revision) {
			throw new TypeError(`Design input references future ${ref.kind} ${ref.id} revision ${ref.revision}`);
		}
		resolved.push({ ...ref, revision: ref.revision ?? revision });
	}
	return [...new Map(resolved.map((ref) => [`${ref.kind}:${ref.id}:${ref.revision}`, ref])).values()];
}

function designRecordLabel(record: DesignRecord): string {
	switch (record.kind) {
		case "research_question_version":
			return record.text;
		case "concept":
			return `${record.name}: ${record.definition}`;
		case "theory_relation":
			return record.statement;
		case "design_decision":
			return record.question;
		case "protocol":
			return record.title;
	}
}

async function designTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof DesignParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<DesignRecord>> {
	if (params.action !== "confirm") {
		const result = await commitDesignDraft(project.root, operation.operationId, designDraft(params));
		return result.ok
			? {
					result,
					outputs: [
						{ kind: result.value.kind, id: projectRecordId(result.value), revision: result.value.audit.revision },
					],
				}
			: { result };
	}
	const awaiting = await markDesignAwaitingConfirmation(
		project.root,
		params.recordKind as DesignRecordKind,
		params.recordId,
		params.expectedRecordRevision,
		operation.operationId,
	);
	if (!awaiting.ok) return { result: awaiting };
	if (!ctx.hasUI) {
		return {
			result: failureResult(
				"PERMISSION_BLOCKED",
				"DESIGN_USER_CONFIRMATION_REQUIRED",
				"permission",
				`${params.recordKind} ${params.recordId} is awaiting user confirmation`,
				operation.operationId,
			),
		};
	}
	const confirmed = await ctx.ui.confirm(
		"Confirm research design record",
		`${designRecordLabel(awaiting.value)}\n\nChoose Yes to confirm. Choose No to preserve this version as rejected.`,
	);
	const decided = await decideDesignRecord(
		project.root,
		params.recordKind as DesignRecordKind,
		params.recordId,
		awaiting.value.audit.revision,
		confirmed ? "confirmed" : "rejected",
		params.note ?? null,
		operation.operationId,
	);
	return decided.ok
		? {
				result: decided,
				outputs: [
					{
						kind: decided.value.kind,
						id: projectRecordId(decided.value),
						revision: decided.value.audit.revision,
					},
				],
			}
		: { result: decided };
}

export function registerResearchTools(pi: ExtensionAPI, options: RegisterResearchToolsOptions): void {
	pi.registerTool({
		name: "research_search_sources",
		label: "Search research sources",
		description:
			"Execute a frozen Crossref/OpenAlex search plan through governed adapters and commit normalized source records.",
		promptSnippet: "Search academic metadata with a bounded, auditable query plan",
		parameters: SearchSourcesParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const project = await options.requireProject(ctx);
				const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
				return toolResponse(
					await trackedTool(project, ctx, options, "research.search_sources", (operation) =>
						searchSources(project, ctx, options, params, operation, executionSignal),
					),
				);
			} catch (error) {
				return unavailableToolResult(error);
			}
		},
	});

	pi.registerTool({
		name: "research_import_sources",
		label: "Import research sources",
		description: "Import local RIS, BibTeX, CSL-JSON, or PDF files through the governed project store.",
		promptSnippet: "Import local bibliography and document inputs without writing canonical JSON directly",
		parameters: ImportSourcesParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const project = await options.requireProject(ctx);
				return toolResponse(
					await trackedTool(project, ctx, options, "research.import_sources", (operation) =>
						importSources(project, ctx, params, operation),
					),
				);
			} catch (error) {
				return unavailableToolResult(error);
			}
		},
	});

	pi.registerTool({
		name: "research_documents",
		label: "Manage research documents",
		description: "Locate, acquire, or parse research documents while preserving access and failure states.",
		promptSnippet: "Locate, acquire, and parse full text without bypassing access controls",
		parameters: DocumentsParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const project = await options.requireProject(ctx);
				const inputs = await sourceInputs(project.root, params.sourceIds);
				const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
				return toolResponse(
					await trackedTool(
						project,
						ctx,
						options,
						"research.documents",
						(operation) => documents(project, ctx, options, params, operation, executionSignal),
						inputs,
					),
				);
			} catch (error) {
				return unavailableToolResult(error);
			}
		},
	});

	pi.registerTool({
		name: "research_query_corpus",
		label: "Query research corpus",
		description: "Query canonical records and parsed PDF blocks with bounded deterministic pagination.",
		promptSnippet: "Read bounded, source-located corpus hits",
		parameters: QueryCorpusParameters,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const project = await options.requireProject(ctx);
				const result = await queryCorpusRecords(project.root, params, toolCallId);
				return toolResponse(withoutOperation(result));
			} catch (error) {
				return unavailableToolResult(error);
			}
		},
	});

	pi.registerTool({
		name: "research_commit_evidence",
		label: "Commit research evidence",
		description:
			"Validate and commit claim drafts and evidence drafts. Exact excerpts and evidence levels are checked deterministically.",
		promptSnippet: "Commit claims and evidence only after deterministic provenance checks",
		parameters: CommitEvidenceParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const project = await options.requireProject(ctx);
				if (project.manifest.revision !== params.expectedRevision) {
					return toolResponse(
						failureResult(
							"DATA_CONFLICT",
							"EVIDENCE_REVISION_CONFLICT",
							"data_conflict",
							`Expected project revision ${params.expectedRevision}, found ${project.manifest.revision}`,
							null,
						),
					);
				}
				return toolResponse(
					await trackedTool(project, ctx, options, "research.commit_evidence", (operation) =>
						commitEvidence(project, ctx, params, operation),
					),
				);
			} catch (error) {
				return unavailableToolResult(error);
			}
		},
	});

	pi.registerTool({
		name: "research_verify_citations",
		label: "Verify research citations",
		description: "Verify source identifiers and metadata through governed Crossref/OpenAlex lookups.",
		promptSnippet: "Verify citation fields and publication status without treating service failure as success",
		parameters: VerifyCitationsParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const project = await options.requireProject(ctx);
				const inputs = await sourceInputs(project.root, params.sourceIds);
				const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
				return toolResponse(
					await trackedTool(
						project,
						ctx,
						options,
						"research.verify_citations",
						(operation) => verifyCitations(project, ctx, options, params, operation, executionSignal),
						inputs,
						[],
						CITATION_VERIFIER_VERSION,
					),
				);
			} catch (error) {
				return unavailableToolResult(error);
			}
		},
	});

	pi.registerTool({
		name: "research_artifacts",
		label: "Generate research artifacts",
		description:
			"Generate deterministic Markdown, JSON, RIS, or BibTeX artifacts and enforce evidence and submission gates.",
		promptSnippet:
			"Generate project artifacts without treating unlocated evidence or unverified citations as complete",
		parameters: ArtifactsParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const project = await options.requireProject(ctx);
				return toolResponse(
					await trackedTool(project, ctx, options, "research.artifacts", (operation) =>
						artifactTool(project, ctx, params, operation),
					),
				);
			} catch (error) {
				return unavailableToolResult(error);
			}
		},
	});

	pi.registerTool({
		name: "research_design",
		label: "Build research design",
		description:
			"Create versioned research questions, concepts, theory relations, design decisions, and protocols, then request explicit user confirmation.",
		promptSnippet: "Turn canonical evidence and gaps into a user-confirmed research design",
		parameters: DesignParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const project = await options.requireProject(ctx);
				if (project.manifest.revision !== params.expectedRevision) {
					return toolResponse(
						failureResult(
							"DATA_CONFLICT",
							"DESIGN_PROJECT_REVISION_CONFLICT",
							"data_conflict",
							`Expected project revision ${params.expectedRevision}, found ${project.manifest.revision}`,
							null,
						),
					);
				}
				const inputs = await resolveDesignInputs(project.root, requestedDesignInputs(params));
				return toolResponse(
					await trackedTool(
						project,
						ctx,
						options,
						"research.design",
						(operation) => designTool(project, ctx, params, operation),
						inputs,
					),
				);
			} catch (error) {
				return unavailableToolResult(error);
			}
		},
	});
}
