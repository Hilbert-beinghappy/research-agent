// SPDX-License-Identifier: Apache-2.0

import { type Static, Type } from "typebox";
import { JsonValueSchema } from "./schemas.ts";

export const MEMORY_SCHEMA_VERSION = "1.0.0" as const;
export const MEMORY_HASH_PATTERN = "^sha256:[a-f0-9]{64}$";
export const MEMORY_LOGICAL_LOCATOR_PATTERN = "^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}$";

const StrictObject = <const Properties extends Parameters<typeof Type.Object>[0]>(properties: Properties) =>
	Type.Object(properties, { additionalProperties: false });
const IdentifierSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const CodeSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z0-9][a-z0-9_.-]*$" });
const IsoDateTimeSchema = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});
const Sha256Schema = Type.String({ pattern: MEMORY_HASH_PATTERN });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const NonNegativeNumberSchema = Type.Number({ minimum: 0 });
const ProbabilitySchema = Type.Number({ minimum: 0, maximum: 1 });

export const MemoryCategorySchema = Type.Union([
	Type.Literal("domain"),
	Type.Literal("theory"),
	Type.Literal("method"),
	Type.Literal("evidence"),
	Type.Literal("writing"),
	Type.Literal("workflow"),
	Type.Literal("tool"),
	Type.Literal("output"),
]);
export type MemoryCategory = Static<typeof MemoryCategorySchema>;

export const MEMORY_KEY_ALLOWLIST = {
	domain: ["preferred_domain_ids", "preferred_topic_ids"],
	theory: ["preferred_theory_ids", "preferred_framework_ids"],
	method: ["preferred_method_ids", "preferred_analysis_ids"],
	evidence: ["preferred_source_types", "source_order", "presentation_style"],
	writing: [
		"language",
		"terminology_ids",
		"target_length",
		"heading_level",
		"representation",
		"tone",
		"citation_style",
	],
	workflow: ["non_destructive_defaults", "stage_order", "review_depth"],
	tool: ["tool_order"],
	output: ["artifact_format", "filename_template_id", "presentation_style"],
} as const satisfies Record<MemoryCategory, readonly string[]>;

export const DataClassSchema = Type.Union([
	Type.Literal("public"),
	Type.Literal("internal"),
	Type.Literal("restricted"),
]);
export type DataClass = Static<typeof DataClassSchema>;

export const ProfileStatusSchema = Type.Union([
	Type.Literal("active"),
	Type.Literal("paused"),
	Type.Literal("deleted"),
]);
export type ProfileStatus = Static<typeof ProfileStatusSchema>;

export const MemoryStatusSchema = Type.Union([
	Type.Literal("candidate"),
	Type.Literal("active"),
	Type.Literal("superseded"),
	Type.Literal("forgotten"),
	Type.Literal("quarantined"),
]);
export type MemoryStatus = Static<typeof MemoryStatusSchema>;

export const MemoryEffectSchema = Type.Union([
	Type.Literal("routing"),
	Type.Literal("ranking"),
	Type.Literal("prompt_context"),
	Type.Literal("formatting"),
	Type.Literal("tool_order"),
	Type.Literal("recommendation"),
]);
export type MemoryEffect = Static<typeof MemoryEffectSchema>;

export const MemoryScopeSchema = Type.Union([
	StrictObject({ level: Type.Literal("global") }),
	StrictObject({ level: Type.Literal("domain"), domainId: IdentifierSchema }),
	StrictObject({ level: Type.Literal("project"), projectId: IdentifierSchema }),
]);
export type MemoryScope = Static<typeof MemoryScopeSchema>;

export const SafeRefSchema = StrictObject({
	kind: Type.Union([
		Type.Literal("session"),
		Type.Literal("project"),
		Type.Literal("task"),
		Type.Literal("operation"),
		Type.Literal("artifact"),
		Type.Literal("signal"),
		Type.Literal("memory"),
		Type.Literal("receipt"),
		Type.Literal("feedback"),
	]),
	locator: Type.String({ minLength: 3, maxLength: 264, pattern: MEMORY_LOGICAL_LOCATOR_PATTERN }),
	revision: Type.Optional(NonNegativeIntegerSchema),
	contentHash: Type.Optional(Sha256Schema),
	dataClass: DataClassSchema,
});
export type SafeRef = Static<typeof SafeRefSchema>;

export const MemoryRevisionRefSchema = StrictObject({
	memoryId: IdentifierSchema,
	revision: Type.Integer({ minimum: 1 }),
});
export type MemoryRevisionRef = Static<typeof MemoryRevisionRefSchema>;

export const MemoryPreferenceRefsSchema = StrictObject({
	domain: Type.Optional(Type.Array(MemoryRevisionRefSchema, { uniqueItems: true })),
	theory: Type.Optional(Type.Array(MemoryRevisionRefSchema, { uniqueItems: true })),
	method: Type.Optional(Type.Array(MemoryRevisionRefSchema, { uniqueItems: true })),
	evidence: Type.Optional(Type.Array(MemoryRevisionRefSchema, { uniqueItems: true })),
	writing: Type.Optional(Type.Array(MemoryRevisionRefSchema, { uniqueItems: true })),
	workflow: Type.Optional(Type.Array(MemoryRevisionRefSchema, { uniqueItems: true })),
	tool: Type.Optional(Type.Array(MemoryRevisionRefSchema, { uniqueItems: true })),
	output: Type.Optional(Type.Array(MemoryRevisionRefSchema, { uniqueItems: true })),
});
export type MemoryPreferenceRefs = Static<typeof MemoryPreferenceRefsSchema>;

export const ResearcherProfileV1Schema = StrictObject({
	format: Type.Literal("doro-researcher-profile"),
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	profileId: IdentifierSchema,
	revision: NonNegativeIntegerSchema,
	status: ProfileStatusSchema,
	preferenceRefs: MemoryPreferenceRefsSchema,
	learningPolicy: StrictObject({
		mode: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
		explicitAutoActivation: Type.Boolean(),
		inferredLowRiskThreshold: ProbabilitySchema,
		inferredResearchThreshold: ProbabilitySchema,
		minimumIndependentSignals: Type.Integer({ minimum: 1 }),
		maxItemsPerTask: Type.Integer({ minimum: 1 }),
		maxContextTokens: Type.Integer({ minimum: 1 }),
		criticalDecisionMode: Type.Literal("never_auto"),
	}),
	sensitivityPolicy: StrictObject({
		allowedDataClasses: Type.Array(DataClassSchema, { minItems: 1, uniqueItems: true }),
		restrictedProjectLearning: Type.Literal("disabled"),
		externalProviderMemoryView: Type.Union([Type.Literal("task_scoped_redacted"), Type.Literal("disabled")]),
		prohibitedAttributePolicyVersion: Type.String({ minLength: 1, maxLength: 128 }),
	}),
	retentionPolicy: StrictObject({
		signalDays: NonNegativeIntegerSchema,
		candidateDays: NonNegativeIntegerSchema,
		receiptDays: NonNegativeIntegerSchema,
		auditDays: NonNegativeIntegerSchema,
		tombstoneDays: Type.Union([NonNegativeIntegerSchema, Type.Literal("indefinite")]),
	}),
	budgetPolicy: StrictObject({
		maxInferenceCallsPerSession: NonNegativeIntegerSchema,
		maxInferenceCostUsdPerSession: NonNegativeNumberSchema,
		maxAdditionalTokensPerTask: NonNegativeIntegerSchema,
	}),
	currentItemRootHash: Sha256Schema,
	createdAt: IsoDateTimeSchema,
	updatedAt: IsoDateTimeSchema,
	createdBy: Type.Union([Type.Literal("user"), Type.Literal("migration")]),
	lastTransactionId: Type.Union([IdentifierSchema, Type.Null()]),
});
export type ResearcherProfileV1 = Static<typeof ResearcherProfileV1Schema>;

export const PreferenceSignalV1Schema = StrictObject({
	format: Type.Literal("doro-preference-signal"),
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	signalId: IdentifierSchema,
	profileId: IdentifierSchema,
	signalType: Type.Union([
		Type.Literal("explicit_statement"),
		Type.Literal("accept"),
		Type.Literal("reject"),
		Type.Literal("edit_diff"),
		Type.Literal("tool_choice"),
		Type.Literal("delivery_choice"),
	]),
	actor: Type.Literal("user"),
	observedAt: IsoDateTimeSchema,
	category: MemoryCategorySchema,
	normalizedKey: CodeSchema,
	normalizedValue: JsonValueSchema,
	scopeCandidate: MemoryScopeSchema,
	baseWeight: ProbabilitySchema,
	dedupeKey: Sha256Schema,
	dataClass: DataClassSchema,
	sourceRefs: Type.Array(SafeRefSchema, { minItems: 1 }),
	sourceContentHash: Type.Union([Sha256Schema, Type.Null()]),
	captureMethod: StrictObject({
		type: Type.Union([Type.Literal("deterministic"), Type.Literal("model_assisted")]),
		ruleVersion: Type.String({ minLength: 1, maxLength: 128 }),
		modelRef: Type.Optional(IdentifierSchema),
		promptHash: Type.Optional(Sha256Schema),
	}),
	trustState: Type.Union([
		Type.Literal("captured"),
		Type.Literal("accepted"),
		Type.Literal("quarantined"),
		Type.Literal("discarded"),
	]),
	rejectionCode: Type.Union([CodeSchema, Type.Null()]),
	createdAt: IsoDateTimeSchema,
});
export type PreferenceSignalV1 = Static<typeof PreferenceSignalV1Schema>;

export const SignalContentRefSchema = StrictObject({
	signalId: IdentifierSchema,
	contentHash: Sha256Schema,
});
export type SignalContentRef = Static<typeof SignalContentRefSchema>;

export const MemoryCandidateDraftV1Schema = StrictObject({
	format: Type.Literal("doro-memory-candidate-draft"),
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	candidateId: IdentifierSchema,
	profileId: IdentifierSchema,
	category: MemoryCategorySchema,
	key: CodeSchema,
	value: JsonValueSchema,
	proposedScope: MemoryScopeSchema,
	sourceSignalRefs: Type.Array(SignalContentRefSchema, { minItems: 1, uniqueItems: true }),
	proposedEffects: Type.Array(MemoryEffectSchema, { minItems: 1, uniqueItems: true }),
	rationaleCodes: Type.Array(CodeSchema, { minItems: 1, uniqueItems: true }),
	generatedBy: StrictObject({
		type: Type.Union([Type.Literal("rule"), Type.Literal("model")]),
		version: Type.String({ minLength: 1, maxLength: 128 }),
		modelRef: Type.Optional(IdentifierSchema),
		promptHash: Type.Optional(Sha256Schema),
		outputSchemaHash: Sha256Schema,
	}),
	createdAt: IsoDateTimeSchema,
});
export type MemoryCandidateDraftV1 = Static<typeof MemoryCandidateDraftV1Schema>;

export const MemoryItemV1Schema = StrictObject({
	format: Type.Literal("doro-memory-item"),
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	profileId: IdentifierSchema,
	memoryId: IdentifierSchema,
	revision: Type.Integer({ minimum: 1 }),
	previousRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
	status: MemoryStatusSchema,
	category: MemoryCategorySchema,
	key: CodeSchema,
	value: JsonValueSchema,
	origin: Type.Union([Type.Literal("explicit"), Type.Literal("inferred")]),
	scope: MemoryScopeSchema,
	confidence: ProbabilitySchema,
	supportCount: NonNegativeIntegerSchema,
	independentSupportCount: NonNegativeIntegerSchema,
	contradictionCount: NonNegativeIntegerSchema,
	dataClass: DataClassSchema,
	allowedEffects: Type.Array(MemoryEffectSchema, { uniqueItems: true }),
	criticalDecisionPolicy: Type.Union([
		Type.Literal("rank_only"),
		Type.Literal("format_only"),
		Type.Literal("not_applicable"),
	]),
	sourceSignalRefs: Type.Array(SignalContentRefSchema, { uniqueItems: true }),
	supersedes: Type.Array(MemoryRevisionRefSchema, { uniqueItems: true }),
	generator: StrictObject({
		type: Type.Union([
			Type.Literal("rule"),
			Type.Literal("model"),
			Type.Literal("user_correction"),
			Type.Literal("migration"),
		]),
		version: Type.String({ minLength: 1, maxLength: 128 }),
		modelRef: Type.Optional(IdentifierSchema),
		promptHash: Type.Optional(Sha256Schema),
		schemaHash: Sha256Schema,
	}),
	provenanceHash: Sha256Schema,
	validFrom: IsoDateTimeSchema,
	validUntil: Type.Union([IsoDateTimeSchema, Type.Null()]),
	lastSupportedAt: IsoDateTimeSchema,
	lastUsedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
	decay: StrictObject({ halfLifeDays: Type.Union([NonNegativeNumberSchema, Type.Null()]) }),
	createdAt: IsoDateTimeSchema,
	transactionId: IdentifierSchema,
});
export type MemoryItemV1 = Static<typeof MemoryItemV1Schema>;

export const MemoryUseReceiptV1Schema = StrictObject({
	format: Type.Literal("doro-memory-use-receipt"),
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	receiptId: IdentifierSchema,
	profileId: IdentifierSchema,
	sessionRef: SafeRefSchema,
	taskRef: SafeRefSchema,
	operationRef: Type.Union([SafeRefSchema, Type.Null()]),
	artifactRef: Type.Union([SafeRefSchema, Type.Null()]),
	itemRefs: Type.Array(
		StrictObject({
			memoryId: IdentifierSchema,
			revision: Type.Integer({ minimum: 1 }),
			provenanceHash: Sha256Schema,
		}),
		{ minItems: 1, uniqueItems: true },
	),
	effect: MemoryEffectSchema,
	decisionCodeBefore: CodeSchema,
	decisionCodeAfter: CodeSchema,
	explanationCodes: Type.Array(CodeSchema, { uniqueItems: true }),
	criticalResearchDecisionTouched: Type.Boolean(),
	approvalRequired: Type.Boolean(),
	appliedAt: IsoDateTimeSchema,
	retrievalLatencyMs: NonNegativeNumberSchema,
	addedContextTokens: NonNegativeIntegerSchema,
	estimatedCostUsd: NonNegativeNumberSchema,
	outcome: Type.Union([
		Type.Literal("applied"),
		Type.Literal("ignored"),
		Type.Literal("blocked"),
		Type.Literal("failed"),
	]),
	feedbackRefs: Type.Array(IdentifierSchema, { uniqueItems: true }),
	contextDigest: Sha256Schema,
});
export type MemoryUseReceiptV1 = Static<typeof MemoryUseReceiptV1Schema>;

export const MemoryFeedbackV1Schema = StrictObject({
	format: Type.Literal("doro-memory-feedback"),
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	feedbackId: IdentifierSchema,
	profileId: IdentifierSchema,
	target: MemoryRevisionRefSchema,
	action: Type.Union([
		Type.Literal("reinforce"),
		Type.Literal("correct"),
		Type.Literal("reject"),
		Type.Literal("downrank"),
		Type.Literal("forget"),
		Type.Literal("delete"),
		Type.Literal("restore"),
	]),
	correction: Type.Union([
		StrictObject({ key: CodeSchema, value: JsonValueSchema, scope: Type.Optional(MemoryScopeSchema) }),
		Type.Null(),
	]),
	actor: Type.Literal("user"),
	sourceRef: SafeRefSchema,
	reasonCode: Type.Union([CodeSchema, Type.Null()]),
	requestedAt: IsoDateTimeSchema,
	applicationStatus: Type.Union([Type.Literal("pending"), Type.Literal("applied"), Type.Literal("failed")]),
	resultingRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
	deactivatedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
	cacheInvalidatedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
	exportExclusionVerifiedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
	transactionId: Type.Union([IdentifierSchema, Type.Null()]),
	errorCode: Type.Union([CodeSchema, Type.Null()]),
});
export type MemoryFeedbackV1 = Static<typeof MemoryFeedbackV1Schema>;

export const MemoryDeletionTombstoneV1Schema = StrictObject({
	format: Type.Literal("doro-memory-deletion-tombstone"),
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	profileId: IdentifierSchema,
	memoryId: IdentifierSchema,
	terminalRevision: Type.Integer({ minimum: 2 }),
	lineageHash: Sha256Schema,
	deletedRecordHashes: Type.Array(Sha256Schema, { minItems: 1, uniqueItems: true }),
	relatedIdentifierHashes: Type.Array(Sha256Schema, { minItems: 1, uniqueItems: true }),
	deletedPathHashes: Type.Array(Sha256Schema, { minItems: 1, uniqueItems: true }),
	deletedAt: IsoDateTimeSchema,
	reasonCode: Type.Union([
		Type.Literal("user_requested"),
		Type.Literal("privacy_request"),
		Type.Literal("retention_expired"),
		Type.Literal("policy_required"),
	]),
	transactionId: IdentifierSchema,
});
export type MemoryDeletionTombstoneV1 = Static<typeof MemoryDeletionTombstoneV1Schema>;
