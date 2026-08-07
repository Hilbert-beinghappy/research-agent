// SPDX-License-Identifier: Apache-2.0

import { type Static, type TSchema, type TUnsafe, Type } from "typebox";

export const RESEARCH_SCHEMA_VERSION = "1.5.0" as const;
export const RESEARCH_V1_1_SCHEMA_VERSION = "1.1.0" as const;
export const RESEARCH_V1_0_SCHEMA_VERSION = "1.0.0" as const;
export const RESEARCH_V0_5_SCHEMA_VERSION = "0.5.0" as const;
export const RESEARCH_LEGACY_SCHEMA_VERSION = RESEARCH_V0_5_SCHEMA_VERSION;
export const RESEARCH_V0_4_SCHEMA_VERSION = "0.4.0" as const;
export const RESEARCH_V0_3_SCHEMA_VERSION = "0.3.0" as const;
export const RESEARCH_V0_2_SCHEMA_VERSION = "0.2.0" as const;
export const RESEARCH_V0_1_SCHEMA_VERSION = "0.1.0" as const;
export const RESEARCH_V1_0_MIGRATABLE_SCHEMA_VERSIONS = [
	RESEARCH_V0_1_SCHEMA_VERSION,
	RESEARCH_V0_2_SCHEMA_VERSION,
	RESEARCH_V0_3_SCHEMA_VERSION,
	RESEARCH_V0_4_SCHEMA_VERSION,
	RESEARCH_V0_5_SCHEMA_VERSION,
] as const;
export const RESEARCH_V1_1_MIGRATABLE_SCHEMA_VERSIONS = [
	...RESEARCH_V1_0_MIGRATABLE_SCHEMA_VERSIONS,
	RESEARCH_V1_0_SCHEMA_VERSION,
] as const;
export const RESEARCH_MIGRATABLE_SCHEMA_VERSIONS = [
	...RESEARCH_V1_1_MIGRATABLE_SCHEMA_VERSIONS,
	RESEARCH_V1_1_SCHEMA_VERSION,
] as const;

const PersistedObject = <const Properties extends Parameters<typeof Type.Object>[0]>(properties: Properties) =>
	Type.Object(properties, { additionalProperties: true });
const Nullable = <const Schema extends TSchema>(schema: Schema) => Type.Union([schema, Type.Null()]);
const NonEmptyStringSchema = Type.String({ minLength: 1 });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ISODateTime = string;
export type RelativePath = string;
export type URIString = string;
export type SHA256 = string;
export type SchemaVersion = string;
export type ProjectId = string;
export type SourceId = string;
export type DocumentId = string;
export type EvidenceId = string;
export type ClaimId = string;
export type VerificationId = string;
export type ResearchQuestionVersionId = string;
export type ConceptId = string;
export type TheoryRelationId = string;
export type DesignDecisionId = string;
export type ProtocolId = string;
export type DatasetId = string;
export type VariableId = string;
export type AnalysisSpecificationId = string;
export type QualitativeMaterialId = string;
export type QualitativeSegmentId = string;
export type CodebookVersionId = string;
export type ModelSuggestionId = string;
export type CodingDecisionId = string;
export type ThemeSynthesisId = string;
export type ManuscriptId = string;
export type SectionId = string;
export type ClaimOccurrenceId = string;
export type ReviewFindingId = string;
export type RevisionDecisionId = string;
export type DisclosureId = string;
export type SubmissionGateReportId = string;
export type AdapterExportProfileId = string;
export type ExternalItemLinkId = string;
export type MonitorSubscriptionId = string;
export type MonitorRunId = string;
export type AdapterRegistrationId = string;
export type ExchangeRecordId = string;
export type CollaborationMergeId = string;
export type ModelRouteDecisionId = string;
export type TaskId = string;
export type AnalysisRunId = string;
export type ArtifactId = string;
export type ApprovalId = string;
export type OperationId = string;
export type SessionId = string;
export const PROJECT_RELATIVE_PATH_PATTERN = "^(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.?(?:/|$))[^/\\\\]+(?:/[^/\\\\]+)*$";
export const RelativePathSchema = Type.String({ minLength: 1, pattern: PROJECT_RELATIVE_PATH_PATTERN });
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);
const ExistingRecordSchemaVersionSchema = Type.Union([
	Type.Literal(RESEARCH_V0_1_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_2_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_3_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_4_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_5_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_0_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_1_SCHEMA_VERSION),
	Type.Literal(RESEARCH_SCHEMA_VERSION),
]);
const DesignRecordSchemaVersionSchema = Type.Union([
	Type.Literal(RESEARCH_V0_2_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_3_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_4_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_5_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_0_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_1_SCHEMA_VERSION),
	Type.Literal(RESEARCH_SCHEMA_VERSION),
]);
const DataRecordSchemaVersionSchema = Type.Union([
	Type.Literal(RESEARCH_V0_3_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_4_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_5_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_0_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_1_SCHEMA_VERSION),
	Type.Literal(RESEARCH_SCHEMA_VERSION),
]);
const WritingRecordSchemaVersionSchema = Type.Union([
	Type.Literal(RESEARCH_V0_4_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V0_5_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_0_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_1_SCHEMA_VERSION),
	Type.Literal(RESEARCH_SCHEMA_VERSION),
]);
const KnowledgeRecordSchemaVersionSchema = Type.Union([
	Type.Literal(RESEARCH_V0_5_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_0_SCHEMA_VERSION),
	Type.Literal(RESEARCH_V1_1_SCHEMA_VERSION),
	Type.Literal(RESEARCH_SCHEMA_VERSION),
]);

export const HashValueSchema = PersistedObject({
	algorithm: Type.Literal("sha256"),
	value: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
export type HashValue = Static<typeof HashValueSchema>;

export const RecordKindSchema = Type.Union([
	Type.Literal("source"),
	Type.Literal("document"),
	Type.Literal("evidence"),
	Type.Literal("claim"),
	Type.Literal("citation_verification"),
	Type.Literal("research_question_version"),
	Type.Literal("concept"),
	Type.Literal("theory_relation"),
	Type.Literal("design_decision"),
	Type.Literal("protocol"),
	Type.Literal("dataset"),
	Type.Literal("variable"),
	Type.Literal("analysis_specification"),
	Type.Literal("qualitative_material"),
	Type.Literal("qualitative_segment"),
	Type.Literal("codebook_version"),
	Type.Literal("model_suggestion"),
	Type.Literal("coding_decision"),
	Type.Literal("theme_synthesis"),
	Type.Literal("manuscript"),
	Type.Literal("section"),
	Type.Literal("claim_occurrence"),
	Type.Literal("review_finding"),
	Type.Literal("revision_decision"),
	Type.Literal("disclosure"),
	Type.Literal("submission_gate_report"),
	Type.Literal("adapter_export_profile"),
	Type.Literal("external_item_link"),
	Type.Literal("monitor_subscription"),
	Type.Literal("monitor_run"),
	Type.Literal("adapter_registration"),
	Type.Literal("exchange_record"),
	Type.Literal("collaboration_merge"),
	Type.Literal("model_route_decision"),
	Type.Literal("task"),
	Type.Literal("analysis_run"),
	Type.Literal("artifact"),
	Type.Literal("approval"),
	Type.Literal("operation"),
]);
export type RecordKind = Static<typeof RecordKindSchema>;

export const RecordRefSchema = PersistedObject({
	kind: RecordKindSchema,
	id: NonEmptyStringSchema,
	revision: Nullable(NonNegativeIntegerSchema),
});
export type RecordRef = Static<typeof RecordRefSchema>;

export const FileRefSchema = PersistedObject({
	path: RelativePathSchema,
	hash: Nullable(HashValueSchema),
	mediaType: Nullable(NonEmptyStringSchema),
	bytes: Nullable(NonNegativeIntegerSchema),
});
export type FileRef = Static<typeof FileRefSchema>;

export const MoneySchema = PersistedObject({
	amount: Type.Number({ minimum: 0 }),
	currency: NonEmptyStringSchema,
});
export type Money = Static<typeof MoneySchema>;

export const RecordAuditSchema = PersistedObject({
	createdAt: NonEmptyStringSchema,
	updatedAt: NonEmptyStringSchema,
	revision: NonNegativeIntegerSchema,
	createdByOperationId: NonEmptyStringSchema,
	updatedByOperationId: NonEmptyStringSchema,
});
export type RecordAudit = Static<typeof RecordAuditSchema>;

export const ErrorCategorySchema = Type.Union([
	Type.Literal("validation"),
	Type.Literal("permission"),
	Type.Literal("external_service"),
	Type.Literal("network"),
	Type.Literal("rate_limit"),
	Type.Literal("budget"),
	Type.Literal("data_conflict"),
	Type.Literal("not_found"),
	Type.Literal("parse"),
	Type.Literal("runtime"),
	Type.Literal("integrity"),
	Type.Literal("migration"),
	Type.Literal("cancelled"),
	Type.Literal("internal"),
]);

export const ResearchErrorSchema = PersistedObject({
	code: NonEmptyStringSchema,
	category: ErrorCategorySchema,
	message: NonEmptyStringSchema,
	retryable: Type.Boolean(),
	source: NonEmptyStringSchema,
	operationId: Nullable(NonEmptyStringSchema),
	taskId: Nullable(NonEmptyStringSchema),
	details: JsonValueSchema,
	occurredAt: NonEmptyStringSchema,
	causeCode: Nullable(NonEmptyStringSchema),
});
export type ResearchError = Static<typeof ResearchErrorSchema>;

export const SessionLinkSchema = PersistedObject({
	piSessionId: NonEmptyStringSchema,
	piSessionFileHash: Nullable(HashValueSchema),
	linkedAt: NonEmptyStringSchema,
	firstEntryId: Nullable(NonEmptyStringSchema),
	lastEntryId: Nullable(NonEmptyStringSchema),
});
export type SessionLink = Static<typeof SessionLinkSchema>;

export const ActionClassSchema = Type.Union([
	Type.Literal("local_read"),
	Type.Literal("project_create"),
	Type.Literal("project_append"),
	Type.Literal("project_overwrite"),
	Type.Literal("destructive_file_action"),
	Type.Literal("public_network_read"),
	Type.Literal("paid_service_call"),
	Type.Literal("external_write"),
	Type.Literal("sensitive_egress"),
	Type.Literal("unknown_script_execution"),
	Type.Literal("dependency_install"),
	Type.Literal("commercial_runtime"),
	Type.Literal("publish_or_submit"),
]);
export type ActionClass = Static<typeof ActionClassSchema>;

export const PolicyDecisionSchema = Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]);
export type PolicyDecision = Static<typeof PolicyDecisionSchema>;

export const ActionPolicyRuleSchema = PersistedObject({
	actionClass: ActionClassSchema,
	decision: PolicyDecisionSchema,
	maxCostPerOperation: Nullable(MoneySchema),
	allowedDestinations: Type.Array(Type.String()),
	notes: Nullable(Type.String()),
});
export type ActionPolicyRule = Static<typeof ActionPolicyRuleSchema>;

export const ProjectSensitivitySchema = Type.Union([
	Type.Literal("public"),
	Type.Literal("internal"),
	Type.Literal("confidential"),
	Type.Literal("restricted"),
]);

export const ResearchPolicyConfigSchema = PersistedObject({
	sensitivity: ProjectSensitivitySchema,
	defaultNetworkDecision: PolicyDecisionSchema,
	modelEgressAllowed: Type.Boolean(),
	allowedModelProviders: Type.Array(Type.String()),
	allowedDataClassesForModelEgress: Type.Array(Type.String()),
	budgetHardLimit: Nullable(MoneySchema),
	actionRules: Type.Array(ActionPolicyRuleSchema),
	unknownThirdPartyCode: Type.Union([Type.Literal("deny"), Type.Literal("ask")]),
	retainRawProviderPayloads: Type.Boolean(),
	rawPayloadRetentionDays: Nullable(NonNegativeIntegerSchema),
});
export type ResearchPolicyConfig = Static<typeof ResearchPolicyConfigSchema>;

export const ResourceRuleProvenanceSchema = PersistedObject({
	origin: Type.Union([
		Type.Literal("maintainer_authored"),
		Type.Literal("redistribution_approved"),
		Type.Literal("public_domain"),
		Type.Literal("user_local"),
	]),
	sourceTitle: NonEmptyStringSchema,
	sourceUrl: Nullable(NonEmptyStringSchema),
	licenseExpression: NonEmptyStringSchema,
	reviewedAt: NonEmptyStringSchema,
});
export type ResourceRuleProvenance = Static<typeof ResourceRuleProvenanceSchema>;

export const DomainResourceRuleSchema = PersistedObject({
	ruleId: NonEmptyStringSchema,
	resourceType: NonEmptyStringSchema,
	key: NonEmptyStringSchema,
	value: JsonValueSchema,
	precedence: Type.Integer(),
	provenance: ResourceRuleProvenanceSchema,
});
export type DomainResourceRule = Static<typeof DomainResourceRuleSchema>;

export const DomainPackageManifestSchema = PersistedObject({
	format: Type.Literal("pi-research-domain-package"),
	manifestVersion: Type.Literal(1),
	packageId: NonEmptyStringSchema,
	packageVersion: NonEmptyStringSchema,
	displayName: NonEmptyStringSchema,
	domainId: NonEmptyStringSchema,
	domainLabel: NonEmptyStringSchema,
	languages: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	licenseExpression: NonEmptyStringSchema,
	resources: Type.Array(DomainResourceRuleSchema, { minItems: 1 }),
});
export type DomainPackageManifest = Static<typeof DomainPackageManifestSchema>;

export const AccessPathSchema = Type.Union([
	Type.Literal("official_api"),
	Type.Literal("supported_export"),
	Type.Literal("user_authorized_file"),
]);
export type AccessPath = Static<typeof AccessPathSchema>;

export const DownloadLimitSchema = PersistedObject({
	maxRequests: Nullable(NonNegativeIntegerSchema),
	maxItems: Nullable(NonNegativeIntegerSchema),
	maxBytes: Nullable(NonNegativeIntegerSchema),
	period: Nullable(Type.Union([Type.Literal("operation"), Type.Literal("day"), Type.Literal("month")])),
});
export type DownloadLimit = Static<typeof DownloadLimitSchema>;

export const EntitlementCapabilitySchema = PersistedObject({
	credentialRequired: Type.Boolean(),
	metadata: Type.Boolean(),
	abstract: Type.Boolean(),
	fullText: Type.Boolean(),
	export: Type.Boolean(),
});
export type EntitlementCapability = Static<typeof EntitlementCapabilitySchema>;

export const AccessPolicySnapshotSchema = PersistedObject({
	format: Type.Literal("pi-research-access-policy"),
	version: Type.Literal(1),
	providerId: NonEmptyStringSchema,
	providerVersion: NonEmptyStringSchema,
	policyVersion: NonEmptyStringSchema,
	capturedAt: NonEmptyStringSchema,
	accessPath: AccessPathSchema,
	automationAllowed: Type.Boolean(),
	termsReference: Nullable(NonEmptyStringSchema),
	downloadLimit: DownloadLimitSchema,
	entitlement: EntitlementCapabilitySchema,
	redistributionAllowed: Type.Boolean(),
});
export type AccessPolicySnapshot = Static<typeof AccessPolicySnapshotSchema>;

export const CapabilityRequirementSchema = PersistedObject({
	capability: NonEmptyStringSchema,
	required: Type.Boolean(),
	constraints: JsonValueSchema,
});
export type CapabilityRequirement = Static<typeof CapabilityRequirementSchema>;

export const AdapterKindSchema = Type.Union([
	Type.Literal("source"),
	Type.Literal("analysis_runtime"),
	Type.Literal("artifact"),
]);
export type AdapterKind = Static<typeof AdapterKindSchema>;

export const AdapterIsolationProfileSchema = Type.Union([
	Type.Literal("legacy_trusted"),
	Type.Literal("jsonl_process"),
	Type.Literal("strong_isolation"),
]);
export type AdapterIsolationProfile = Static<typeof AdapterIsolationProfileSchema>;

export const AdapterPackageManifestSchema = PersistedObject({
	format: Type.Literal("pi-research-adapter-package"),
	manifestVersion: Type.Literal(1),
	contractVersion: Type.Literal(1),
	packageId: NonEmptyStringSchema,
	packageVersion: NonEmptyStringSchema,
	adapterId: NonEmptyStringSchema,
	adapterVersion: NonEmptyStringSchema,
	adapterKind: AdapterKindSchema,
	entrypoint: RelativePathSchema,
	capabilities: Type.Array(CapabilityRequirementSchema, { minItems: 1 }),
	requiredBrokers: Type.Array(
		Type.Union([
			Type.Literal("http"),
			Type.Literal("credential"),
			Type.Literal("project_read"),
			Type.Literal("staged_output"),
		]),
	),
	isolationProfiles: Type.Array(AdapterIsolationProfileSchema, { minItems: 1 }),
	licenseExpression: NonEmptyStringSchema,
	provenance: PersistedObject({
		source: NonEmptyStringSchema,
		repositoryUrl: Nullable(NonEmptyStringSchema),
	}),
	packageHash: HashValueSchema,
	sbomPath: Nullable(RelativePathSchema),
	sbomHash: Nullable(HashValueSchema),
});
export type AdapterPackageManifest = Static<typeof AdapterPackageManifestSchema>;

export const AdapterConformanceCheckSchema = PersistedObject({
	name: NonEmptyStringSchema,
	passed: Type.Boolean(),
	message: NonEmptyStringSchema,
});
export type AdapterConformanceCheck = Static<typeof AdapterConformanceCheckSchema>;

export const AdapterConformanceReportSchema = PersistedObject({
	format: Type.Literal("pi-research-adapter-conformance"),
	version: Type.Literal(1),
	packageId: NonEmptyStringSchema,
	packageVersion: NonEmptyStringSchema,
	packageHash: HashValueSchema,
	manifestHash: HashValueSchema,
	adapterId: NonEmptyStringSchema,
	adapterKind: AdapterKindSchema,
	passed: Type.Boolean(),
	checks: Type.Array(AdapterConformanceCheckSchema, { minItems: 1 }),
});
export type AdapterConformanceReport = Static<typeof AdapterConformanceReportSchema>;

export const ModelRouteCandidateSchema = PersistedObject({
	provider: NonEmptyStringSchema,
	model: NonEmptyStringSchema,
	local: Type.Boolean(),
	available: Type.Boolean(),
	capabilities: Type.Array(NonEmptyStringSchema),
	contextWindow: Type.Integer({ minimum: 1 }),
	estimatedCost: MoneySchema,
});
export type ModelRouteCandidate = Static<typeof ModelRouteCandidateSchema>;

export const ModelRouteEvaluationSchema = PersistedObject({
	provider: NonEmptyStringSchema,
	model: NonEmptyStringSchema,
	eligible: Type.Boolean(),
	reasons: Type.Array(NonEmptyStringSchema),
});
export type ModelRouteEvaluation = Static<typeof ModelRouteEvaluationSchema>;

export const ModelRouteDecisionSchema = PersistedObject({
	format: Type.Literal("pi-research-model-route-decision"),
	version: Type.Literal(1),
	decisionId: NonEmptyStringSchema,
	projectId: NonEmptyStringSchema,
	requestHash: HashValueSchema,
	selected: Nullable(ModelRouteCandidateSchema),
	evaluations: Type.Array(ModelRouteEvaluationSchema, { minItems: 1 }),
	decidedAt: NonEmptyStringSchema,
});
export type ModelRouteDecision = Static<typeof ModelRouteDecisionSchema>;

export const ProjectDirectoriesSchema = PersistedObject({
	sources: RelativePathSchema,
	documents: RelativePathSchema,
	parsed: RelativePathSchema,
	evidence: RelativePathSchema,
	claims: RelativePathSchema,
	verifications: RelativePathSchema,
	tasks: RelativePathSchema,
	runs: RelativePathSchema,
	artifacts: RelativePathSchema,
	approvals: RelativePathSchema,
	migrations: RelativePathSchema,
	transactions: RelativePathSchema,
});
export type ProjectDirectories = Static<typeof ProjectDirectoriesSchema>;

export const ResearchQuestionSchema = PersistedObject({
	id: NonEmptyStringSchema,
	text: NonEmptyStringSchema,
	status: Type.Union([Type.Literal("draft"), Type.Literal("confirmed"), Type.Literal("retired")]),
	rationale: Nullable(Type.String()),
	confirmedAt: Nullable(NonEmptyStringSchema),
	confirmedBy: Nullable(Type.Union([Type.Literal("user"), Type.Literal("imported")])),
});
export type ResearchQuestion = Static<typeof ResearchQuestionSchema>;

export const ProjectRecordSetSchema = PersistedObject({
	kind: RecordKindSchema,
	storage: Type.Union([Type.Literal("jsonl"), Type.Literal("json")]),
	path: RelativePathSchema,
	count: NonNegativeIntegerSchema,
	contentHash: Nullable(HashValueSchema),
});
export type ProjectRecordSet = Static<typeof ProjectRecordSetSchema>;

export const ResearchProjectManifestSchema = PersistedObject({
	kind: Type.Literal("research_project_manifest"),
	schemaVersion: Type.Literal(RESEARCH_SCHEMA_VERSION),
	projectId: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	domain: PersistedObject({
		id: NonEmptyStringSchema,
		label: NonEmptyStringSchema,
		templatePackage: Nullable(NonEmptyStringSchema),
		templateVersion: Nullable(NonEmptyStringSchema),
	}),
	researchQuestions: Type.Array(ResearchQuestionSchema),
	currentStage: Type.Union([
		Type.Literal("topic_exploration"),
		Type.Literal("literature_review"),
		Type.Literal("research_design"),
		Type.Literal("data_preparation"),
		Type.Literal("analysis"),
		Type.Literal("writing"),
		Type.Literal("review_revision"),
		Type.Literal("artifact_delivery"),
		Type.Literal("monitoring"),
		Type.Literal("archived"),
	]),
	projectStatus: Type.Union([
		Type.Literal("active"),
		Type.Literal("paused"),
		Type.Literal("blocked"),
		Type.Literal("archived"),
	]),
	policy: ResearchPolicyConfigSchema,
	directories: ProjectDirectoriesSchema,
	recordSets: Type.Array(ProjectRecordSetSchema),
	activeTaskIds: Type.Array(NonEmptyStringSchema),
	lastCommittedOperationId: Nullable(NonEmptyStringSchema),
	lastSessionLink: Nullable(SessionLinkSchema),
	createdAt: NonEmptyStringSchema,
	updatedAt: NonEmptyStringSchema,
	revision: NonNegativeIntegerSchema,
});
export type ResearchProjectManifest = Static<typeof ResearchProjectManifestSchema>;

export const IdentifierSchemeSchema = Type.Union([
	Type.Literal("doi"),
	Type.Literal("arxiv"),
	Type.Literal("isbn"),
	Type.Literal("issn"),
	Type.Literal("pmid"),
	Type.Literal("pmcid"),
	Type.Literal("openalex"),
	Type.Literal("url"),
	Type.Literal("handle"),
	Type.Literal("local"),
]);
export type IdentifierScheme = Static<typeof IdentifierSchemeSchema>;

export const SourceIdentifierSchema = PersistedObject({
	scheme: IdentifierSchemeSchema,
	value: NonEmptyStringSchema,
	normalizedValue: NonEmptyStringSchema,
	verified: Type.Boolean(),
	verificationId: Nullable(NonEmptyStringSchema),
});
export type SourceIdentifier = Static<typeof SourceIdentifierSchema>;

export const ContributorNameSchema = PersistedObject({
	family: Nullable(Type.String()),
	given: Nullable(Type.String()),
	literal: Nullable(Type.String()),
	orcid: Nullable(NonEmptyStringSchema),
});
export type ContributorName = Static<typeof ContributorNameSchema>;

export const SourceDiscoveryEventSchema = PersistedObject({
	adapterId: NonEmptyStringSchema,
	adapterVersion: NonEmptyStringSchema,
	queryText: Nullable(Type.String()),
	queryHash: Nullable(HashValueSchema),
	discoveredAt: NonEmptyStringSchema,
	rank: Nullable(NonNegativeIntegerSchema),
	rawRecord: FileRefSchema,
	requestOperationId: NonEmptyStringSchema,
	accessPath: Type.Optional(AccessPathSchema),
	accessPolicy: Type.Optional(AccessPolicySnapshotSchema),
});
export type SourceDiscoveryEvent = Static<typeof SourceDiscoveryEventSchema>;

export const MetadataConflictSchema = PersistedObject({
	field: NonEmptyStringSchema,
	values: Type.Array(
		PersistedObject({
			value: JsonValueSchema,
			adapterId: NonEmptyStringSchema,
			retrievedAt: NonEmptyStringSchema,
			rawRecord: FileRefSchema,
		}),
		{ minItems: 1 },
	),
	resolution: Type.Union([
		Type.Literal("unresolved"),
		Type.Literal("selected"),
		Type.Literal("merged"),
		Type.Literal("dismissed"),
	]),
	selectedValue: JsonValueSchema,
	resolvedBy: Nullable(Type.Union([Type.Literal("rule"), Type.Literal("user")])),
	resolvedAt: Nullable(NonEmptyStringSchema),
});
export type MetadataConflict = Static<typeof MetadataConflictSchema>;

export const PublicationStatusSchema = Type.Union([
	Type.Literal("normal"),
	Type.Literal("corrected"),
	Type.Literal("retracted"),
	Type.Literal("expression_of_concern"),
	Type.Literal("withdrawn"),
	Type.Literal("unknown"),
]);
export type PublicationStatus = Static<typeof PublicationStatusSchema>;

export const SourceRecordSchema = PersistedObject({
	kind: Type.Literal("source"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	sourceId: NonEmptyStringSchema,
	identifiers: Type.Array(SourceIdentifierSchema),
	title: NonEmptyStringSchema,
	titleNormalized: NonEmptyStringSchema,
	contributors: Type.Array(ContributorNameSchema),
	issuedDate: Nullable(Type.String()),
	containerTitle: Nullable(Type.String()),
	publisher: Nullable(Type.String()),
	sourceType: NonEmptyStringSchema,
	language: Nullable(Type.String()),
	abstractText: Nullable(Type.String()),
	abstractRights: Type.Union([
		Type.Literal("unknown"),
		Type.Literal("metadata_only"),
		Type.Literal("display_allowed"),
		Type.Literal("restricted"),
	]),
	discovery: Type.Array(SourceDiscoveryEventSchema),
	dedupKeys: PersistedObject({
		doi: Nullable(Type.String()),
		strongIdentifier: Nullable(Type.String()),
		normalizedTitleYearFirstAuthor: Nullable(Type.String()),
		contentHash: Nullable(Type.String()),
	}),
	duplicateStatus: Type.Union([
		Type.Literal("canonical"),
		Type.Literal("possible_duplicate"),
		Type.Literal("merged_alias"),
		Type.Literal("distinct"),
	]),
	canonicalSourceId: Nullable(NonEmptyStringSchema),
	metadataConflicts: Type.Array(MetadataConflictSchema),
	publicationStatus: PublicationStatusSchema,
	audit: RecordAuditSchema,
});
export type SourceRecord = Static<typeof SourceRecordSchema>;

export const AccessStatusSchema = Type.Union([
	Type.Literal("unknown"),
	Type.Literal("user_provided"),
	Type.Literal("open_access"),
	Type.Literal("authorized_access"),
	Type.Literal("paywalled"),
	Type.Literal("authentication_required"),
	Type.Literal("not_found"),
	Type.Literal("license_restricted"),
	Type.Literal("blocked_by_policy"),
]);
export type AccessStatus = Static<typeof AccessStatusSchema>;

export const FullTextStatusSchema = Type.Union([
	Type.Literal("not_requested"),
	Type.Literal("located"),
	Type.Literal("unavailable"),
	Type.Literal("paywall_blocked"),
	Type.Literal("authentication_blocked"),
	Type.Literal("acquired_unparsed"),
	Type.Literal("parsed"),
	Type.Literal("parsed_with_warnings"),
	Type.Literal("ocr_required"),
	Type.Literal("parse_failed"),
	Type.Literal("quarantined"),
]);
export type FullTextStatus = Static<typeof FullTextStatusSchema>;

export const DocumentRecordSchema = PersistedObject({
	kind: Type.Literal("document"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	documentId: NonEmptyStringSchema,
	sourceId: NonEmptyStringSchema,
	acquisition: PersistedObject({
		method: Type.Union([
			Type.Literal("local_import"),
			Type.Literal("open_access_download"),
			Type.Literal("authorized_export"),
			Type.Literal("manual_copy"),
		]),
		adapterId: Nullable(NonEmptyStringSchema),
		origin: Nullable(NonEmptyStringSchema),
		accessStatus: AccessStatusSchema,
		licenseExpression: Nullable(Type.String()),
		termsReference: Nullable(Type.String()),
		acquiredAt: Nullable(NonEmptyStringSchema),
		approvalId: Nullable(NonEmptyStringSchema),
	}),
	localFile: Nullable(FileRefSchema),
	originalFileName: Nullable(Type.String()),
	immutableOriginal: Type.Boolean(),
	fullTextStatus: FullTextStatusSchema,
	textLayer: Type.Union([
		Type.Literal("unknown"),
		Type.Literal("present"),
		Type.Literal("absent"),
		Type.Literal("partial"),
	]),
	parser: Nullable(
		PersistedObject({
			id: NonEmptyStringSchema,
			version: NonEmptyStringSchema,
			optionsHash: HashValueSchema,
		}),
	),
	parsedOutput: Nullable(FileRefSchema),
	pageCount: Nullable(NonNegativeIntegerSchema),
	parsedAt: Nullable(NonEmptyStringSchema),
	warnings: Type.Array(Type.String()),
	failure: Nullable(ResearchErrorSchema),
	audit: RecordAuditSchema,
});
export type DocumentRecord = Static<typeof DocumentRecordSchema>;

export const EvidenceLevelSchema = Type.Union([
	Type.Literal("metadata"),
	Type.Literal("abstract"),
	Type.Literal("fulltext_unlocated"),
	Type.Literal("fulltext_located"),
	Type.Literal("table_or_figure_located"),
	Type.Literal("dataset_or_appendix_located"),
]);
export type EvidenceLevel = Static<typeof EvidenceLevelSchema>;

export const EvidenceLocatorSchema = PersistedObject({
	locatorType: Type.Union([
		Type.Literal("page"),
		Type.Literal("page_range"),
		Type.Literal("section"),
		Type.Literal("paragraph"),
		Type.Literal("table"),
		Type.Literal("figure"),
		Type.Literal("appendix"),
		Type.Literal("char_range"),
	]),
	pageStart: Nullable(NonNegativeIntegerSchema),
	pageEnd: Nullable(NonNegativeIntegerSchema),
	sectionPath: Type.Array(Type.String()),
	label: Nullable(Type.String()),
	charStart: Nullable(NonNegativeIntegerSchema),
	charEnd: Nullable(NonNegativeIntegerSchema),
	anchorHash: Nullable(HashValueSchema),
});
export type EvidenceLocator = Static<typeof EvidenceLocatorSchema>;

export const EvidenceRelationSchema = Type.Union([
	Type.Literal("supports"),
	Type.Literal("refutes"),
	Type.Literal("qualifies"),
	Type.Literal("context_only"),
]);

export const EvidenceClaimLinkSchema = PersistedObject({
	claimId: NonEmptyStringSchema,
	relation: EvidenceRelationSchema,
	rationale: NonEmptyStringSchema,
});
export type EvidenceClaimLink = Static<typeof EvidenceClaimLinkSchema>;

export const EvidenceCardSchema = PersistedObject({
	kind: Type.Literal("evidence"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	evidenceId: NonEmptyStringSchema,
	sourceId: NonEmptyStringSchema,
	documentId: Nullable(NonEmptyStringSchema),
	evidenceLevel: EvidenceLevelSchema,
	locator: Nullable(EvidenceLocatorSchema),
	excerpt: Nullable(Type.String()),
	excerptExactMatch: Nullable(Type.Boolean()),
	paraphrase: NonEmptyStringSchema,
	evidenceStatement: NonEmptyStringSchema,
	claimLinks: Type.Array(EvidenceClaimLinkSchema),
	extraction: PersistedObject({
		method: Type.Union([
			Type.Literal("deterministic"),
			Type.Literal("model_suggested"),
			Type.Literal("human_entered"),
			Type.Literal("imported"),
		]),
		operationId: NonEmptyStringSchema,
		modelProvider: Nullable(NonEmptyStringSchema),
		modelId: Nullable(NonEmptyStringSchema),
		promptHash: Nullable(HashValueSchema),
	}),
	confidence: PersistedObject({
		level: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
		basis: NonEmptyStringSchema,
		limitations: Type.Array(Type.String()),
	}),
	rights: PersistedObject({
		excerptAllowed: Nullable(Type.Boolean()),
		maxStoredWords: Nullable(NonNegativeIntegerSchema),
		publicExportAllowed: Nullable(Type.Boolean()),
	}),
	humanStatus: Type.Union([
		Type.Literal("not_reviewed"),
		Type.Literal("accepted"),
		Type.Literal("rejected"),
		Type.Literal("edited"),
	]),
	validity: Type.Union([Type.Literal("active"), Type.Literal("superseded"), Type.Literal("invalidated")]),
	supersedesEvidenceId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type EvidenceCard = Static<typeof EvidenceCardSchema>;

export const ClaimTypeSchema = Type.Union([
	Type.Literal("bibliographic"),
	Type.Literal("descriptive"),
	Type.Literal("theoretical"),
	Type.Literal("empirical_association"),
	Type.Literal("causal"),
	Type.Literal("methodological"),
	Type.Literal("limitation"),
	Type.Literal("synthesis"),
	Type.Literal("recommendation"),
]);
export type ClaimType = Static<typeof ClaimTypeSchema>;

export const ClaimEvidenceLinkSchema = PersistedObject({
	evidenceId: NonEmptyStringSchema,
	relation: EvidenceRelationSchema,
	assessment: NonEmptyStringSchema,
});
export type ClaimEvidenceLink = Static<typeof ClaimEvidenceLinkSchema>;

export const SupportStatusSchema = Type.Union([
	Type.Literal("unassessed"),
	Type.Literal("unsupported"),
	Type.Literal("partially_supported"),
	Type.Literal("supported"),
	Type.Literal("mixed"),
	Type.Literal("contradicted"),
]);
export type SupportStatus = Static<typeof SupportStatusSchema>;

export const PublishabilitySchema = Type.Union([
	Type.Literal("blocked"),
	Type.Literal("exploratory"),
	Type.Literal("evidence_checked"),
	Type.Literal("submission_candidate"),
]);
export type Publishability = Static<typeof PublishabilitySchema>;

export const ClaimRecordSchema = PersistedObject({
	kind: Type.Literal("claim"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	claimId: NonEmptyStringSchema,
	text: NonEmptyStringSchema,
	claimType: ClaimTypeSchema,
	scope: NonEmptyStringSchema,
	evidenceLinks: Type.Array(ClaimEvidenceLinkSchema),
	supportStatus: SupportStatusSchema,
	conflictEvidenceIds: Type.Array(NonEmptyStringSchema),
	humanConfirmation: PersistedObject({
		status: Type.Union([
			Type.Literal("not_reviewed"),
			Type.Literal("accepted"),
			Type.Literal("rejected"),
			Type.Literal("edited"),
		]),
		decidedAt: Nullable(NonEmptyStringSchema),
		note: Nullable(Type.String()),
	}),
	publishability: PublishabilitySchema,
	audit: RecordAuditSchema,
});
export type ClaimRecord = Static<typeof ClaimRecordSchema>;

export const CitationFieldCheckSchema = PersistedObject({
	field: Type.Union([
		Type.Literal("title"),
		Type.Literal("authors"),
		Type.Literal("year"),
		Type.Literal("container"),
		Type.Literal("volume"),
		Type.Literal("issue"),
		Type.Literal("pages"),
		Type.Literal("identifier"),
	]),
	expected: JsonValueSchema,
	observed: JsonValueSchema,
	status: Type.Union([
		Type.Literal("match"),
		Type.Literal("near_match"),
		Type.Literal("conflict"),
		Type.Literal("missing"),
	]),
	sourceAdapterId: NonEmptyStringSchema,
});
export type CitationFieldCheck = Static<typeof CitationFieldCheckSchema>;

export const CitationVerificationSchema = PersistedObject({
	kind: Type.Literal("citation_verification"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	verificationId: NonEmptyStringSchema,
	sourceId: NonEmptyStringSchema,
	citationKey: Nullable(Type.String()),
	identifiers: Type.Array(SourceIdentifierSchema),
	verificationSources: Type.Array(
		PersistedObject({
			adapterId: NonEmptyStringSchema,
			adapterVersion: NonEmptyStringSchema,
			checkedAt: NonEmptyStringSchema,
			rawRecord: FileRefSchema,
			operationId: NonEmptyStringSchema,
		}),
	),
	fieldChecks: Type.Array(CitationFieldCheckSchema),
	publicationStatus: PublicationStatusSchema,
	conflicts: Type.Array(MetadataConflictSchema),
	finalStatus: Type.Union([
		Type.Literal("verified"),
		Type.Literal("verified_with_warning"),
		Type.Literal("conflict"),
		Type.Literal("not_found"),
		Type.Literal("service_unavailable"),
		Type.Literal("incomplete"),
	]),
	verifiedAt: NonEmptyStringSchema,
	expiresAt: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type CitationVerification = Static<typeof CitationVerificationSchema>;

export const DesignProvenanceRefSchema = PersistedObject({
	kind: Type.Union([Type.Literal("evidence"), Type.Literal("claim"), Type.Literal("operation")]),
	id: NonEmptyStringSchema,
	revision: NonNegativeIntegerSchema,
});
export type DesignProvenanceRef = Static<typeof DesignProvenanceRefSchema>;

export const DesignBasisSchema = PersistedObject({
	summary: NonEmptyStringSchema,
	provenance: Type.Array(DesignProvenanceRefSchema, { minItems: 1 }),
	evidenceGap: Type.Boolean(),
});
export type DesignBasis = Static<typeof DesignBasisSchema>;

export const DesignRecordStatusSchema = Type.Union([
	Type.Literal("draft"),
	Type.Literal("awaiting_confirmation"),
	Type.Literal("confirmed"),
	Type.Literal("rejected"),
	Type.Literal("retired"),
	Type.Literal("superseded"),
]);
export type DesignRecordStatus = Static<typeof DesignRecordStatusSchema>;

export const DesignConfirmationSchema = PersistedObject({
	decision: Nullable(Type.Union([Type.Literal("confirmed"), Type.Literal("rejected")])),
	decidedAt: Nullable(NonEmptyStringSchema),
	decidedBy: Nullable(Type.Union([Type.Literal("user"), Type.Literal("imported")])),
	note: Nullable(Type.String()),
});
export type DesignConfirmation = Static<typeof DesignConfirmationSchema>;

export const ResearchQuestionVersionSchema = PersistedObject({
	kind: Type.Literal("research_question_version"),
	schemaVersion: DesignRecordSchemaVersionSchema,
	researchQuestionVersionId: NonEmptyStringSchema,
	questionSeriesId: NonEmptyStringSchema,
	version: Type.Integer({ minimum: 1 }),
	text: NonEmptyStringSchema,
	questionType: Type.Union([
		Type.Literal("exploratory"),
		Type.Literal("descriptive"),
		Type.Literal("associational"),
		Type.Literal("causal"),
		Type.Literal("interpretive"),
		Type.Literal("comparative"),
		Type.Literal("evaluative"),
	]),
	rationale: NonEmptyStringSchema,
	scope: NonEmptyStringSchema,
	boundaryConditions: Type.Array(NonEmptyStringSchema),
	basis: DesignBasisSchema,
	status: DesignRecordStatusSchema,
	confirmation: DesignConfirmationSchema,
	supersedesResearchQuestionVersionId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type ResearchQuestionVersion = Static<typeof ResearchQuestionVersionSchema>;

export const ConceptRecordSchema = PersistedObject({
	kind: Type.Literal("concept"),
	schemaVersion: DesignRecordSchemaVersionSchema,
	conceptId: NonEmptyStringSchema,
	name: NonEmptyStringSchema,
	definition: NonEmptyStringSchema,
	role: Type.Union([
		Type.Literal("exposure"),
		Type.Literal("outcome"),
		Type.Literal("mechanism"),
		Type.Literal("moderator"),
		Type.Literal("mediator"),
		Type.Literal("control"),
		Type.Literal("context"),
		Type.Literal("other"),
	]),
	aliases: Type.Array(NonEmptyStringSchema),
	measurementNotes: Type.Array(NonEmptyStringSchema),
	boundaryConditions: Type.Array(NonEmptyStringSchema),
	basis: DesignBasisSchema,
	status: DesignRecordStatusSchema,
	confirmation: DesignConfirmationSchema,
	supersedesConceptId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type ConceptRecord = Static<typeof ConceptRecordSchema>;

export const TheoryRelationSchema = PersistedObject({
	kind: Type.Literal("theory_relation"),
	schemaVersion: DesignRecordSchemaVersionSchema,
	theoryRelationId: NonEmptyStringSchema,
	fromConceptId: NonEmptyStringSchema,
	toConceptId: NonEmptyStringSchema,
	relationType: Type.Union([
		Type.Literal("association"),
		Type.Literal("causal_mechanism"),
		Type.Literal("mediation"),
		Type.Literal("moderation"),
		Type.Literal("comparison"),
		Type.Literal("contextual_condition"),
		Type.Literal("proposition"),
	]),
	direction: Type.Union([
		Type.Literal("positive"),
		Type.Literal("negative"),
		Type.Literal("nonlinear"),
		Type.Literal("conditional"),
		Type.Literal("unspecified"),
	]),
	statement: NonEmptyStringSchema,
	hypothesesOrPropositions: Type.Array(NonEmptyStringSchema),
	boundaryConditions: Type.Array(NonEmptyStringSchema),
	alternativeExplanations: Type.Array(NonEmptyStringSchema),
	basis: DesignBasisSchema,
	status: DesignRecordStatusSchema,
	confirmation: DesignConfirmationSchema,
	supersedesTheoryRelationId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type TheoryRelation = Static<typeof TheoryRelationSchema>;

export const DesignOptionSchema = PersistedObject({
	optionId: NonEmptyStringSchema,
	label: NonEmptyStringSchema,
	description: NonEmptyStringSchema,
	tradeoffs: Type.Array(NonEmptyStringSchema),
	risks: Type.Array(NonEmptyStringSchema),
});
export type DesignOption = Static<typeof DesignOptionSchema>;

export const DesignDecisionSchema = PersistedObject({
	kind: Type.Literal("design_decision"),
	schemaVersion: DesignRecordSchemaVersionSchema,
	designDecisionId: NonEmptyStringSchema,
	decisionType: Type.Union([
		Type.Literal("research_question"),
		Type.Literal("theory"),
		Type.Literal("concept"),
		Type.Literal("measurement"),
		Type.Literal("sampling"),
		Type.Literal("identification"),
		Type.Literal("method"),
		Type.Literal("data_source"),
		Type.Literal("ethics"),
		Type.Literal("feasibility"),
	]),
	question: NonEmptyStringSchema,
	options: Type.Array(DesignOptionSchema, { minItems: 1 }),
	selectedOptionId: Nullable(NonEmptyStringSchema),
	rationale: Nullable(Type.String()),
	alternativesConsidered: Type.Array(NonEmptyStringSchema),
	limitations: Type.Array(NonEmptyStringSchema),
	basis: DesignBasisSchema,
	critical: Type.Boolean(),
	status: DesignRecordStatusSchema,
	confirmation: DesignConfirmationSchema,
	supersedesDesignDecisionId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type DesignDecision = Static<typeof DesignDecisionSchema>;

export const EthicsChecklistItemSchema = PersistedObject({
	item: NonEmptyStringSchema,
	status: Type.Union([
		Type.Literal("not_assessed"),
		Type.Literal("required"),
		Type.Literal("complete"),
		Type.Literal("not_applicable"),
	]),
	note: Nullable(Type.String()),
});
export type EthicsChecklistItem = Static<typeof EthicsChecklistItemSchema>;

export const ProtocolRecordSchema = PersistedObject({
	kind: Type.Literal("protocol"),
	schemaVersion: DesignRecordSchemaVersionSchema,
	protocolId: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	researchQuestionVersionId: NonEmptyStringSchema,
	designType: Type.Union([Type.Literal("quantitative"), Type.Literal("qualitative")]),
	claimMode: Type.Union([
		Type.Literal("descriptive"),
		Type.Literal("associational"),
		Type.Literal("causal"),
		Type.Literal("interpretive"),
		Type.Literal("comparative"),
	]),
	method: NonEmptyStringSchema,
	population: NonEmptyStringSchema,
	unitOfAnalysis: NonEmptyStringSchema,
	timeframe: NonEmptyStringSchema,
	samplingPlan: NonEmptyStringSchema,
	measurementPlan: NonEmptyStringSchema,
	dataCollectionPlan: NonEmptyStringSchema,
	analysisPlan: NonEmptyStringSchema,
	identificationStrategy: Nullable(Type.String()),
	identificationAssumptions: Type.Array(NonEmptyStringSchema),
	preanalysisPlan: Nullable(Type.String()),
	interviewPlan: Nullable(Type.String()),
	caseSelectionPlan: Nullable(Type.String()),
	inclusionCriteria: Type.Array(NonEmptyStringSchema),
	exclusionCriteria: Type.Array(NonEmptyStringSchema),
	alternativeExplanations: Type.Array(NonEmptyStringSchema),
	boundaryConditions: Type.Array(NonEmptyStringSchema),
	feasibilityLimits: Type.Array(NonEmptyStringSchema),
	ethicsChecklist: Type.Array(EthicsChecklistItemSchema),
	decisionIds: Type.Array(NonEmptyStringSchema),
	conceptIds: Type.Array(NonEmptyStringSchema),
	theoryRelationIds: Type.Array(NonEmptyStringSchema),
	basis: DesignBasisSchema,
	status: DesignRecordStatusSchema,
	confirmation: DesignConfirmationSchema,
	supersedesProtocolId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type ProtocolRecord = Static<typeof ProtocolRecordSchema>;

export const DatasetRecordSchema = PersistedObject({
	kind: Type.Literal("dataset"),
	schemaVersion: DataRecordSchemaVersionSchema,
	datasetId: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	format: Type.Literal("csv"),
	encoding: Type.Literal("utf-8"),
	sensitivity: ProjectSensitivitySchema,
	sourceFile: FileRefSchema,
	immutableOriginal: Type.Boolean(),
	rowCount: NonNegativeIntegerSchema,
	columnCount: NonNegativeIntegerSchema,
	variableIds: Type.Array(NonEmptyStringSchema),
	importedAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type DatasetRecord = Static<typeof DatasetRecordSchema>;

export const VariableRecordSchema = PersistedObject({
	kind: Type.Literal("variable"),
	schemaVersion: DataRecordSchemaVersionSchema,
	variableId: NonEmptyStringSchema,
	datasetId: NonEmptyStringSchema,
	name: NonEmptyStringSchema,
	position: NonNegativeIntegerSchema,
	dataType: Type.Union([
		Type.Literal("string"),
		Type.Literal("integer"),
		Type.Literal("number"),
		Type.Literal("boolean"),
		Type.Literal("date"),
		Type.Literal("datetime"),
		Type.Literal("unknown"),
	]),
	nullable: Type.Boolean(),
	missingCount: NonNegativeIntegerSchema,
	description: Nullable(Type.String()),
	role: Type.Union([
		Type.Literal("identifier"),
		Type.Literal("exposure"),
		Type.Literal("outcome"),
		Type.Literal("covariate"),
		Type.Literal("weight"),
		Type.Literal("cluster"),
		Type.Literal("text"),
		Type.Literal("other"),
	]),
	audit: RecordAuditSchema,
});
export type VariableRecord = Static<typeof VariableRecordSchema>;

export const AnalysisSpecificationSchema = PersistedObject({
	kind: Type.Literal("analysis_specification"),
	schemaVersion: DataRecordSchemaVersionSchema,
	analysisSpecificationId: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	protocolId: Nullable(NonEmptyStringSchema),
	inputDatasetIds: Type.Array(NonEmptyStringSchema),
	inputFiles: Type.Array(FileRefSchema),
	runtime: Type.Union([Type.Literal("python"), Type.Literal("r"), Type.Literal("stata")]),
	script: FileRefSchema,
	environmentFile: Nullable(FileRefSchema),
	parameters: JsonValueSchema,
	randomSeed: Nullable(Type.Integer()),
	commandArguments: Type.Array(Type.String()),
	expectedOutputs: Type.Array(RelativePathSchema),
	timeoutSeconds: Type.Integer({ minimum: 1, maximum: 3_600 }),
	claimMode: Type.Union([
		Type.Literal("descriptive"),
		Type.Literal("associational"),
		Type.Literal("causal"),
		Type.Literal("interpretive"),
		Type.Literal("comparative"),
	]),
	status: DesignRecordStatusSchema,
	confirmation: DesignConfirmationSchema,
	audit: RecordAuditSchema,
});
export type AnalysisSpecification = Static<typeof AnalysisSpecificationSchema>;

export const QualitativeMaterialSchema = PersistedObject({
	kind: Type.Literal("qualitative_material"),
	schemaVersion: DataRecordSchemaVersionSchema,
	qualitativeMaterialId: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	format: Type.Literal("text"),
	encoding: Type.Literal("utf-8"),
	sensitivity: ProjectSensitivitySchema,
	sourceFile: FileRefSchema,
	deidentified: Type.Boolean(),
	immutableOriginal: Type.Boolean(),
	characterCount: NonNegativeIntegerSchema,
	importedAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type QualitativeMaterial = Static<typeof QualitativeMaterialSchema>;

export const QualitativeSegmentSchema = PersistedObject({
	kind: Type.Literal("qualitative_segment"),
	schemaVersion: DataRecordSchemaVersionSchema,
	qualitativeSegmentId: NonEmptyStringSchema,
	qualitativeMaterialId: NonEmptyStringSchema,
	ordinal: NonNegativeIntegerSchema,
	text: NonEmptyStringSchema,
	locator: PersistedObject({
		charStart: NonNegativeIntegerSchema,
		charEnd: Type.Integer({ minimum: 1 }),
		anchorHash: HashValueSchema,
	}),
	audit: RecordAuditSchema,
});
export type QualitativeSegment = Static<typeof QualitativeSegmentSchema>;

export const CodebookCodeSchema = PersistedObject({
	codeId: NonEmptyStringSchema,
	label: NonEmptyStringSchema,
	definition: NonEmptyStringSchema,
	inclusionCriteria: Type.Array(NonEmptyStringSchema),
	exclusionCriteria: Type.Array(NonEmptyStringSchema),
});
export type CodebookCode = Static<typeof CodebookCodeSchema>;

export const CodebookVersionSchema = PersistedObject({
	kind: Type.Literal("codebook_version"),
	schemaVersion: DataRecordSchemaVersionSchema,
	codebookVersionId: NonEmptyStringSchema,
	codebookSeriesId: NonEmptyStringSchema,
	version: Type.Integer({ minimum: 1 }),
	title: NonEmptyStringSchema,
	codes: Type.Array(CodebookCodeSchema, { minItems: 1 }),
	status: DesignRecordStatusSchema,
	confirmation: DesignConfirmationSchema,
	supersedesCodebookVersionId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type CodebookVersion = Static<typeof CodebookVersionSchema>;

export const ModelSuggestionSchema = PersistedObject({
	kind: Type.Literal("model_suggestion"),
	schemaVersion: DataRecordSchemaVersionSchema,
	modelSuggestionId: NonEmptyStringSchema,
	qualitativeSegmentId: NonEmptyStringSchema,
	codebookVersionId: NonEmptyStringSchema,
	suggestedCodeIds: Type.Array(NonEmptyStringSchema),
	rationale: NonEmptyStringSchema,
	provenance: PersistedObject({
		operationId: NonEmptyStringSchema,
		provider: NonEmptyStringSchema,
		modelId: NonEmptyStringSchema,
		thinkingLevel: Nullable(Type.String()),
		structuredInputHash: HashValueSchema,
		captureScope: Type.Literal("tool_arguments"),
	}),
	status: Type.Literal("recorded"),
	audit: RecordAuditSchema,
});
export type ModelSuggestion = Static<typeof ModelSuggestionSchema>;

export const CodingDecisionSchema = PersistedObject({
	kind: Type.Literal("coding_decision"),
	schemaVersion: DataRecordSchemaVersionSchema,
	codingDecisionId: NonEmptyStringSchema,
	qualitativeSegmentId: NonEmptyStringSchema,
	codebookVersionId: NonEmptyStringSchema,
	modelSuggestionId: Nullable(NonEmptyStringSchema),
	decision: Type.Union([Type.Literal("accepted"), Type.Literal("edited"), Type.Literal("rejected")]),
	assignedCodeIds: Type.Array(NonEmptyStringSchema),
	note: Nullable(Type.String()),
	decidedAt: NonEmptyStringSchema,
	decidedBy: Type.Literal("user"),
	supersedesCodingDecisionId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type CodingDecision = Static<typeof CodingDecisionSchema>;

export const ThemeSchema = PersistedObject({
	themeId: NonEmptyStringSchema,
	label: NonEmptyStringSchema,
	statement: NonEmptyStringSchema,
	codeIds: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	qualitativeSegmentIds: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	negativeCaseSegmentIds: Type.Array(NonEmptyStringSchema),
});
export type Theme = Static<typeof ThemeSchema>;

export const ThemeSynthesisSchema = PersistedObject({
	kind: Type.Literal("theme_synthesis"),
	schemaVersion: DataRecordSchemaVersionSchema,
	themeSynthesisId: NonEmptyStringSchema,
	codebookVersionId: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	themes: Type.Array(ThemeSchema, { minItems: 1 }),
	codingDecisionIds: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	status: DesignRecordStatusSchema,
	confirmation: DesignConfirmationSchema,
	supersedesThemeSynthesisId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type ThemeSynthesis = Static<typeof ThemeSynthesisSchema>;

export const ManuscriptPaperTypeSchema = Type.Union([
	Type.Literal("quantitative"),
	Type.Literal("qualitative"),
	Type.Literal("mixed_methods"),
	Type.Literal("literature_review"),
	Type.Literal("conceptual"),
]);
export type ManuscriptPaperType = Static<typeof ManuscriptPaperTypeSchema>;

export const BibliographyEntrySchema = PersistedObject({
	citationKey: NonEmptyStringSchema,
	sourceId: NonEmptyStringSchema,
});
export type BibliographyEntry = Static<typeof BibliographyEntrySchema>;

export const ManuscriptRecordSchema = PersistedObject({
	kind: Type.Literal("manuscript"),
	schemaVersion: WritingRecordSchemaVersionSchema,
	manuscriptId: NonEmptyStringSchema,
	manuscriptSeriesId: NonEmptyStringSchema,
	version: Type.Integer({ minimum: 1 }),
	paperType: ManuscriptPaperTypeSchema,
	title: NonEmptyStringSchema,
	abstract: Nullable(Type.String()),
	sectionIds: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	claimOccurrenceIds: Type.Array(NonEmptyStringSchema),
	bibliography: Type.Array(BibliographyEntrySchema),
	methodRecords: Type.Array(RecordRefSchema),
	supersedesManuscriptId: Nullable(NonEmptyStringSchema),
	authoring: PersistedObject({
		origin: Type.Union([Type.Literal("human"), Type.Literal("model"), Type.Literal("imported")]),
		provider: Nullable(NonEmptyStringSchema),
		modelId: Nullable(NonEmptyStringSchema),
	}),
	contentHash: HashValueSchema,
	createdAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type ManuscriptRecord = Static<typeof ManuscriptRecordSchema>;

export const SectionRecordSchema = PersistedObject({
	kind: Type.Literal("section"),
	schemaVersion: WritingRecordSchemaVersionSchema,
	sectionId: NonEmptyStringSchema,
	manuscriptId: NonEmptyStringSchema,
	sectionKey: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	order: NonNegativeIntegerSchema,
	content: Type.String(),
	contentHash: HashValueSchema,
	wordCount: NonNegativeIntegerSchema,
	audit: RecordAuditSchema,
});
export type SectionRecord = Static<typeof SectionRecordSchema>;

export const ClaimOccurrenceSchema = PersistedObject({
	kind: Type.Literal("claim_occurrence"),
	schemaVersion: WritingRecordSchemaVersionSchema,
	claimOccurrenceId: NonEmptyStringSchema,
	manuscriptId: NonEmptyStringSchema,
	sectionId: NonEmptyStringSchema,
	claimId: NonEmptyStringSchema,
	text: NonEmptyStringSchema,
	charStart: NonNegativeIntegerSchema,
	charEnd: Type.Integer({ minimum: 1 }),
	anchorHash: HashValueSchema,
	core: Type.Boolean(),
	citationKeys: Type.Array(NonEmptyStringSchema),
	evidenceIds: Type.Array(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type ClaimOccurrence = Static<typeof ClaimOccurrenceSchema>;

export const ReviewFindingTypeSchema = Type.Union([
	Type.Literal("deterministic_violation"),
	Type.Literal("evidence_based_concern"),
	Type.Literal("methodological_judgment"),
	Type.Literal("stylistic_suggestion"),
]);
export type ReviewFindingType = Static<typeof ReviewFindingTypeSchema>;

export const ReviewFindingSchema = PersistedObject({
	kind: Type.Literal("review_finding"),
	schemaVersion: WritingRecordSchemaVersionSchema,
	reviewFindingId: NonEmptyStringSchema,
	manuscriptId: NonEmptyStringSchema,
	reviewerRole: Type.Union([
		Type.Literal("editor"),
		Type.Literal("methods"),
		Type.Literal("theory"),
		Type.Literal("devils_advocate"),
		Type.Literal("integrity"),
	]),
	findingType: ReviewFindingTypeSchema,
	severity: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")]),
	title: NonEmptyStringSchema,
	message: NonEmptyStringSchema,
	sectionId: Nullable(NonEmptyStringSchema),
	claimOccurrenceId: Nullable(NonEmptyStringSchema),
	fingerprint: HashValueSchema,
	source: Type.Union([Type.Literal("deterministic"), Type.Literal("model")]),
	model: Nullable(
		PersistedObject({
			provider: NonEmptyStringSchema,
			modelId: NonEmptyStringSchema,
			thinkingLevel: Nullable(Type.String()),
		}),
	),
	createdAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type ReviewFinding = Static<typeof ReviewFindingSchema>;

export const RevisionDecisionSchema = PersistedObject({
	kind: Type.Literal("revision_decision"),
	schemaVersion: WritingRecordSchemaVersionSchema,
	revisionDecisionId: NonEmptyStringSchema,
	manuscriptSeriesId: NonEmptyStringSchema,
	fromManuscriptId: Nullable(NonEmptyStringSchema),
	toManuscriptId: NonEmptyStringSchema,
	reviewFindingId: Nullable(NonEmptyStringSchema),
	decision: Type.Union([
		Type.Literal("accept"),
		Type.Literal("reject"),
		Type.Literal("defer"),
		Type.Literal("activate"),
		Type.Literal("rollback"),
	]),
	rationale: NonEmptyStringSchema,
	decidedAt: NonEmptyStringSchema,
	decidedBy: Type.Literal("user"),
	audit: RecordAuditSchema,
});
export type RevisionDecision = Static<typeof RevisionDecisionSchema>;

export const DisclosureRecordSchema = PersistedObject({
	kind: Type.Literal("disclosure"),
	schemaVersion: WritingRecordSchemaVersionSchema,
	disclosureId: NonEmptyStringSchema,
	manuscriptId: NonEmptyStringSchema,
	aiUse: NonEmptyStringSchema,
	modelIds: Type.Array(NonEmptyStringSchema),
	humanResponsibilities: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	limitations: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	unautomatedDecisions: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	status: Type.Union([Type.Literal("awaiting_confirmation"), Type.Literal("confirmed"), Type.Literal("rejected")]),
	confirmation: DesignConfirmationSchema,
	createdAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type DisclosureRecord = Static<typeof DisclosureRecordSchema>;

export const SubmissionGateCheckSchema = PersistedObject({
	code: NonEmptyStringSchema,
	status: Type.Union([Type.Literal("passed"), Type.Literal("warning"), Type.Literal("failed")]),
	message: NonEmptyStringSchema,
	recordRefs: Type.Array(RecordRefSchema),
});
export type SubmissionGateCheck = Static<typeof SubmissionGateCheckSchema>;

export const SubmissionGateReportSchema = PersistedObject({
	kind: Type.Literal("submission_gate_report"),
	schemaVersion: WritingRecordSchemaVersionSchema,
	submissionGateReportId: NonEmptyStringSchema,
	manuscriptId: NonEmptyStringSchema,
	passed: Type.Boolean(),
	publishability: PublishabilitySchema,
	checks: Type.Array(SubmissionGateCheckSchema, { minItems: 1 }),
	coreClaimOccurrenceCoverage: Type.Number({ minimum: 0, maximum: 1 }),
	citationVerificationCoverage: Type.Number({ minimum: 0, maximum: 1 }),
	openP0ReviewFindingCount: NonNegativeIntegerSchema,
	warningsAccepted: Type.Boolean(),
	approvalId: Nullable(NonEmptyStringSchema),
	checkedAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type SubmissionGateReport = Static<typeof SubmissionGateReportSchema>;

export const AdapterExportFormatSchema = Type.Union([
	Type.Literal("ris"),
	Type.Literal("bibtex"),
	Type.Literal("obsidian"),
	Type.Literal("docx"),
	Type.Literal("pdf"),
	Type.Literal("xlsx"),
	Type.Literal("pptx"),
	Type.Literal("zotero-api"),
]);
export type AdapterExportFormat = Static<typeof AdapterExportFormatSchema>;

export const AdapterExportProfileSchema = PersistedObject({
	kind: Type.Literal("adapter_export_profile"),
	schemaVersion: KnowledgeRecordSchemaVersionSchema,
	adapterExportProfileId: NonEmptyStringSchema,
	name: NonEmptyStringSchema,
	adapterId: NonEmptyStringSchema,
	adapterVersion: NonEmptyStringSchema,
	format: AdapterExportFormatSchema,
	destination: Type.Union([
		PersistedObject({ kind: Type.Literal("project_file"), path: RelativePathSchema }),
		PersistedObject({
			kind: Type.Literal("zotero_library"),
			libraryType: Type.Union([Type.Literal("users"), Type.Literal("groups")]),
			libraryId: NonEmptyStringSchema,
		}),
	]),
	credentialAlias: Nullable(NonEmptyStringSchema),
	enabled: Type.Boolean(),
	createdAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type AdapterExportProfile = Static<typeof AdapterExportProfileSchema>;

export const ExternalItemLinkSchema = PersistedObject({
	kind: Type.Literal("external_item_link"),
	schemaVersion: KnowledgeRecordSchemaVersionSchema,
	externalItemLinkId: NonEmptyStringSchema,
	adapterExportProfileId: NonEmptyStringSchema,
	recordRef: RecordRefSchema,
	externalItemId: Nullable(NonEmptyStringSchema),
	externalVersion: Nullable(NonNegativeIntegerSchema),
	contentHash: HashValueSchema,
	syncStatus: Type.Union([Type.Literal("synced"), Type.Literal("failed"), Type.Literal("pending_reconciliation")]),
	lastError: Nullable(ResearchErrorSchema),
	attemptedAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type ExternalItemLink = Static<typeof ExternalItemLinkSchema>;

export const MonitorQuerySchema = PersistedObject({
	text: NonEmptyStringSchema,
	filters: PersistedObject({
		fromYear: Nullable(Type.Integer({ minimum: 1000, maximum: 9999 })),
		toYear: Nullable(Type.Integer({ minimum: 1000, maximum: 9999 })),
		types: Type.Array(NonEmptyStringSchema, { maxItems: 100 }),
	}),
	maxResults: Type.Integer({ minimum: 1, maximum: 10_000 }),
});
export type MonitorQuery = Static<typeof MonitorQuerySchema>;

export const MonitorSubscriptionSchema = PersistedObject({
	kind: Type.Literal("monitor_subscription"),
	schemaVersion: KnowledgeRecordSchemaVersionSchema,
	monitorSubscriptionId: NonEmptyStringSchema,
	monitorSubscriptionSeriesId: NonEmptyStringSchema,
	version: Type.Integer({ minimum: 1 }),
	name: NonEmptyStringSchema,
	adapterId: Type.Union([Type.Literal("crossref"), Type.Literal("openalex")]),
	adapterVersion: NonEmptyStringSchema,
	query: MonitorQuerySchema,
	queryHash: HashValueSchema,
	cursor: JsonValueSchema,
	budget: PersistedObject({
		maxCost: MoneySchema,
		maxRequests: Type.Integer({ minimum: 1 }),
	}),
	status: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("retired")]),
	supersedesMonitorSubscriptionId: Nullable(NonEmptyStringSchema),
	lastSuccessfulRunId: Nullable(NonEmptyStringSchema),
	createdAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type MonitorSubscription = Static<typeof MonitorSubscriptionSchema>;

export const MonitorRunSchema = PersistedObject({
	kind: Type.Literal("monitor_run"),
	schemaVersion: KnowledgeRecordSchemaVersionSchema,
	monitorRunId: NonEmptyStringSchema,
	monitorSubscriptionId: NonEmptyStringSchema,
	queryHash: HashValueSchema,
	cursorBefore: JsonValueSchema,
	cursorAfter: JsonValueSchema,
	createdSourceIds: Type.Array(NonEmptyStringSchema),
	reusedSourceIds: Type.Array(NonEmptyStringSchema),
	requestCount: NonNegativeIntegerSchema,
	cost: MoneySchema,
	status: Type.Union([
		Type.Literal("succeeded"),
		Type.Literal("partially_succeeded"),
		Type.Literal("failed_retryable"),
	]),
	errors: Type.Array(ResearchErrorSchema),
	operationId: NonEmptyStringSchema,
	retryTaskId: Nullable(NonEmptyStringSchema),
	nextMonitorSubscriptionId: Nullable(NonEmptyStringSchema),
	confirmedAt: NonEmptyStringSchema,
	startedAt: NonEmptyStringSchema,
	finishedAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type MonitorRun = Static<typeof MonitorRunSchema>;

export const AdapterRegistrationRecordSchema = PersistedObject({
	kind: Type.Literal("adapter_registration"),
	schemaVersion: Type.Literal(RESEARCH_SCHEMA_VERSION),
	adapterRegistrationId: NonEmptyStringSchema,
	manifest: AdapterPackageManifestSchema,
	conformance: AdapterConformanceReportSchema,
	isolationProfile: AdapterIsolationProfileSchema,
	status: Type.Union([Type.Literal("active"), Type.Literal("disabled"), Type.Literal("legacy_trusted")]),
	registeredAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type AdapterRegistrationRecord = Static<typeof AdapterRegistrationRecordSchema>;

export const ExchangeRecordSchema = PersistedObject({
	kind: Type.Literal("exchange_record"),
	schemaVersion: Type.Literal(RESEARCH_SCHEMA_VERSION),
	exchangeRecordId: NonEmptyStringSchema,
	bundleId: NonEmptyStringSchema,
	direction: Type.Union([Type.Literal("pack"), Type.Literal("unpack")]),
	bundleManifestHash: HashValueSchema,
	peerProjectId: NonEmptyStringSchema,
	projectRevision: NonNegativeIntegerSchema,
	includesRawMaterials: Type.Boolean(),
	status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
	createdAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type ExchangeRecord = Static<typeof ExchangeRecordSchema>;

export const CollaborationMergeRecordSchema = PersistedObject({
	kind: Type.Literal("collaboration_merge"),
	schemaVersion: Type.Literal(RESEARCH_SCHEMA_VERSION),
	collaborationMergeId: NonEmptyStringSchema,
	changeSetId: NonEmptyStringSchema,
	changeSetHash: HashValueSchema,
	baseManifestRevision: NonNegativeIntegerSchema,
	applied: Type.Array(RecordRefSchema),
	skipped: Type.Array(RecordRefSchema),
	conflicts: Type.Array(
		PersistedObject({
			kind: RecordKindSchema,
			id: NonEmptyStringSchema,
			expectedHash: Nullable(HashValueSchema),
			actualHash: Nullable(HashValueSchema),
			proposedHash: HashValueSchema,
		}),
	),
	status: Type.Union([Type.Literal("merged"), Type.Literal("conflict")]),
	mergedAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type CollaborationMergeRecord = Static<typeof CollaborationMergeRecordSchema>;

export const ModelRouteDecisionRecordSchema = PersistedObject({
	kind: Type.Literal("model_route_decision"),
	schemaVersion: Type.Literal(RESEARCH_SCHEMA_VERSION),
	modelRouteDecisionId: NonEmptyStringSchema,
	requestHash: HashValueSchema,
	selected: Nullable(ModelRouteCandidateSchema),
	evaluations: Type.Array(ModelRouteEvaluationSchema, { minItems: 1 }),
	decidedAt: NonEmptyStringSchema,
	audit: RecordAuditSchema,
});
export type ModelRouteDecisionRecord = Static<typeof ModelRouteDecisionRecordSchema>;

export const CrossProjectSourceRefSchema = PersistedObject({
	strongIdentifier: NonEmptyStringSchema,
	projectId: NonEmptyStringSchema,
	projectLocator: NonEmptyStringSchema,
	sourceId: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	publicationYear: Nullable(Type.Integer({ minimum: 1000, maximum: 9999 })),
});
export type CrossProjectSourceRef = Static<typeof CrossProjectSourceRefSchema>;

export const ProjectCatalogSchema = PersistedObject({
	format: Type.Literal("pi-research-project-catalog"),
	version: Type.Literal(1),
	generatedAt: NonEmptyStringSchema,
	projectCount: NonNegativeIntegerSchema,
	sourceCount: NonNegativeIntegerSchema,
	sources: Type.Array(CrossProjectSourceRefSchema),
	duplicates: Type.Array(
		PersistedObject({
			strongIdentifier: NonEmptyStringSchema,
			refs: Type.Array(CrossProjectSourceRefSchema, { minItems: 2 }),
		}),
	),
	catalogHash: HashValueSchema,
});
export type ProjectCatalog = Static<typeof ProjectCatalogSchema>;

export const ProjectBackupFileSchema = PersistedObject({
	path: RelativePathSchema,
	hash: HashValueSchema,
	bytes: NonNegativeIntegerSchema,
});
export type ProjectBackupFile = Static<typeof ProjectBackupFileSchema>;

export const ProjectBackupManifestSchema = PersistedObject({
	format: Type.Literal("pi-research-project-backup"),
	version: Type.Literal(1),
	backupId: NonEmptyStringSchema,
	projectId: NonEmptyStringSchema,
	projectSchemaVersion: NonEmptyStringSchema,
	projectRevision: NonNegativeIntegerSchema,
	createdAt: NonEmptyStringSchema,
	label: Nullable(Type.String()),
	files: Type.Array(ProjectBackupFileSchema, { minItems: 1 }),
	rootHash: HashValueSchema,
});
export type ProjectBackupManifest = Static<typeof ProjectBackupManifestSchema>;

export const ExchangeBundleSignatureSchema = PersistedObject({
	algorithm: Type.Literal("ed25519"),
	publicKey: NonEmptyStringSchema,
	signature: NonEmptyStringSchema,
});
export type ExchangeBundleSignature = Static<typeof ExchangeBundleSignatureSchema>;

export const ExchangeBundleManifestSchema = PersistedObject({
	format: Type.Literal("pi-research-exchange-bundle"),
	version: Type.Literal(1),
	bundleId: NonEmptyStringSchema,
	projectId: NonEmptyStringSchema,
	projectSchemaVersion: NonEmptyStringSchema,
	projectRevision: NonNegativeIntegerSchema,
	createdAt: NonEmptyStringSchema,
	includesRawMaterials: Type.Boolean(),
	files: Type.Array(ProjectBackupFileSchema, { minItems: 1 }),
	excludedPaths: Type.Array(RelativePathSchema),
	requiredAdapters: Type.Array(
		PersistedObject({
			packageId: NonEmptyStringSchema,
			packageVersion: NonEmptyStringSchema,
			packageHash: Nullable(HashValueSchema),
			manifestHash: Nullable(HashValueSchema),
		}),
	),
	rootHash: HashValueSchema,
	signature: Nullable(ExchangeBundleSignatureSchema),
});
export type ExchangeBundleManifest = Static<typeof ExchangeBundleManifestSchema>;

export const CollaborationRecordChangeSchema = PersistedObject({
	kind: RecordKindSchema,
	id: NonEmptyStringSchema,
	path: RelativePathSchema,
	baseHash: Nullable(HashValueSchema),
	proposedHash: HashValueSchema,
	proposedRevision: NonNegativeIntegerSchema,
});
export type CollaborationRecordChange = Static<typeof CollaborationRecordChangeSchema>;

export const CollaborationChangeSetSchema = PersistedObject({
	format: Type.Literal("pi-research-collaboration-change-set"),
	version: Type.Literal(1),
	changeSetId: NonEmptyStringSchema,
	projectId: NonEmptyStringSchema,
	baseManifestRevision: NonNegativeIntegerSchema,
	authorOperationId: NonEmptyStringSchema,
	createdAt: NonEmptyStringSchema,
	changes: Type.Array(CollaborationRecordChangeSchema, { minItems: 1 }),
	rootHash: HashValueSchema,
});
export type CollaborationChangeSet = Static<typeof CollaborationChangeSetSchema>;

export const TaskStatusSchema = Type.Union([
	Type.Literal("planned"),
	Type.Literal("ready"),
	Type.Literal("running"),
	Type.Literal("awaiting_approval"),
	Type.Literal("blocked"),
	Type.Literal("succeeded"),
	Type.Literal("partially_succeeded"),
	Type.Literal("failed_retryable"),
	Type.Literal("failed_permanent"),
	Type.Literal("cancelled"),
]);
export type TaskStatus = Static<typeof TaskStatusSchema>;

export const ResearchTaskSchema = PersistedObject({
	kind: Type.Literal("task"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	taskId: NonEmptyStringSchema,
	taskType: NonEmptyStringSchema,
	title: NonEmptyStringSchema,
	inputs: Type.Array(RecordRefSchema),
	inputFiles: Type.Array(FileRefSchema),
	expectedOutputs: Type.Array(Type.String()),
	outputs: Type.Array(RecordRefSchema),
	outputFiles: Type.Array(FileRefSchema),
	dependencyTaskIds: Type.Array(NonEmptyStringSchema),
	status: TaskStatusSchema,
	attemptCount: NonNegativeIntegerSchema,
	maxAttempts: Type.Integer({ minimum: 1 }),
	idempotencyKey: NonEmptyStringSchema,
	operationIds: Type.Array(NonEmptyStringSchema),
	errors: Type.Array(ResearchErrorSchema),
	resumeCursor: JsonValueSchema,
	budget: PersistedObject({
		estimated: Nullable(MoneySchema),
		actual: MoneySchema,
	}),
	createdAt: NonEmptyStringSchema,
	startedAt: Nullable(NonEmptyStringSchema),
	finishedAt: Nullable(NonEmptyStringSchema),
	updatedAt: NonEmptyStringSchema,
	revision: NonNegativeIntegerSchema,
});
export type ResearchTask = Static<typeof ResearchTaskSchema>;

export const AnalysisRunSchema = PersistedObject({
	kind: Type.Literal("analysis_run"),
	schemaVersion: DataRecordSchemaVersionSchema,
	analysisRunId: NonEmptyStringSchema,
	analysisSpecificationId: NonEmptyStringSchema,
	taskId: NonEmptyStringSchema,
	runtime: PersistedObject({
		kind: Type.Union([Type.Literal("python"), Type.Literal("r"), Type.Literal("stata")]),
		adapterId: NonEmptyStringSchema,
		adapterVersion: NonEmptyStringSchema,
		executable: NonEmptyStringSchema,
		runtimeVersion: NonEmptyStringSchema,
		platform: NonEmptyStringSchema,
	}),
	script: FileRefSchema,
	environment: PersistedObject({
		lockFile: Nullable(FileRefSchema),
		packageSnapshot: Nullable(FileRefSchema),
		containerImage: Nullable(Type.String()),
		environmentHash: HashValueSchema,
	}),
	inputs: Type.Array(FileRefSchema),
	inputRecordRefs: Type.Array(RecordRefSchema),
	parameters: JsonValueSchema,
	randomSeed: Nullable(Type.Integer()),
	commandArguments: Type.Array(Type.String()),
	workingDirectory: RelativePathSchema,
	inputIntegrity: Type.Array(
		PersistedObject({
			path: RelativePathSchema,
			before: HashValueSchema,
			after: HashValueSchema,
			unchanged: Type.Boolean(),
			mutationDetected: Type.Boolean(),
		}),
	),
	outputs: Type.Array(FileRefSchema),
	logs: Type.Array(FileRefSchema),
	status: Type.Union([
		Type.Literal("planned"),
		Type.Literal("running"),
		Type.Literal("succeeded"),
		Type.Literal("failed"),
		Type.Literal("aborted"),
		Type.Literal("non_converged"),
	]),
	exitCode: Nullable(Type.Integer()),
	deterministicClaim: Type.Union([
		Type.Literal("not_claimed"),
		Type.Literal("seeded"),
		Type.Literal("fully_reproducible"),
	]),
	startedAt: Nullable(NonEmptyStringSchema),
	finishedAt: Nullable(NonEmptyStringSchema),
	failure: Nullable(ResearchErrorSchema),
	audit: RecordAuditSchema,
});
export type AnalysisRun = Static<typeof AnalysisRunSchema>;

export const ArtifactKindSchema = Type.Union([
	Type.Literal("markdown"),
	Type.Literal("json"),
	Type.Literal("ris"),
	Type.Literal("bibtex"),
	Type.Literal("obsidian"),
	Type.Literal("docx"),
	Type.Literal("pdf"),
	Type.Literal("xlsx"),
	Type.Literal("pptx"),
]);
export type ArtifactKind = Static<typeof ArtifactKindSchema>;

export const ArtifactRecordSchema = PersistedObject({
	kind: Type.Literal("artifact"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	artifactId: NonEmptyStringSchema,
	artifactKind: ArtifactKindSchema,
	title: NonEmptyStringSchema,
	sourceRecords: Type.Array(RecordRefSchema),
	sourceFiles: Type.Array(FileRefSchema),
	outputFile: FileRefSchema,
	generator: PersistedObject({
		id: NonEmptyStringSchema,
		version: NonEmptyStringSchema,
		operationId: NonEmptyStringSchema,
		templateId: Nullable(NonEmptyStringSchema),
		templateVersion: Nullable(NonEmptyStringSchema),
	}),
	inputAggregateHash: HashValueSchema,
	validation: PersistedObject({
		status: Type.Union([
			Type.Literal("not_checked"),
			Type.Literal("passed"),
			Type.Literal("passed_with_warnings"),
			Type.Literal("failed"),
		]),
		checks: Type.Array(
			PersistedObject({
				name: NonEmptyStringSchema,
				status: Type.Union([Type.Literal("passed"), Type.Literal("warning"), Type.Literal("failed")]),
				message: Type.String(),
				recordRefs: Type.Array(RecordRefSchema),
			}),
		),
	}),
	publishability: PublishabilitySchema,
	supersedesArtifactId: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type ArtifactRecord = Static<typeof ArtifactRecordSchema>;

export const ApprovalRecordSchema = PersistedObject({
	kind: Type.Literal("approval"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	approvalId: NonEmptyStringSchema,
	taskId: Nullable(NonEmptyStringSchema),
	operationId: Nullable(NonEmptyStringSchema),
	actionClass: ActionClassSchema,
	actionName: NonEmptyStringSchema,
	impactScope: Type.Array(Type.String()),
	estimatedCost: Nullable(MoneySchema),
	dataEgress: PersistedObject({
		destination: Nullable(Type.String()),
		dataClasses: Type.Array(Type.String()),
		fileRefs: Type.Array(FileRefSchema),
		recordRefs: Type.Array(RecordRefSchema),
	}),
	overwriteRisk: PersistedObject({
		paths: Type.Array(RelativePathSchema),
		destructive: Type.Boolean(),
		recoverable: Type.Boolean(),
	}),
	requestMessage: NonEmptyStringSchema,
	requestedAt: NonEmptyStringSchema,
	policySnapshotHash: HashValueSchema,
	decision: Type.Union([
		Type.Literal("approved"),
		Type.Literal("denied"),
		Type.Literal("cancelled"),
		Type.Literal("expired"),
	]),
	scope: Type.Union([
		Type.Literal("once"),
		Type.Literal("session"),
		Type.Literal("project"),
		Type.Literal("permanent_deny"),
	]),
	scopeTarget: PersistedObject({
		projectId: NonEmptyStringSchema,
		sessionId: Nullable(NonEmptyStringSchema),
		actionFingerprint: NonEmptyStringSchema,
		destinationPattern: Nullable(Type.String()),
		pathPatterns: Type.Array(RelativePathSchema),
		maxApprovedCost: Nullable(MoneySchema),
	}),
	decidedAt: Nullable(NonEmptyStringSchema),
	decidedBy: Nullable(Type.Union([Type.Literal("user"), Type.Literal("policy")])),
	expiresAt: Nullable(NonEmptyStringSchema),
	note: Nullable(Type.String()),
	audit: RecordAuditSchema,
});
export type ApprovalRecord = Static<typeof ApprovalRecordSchema>;

export const OperationStatusSchema = Type.Union([
	Type.Literal("planned"),
	Type.Literal("running"),
	Type.Literal("awaiting_approval"),
	Type.Literal("succeeded"),
	Type.Literal("partially_succeeded"),
	Type.Literal("failed_retryable"),
	Type.Literal("failed_permanent"),
	Type.Literal("blocked"),
	Type.Literal("cancelled"),
]);
export type OperationStatus = Static<typeof OperationStatusSchema>;

export const OperationRecordSchema = PersistedObject({
	kind: Type.Literal("operation"),
	schemaVersion: ExistingRecordSchemaVersionSchema,
	operationId: NonEmptyStringSchema,
	taskId: Nullable(NonEmptyStringSchema),
	operationKind: Type.Union([
		Type.Literal("model"),
		Type.Literal("tool"),
		Type.Literal("adapter"),
		Type.Literal("human"),
		Type.Literal("migration"),
	]),
	name: NonEmptyStringSchema,
	implementationVersion: NonEmptyStringSchema,
	status: OperationStatusSchema,
	session: Nullable(SessionLinkSchema),
	actor: PersistedObject({
		type: Type.Union([
			Type.Literal("model"),
			Type.Literal("tool"),
			Type.Literal("adapter"),
			Type.Literal("human"),
			Type.Literal("migration"),
		]),
		id: NonEmptyStringSchema,
	}),
	modelExecution: Nullable(
		PersistedObject({
			provider: NonEmptyStringSchema,
			modelId: NonEmptyStringSchema,
			thinkingLevel: Nullable(Type.String()),
			systemPromptHash: HashValueSchema,
			promptHash: HashValueSchema,
			samplingParameters: JsonValueSchema,
		}),
	),
	adapterExecution: Nullable(
		PersistedObject({
			adapterId: NonEmptyStringSchema,
			adapterVersion: NonEmptyStringSchema,
			capabilitySnapshotHash: HashValueSchema,
		}),
	),
	inputs: Type.Array(RecordRefSchema),
	inputFiles: Type.Array(FileRefSchema),
	outputs: Type.Array(RecordRefSchema),
	outputFiles: Type.Array(FileRefSchema),
	rawRequest: Nullable(FileRefSchema),
	rawResponse: Nullable(FileRefSchema),
	approvalIds: Type.Array(NonEmptyStringSchema),
	usage: PersistedObject({
		inputTokens: Nullable(NonNegativeIntegerSchema),
		outputTokens: Nullable(NonNegativeIntegerSchema),
		cacheReadTokens: Nullable(NonNegativeIntegerSchema),
		cacheWriteTokens: Nullable(NonNegativeIntegerSchema),
		networkRequests: NonNegativeIntegerSchema,
		cost: MoneySchema,
	}),
	error: Nullable(ResearchErrorSchema),
	startedAt: Nullable(NonEmptyStringSchema),
	finishedAt: Nullable(NonEmptyStringSchema),
	audit: RecordAuditSchema,
});
export type OperationRecord = Static<typeof OperationRecordSchema>;

export const PersistedRecordSchema = Type.Union([
	ResearchProjectManifestSchema,
	SourceRecordSchema,
	DocumentRecordSchema,
	EvidenceCardSchema,
	ClaimRecordSchema,
	CitationVerificationSchema,
	ResearchQuestionVersionSchema,
	ConceptRecordSchema,
	TheoryRelationSchema,
	DesignDecisionSchema,
	ProtocolRecordSchema,
	DatasetRecordSchema,
	VariableRecordSchema,
	AnalysisSpecificationSchema,
	QualitativeMaterialSchema,
	QualitativeSegmentSchema,
	CodebookVersionSchema,
	ModelSuggestionSchema,
	CodingDecisionSchema,
	ThemeSynthesisSchema,
	ManuscriptRecordSchema,
	SectionRecordSchema,
	ClaimOccurrenceSchema,
	ReviewFindingSchema,
	RevisionDecisionSchema,
	DisclosureRecordSchema,
	SubmissionGateReportSchema,
	AdapterExportProfileSchema,
	ExternalItemLinkSchema,
	MonitorSubscriptionSchema,
	MonitorRunSchema,
	AdapterRegistrationRecordSchema,
	ExchangeRecordSchema,
	CollaborationMergeRecordSchema,
	ModelRouteDecisionRecordSchema,
	ResearchTaskSchema,
	OperationRecordSchema,
	AnalysisRunSchema,
	ArtifactRecordSchema,
	ApprovalRecordSchema,
]);
export type PersistedRecord = Static<typeof PersistedRecordSchema>;

export const ResultMetaSchema = PersistedObject({
	operationId: Nullable(NonEmptyStringSchema),
	taskId: Nullable(NonEmptyStringSchema),
	warnings: Type.Array(Type.String()),
});
export type ResultMeta = Static<typeof ResultMetaSchema>;

export function createResearchResultSchema<const ValueSchema extends TSchema>(valueSchema: ValueSchema) {
	return Type.Union([
		PersistedObject({
			ok: Type.Literal(true),
			status: Type.Literal("SUCCESS"),
			value: valueSchema,
			errors: Type.Tuple([]),
			meta: ResultMetaSchema,
		}),
		PersistedObject({
			ok: Type.Literal(true),
			status: Type.Literal("PARTIAL_SUCCESS"),
			value: valueSchema,
			errors: Type.Array(ResearchErrorSchema, { minItems: 1 }),
			meta: ResultMetaSchema,
		}),
		PersistedObject({
			ok: Type.Literal(false),
			status: Type.Union([
				Type.Literal("RETRYABLE_FAILURE"),
				Type.Literal("PERMANENT_FAILURE"),
				Type.Literal("PERMISSION_BLOCKED"),
				Type.Literal("EXTERNAL_SERVICE_FAILURE"),
				Type.Literal("DATA_CONFLICT"),
			]),
			value: Type.Null(),
			errors: Type.Array(ResearchErrorSchema, { minItems: 1 }),
			meta: ResultMetaSchema,
		}),
	]);
}

export const JsonResearchResultSchema = createResearchResultSchema(JsonValueSchema);
export type ResearchResult<Value> = Static<ReturnType<typeof createResearchResultSchema<TUnsafe<Value>>>>;
export type JsonResearchResult = ResearchResult<JsonValue>;
export type ResultStatus = JsonResearchResult["status"];
export type ResearchStage = ResearchProjectManifest["currentStage"];
export type ProjectSensitivity = ResearchPolicyConfig["sensitivity"];
export type AnalysisRuntimeKind = AnalysisRun["runtime"]["kind"];
export type ApprovalDecision = ApprovalRecord["decision"];
export type ApprovalScope = ApprovalRecord["scope"];
export type OperationKind = OperationRecord["operationKind"];
