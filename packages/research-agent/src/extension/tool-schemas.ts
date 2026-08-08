// SPDX-License-Identifier: Apache-2.0

import { type Static, Type } from "typebox";
import {
	AdapterExportProfileSchema,
	BibliographyEntrySchema,
	ClaimRecordSchema,
	CodebookCodeSchema,
	ConceptRecordSchema,
	DesignBasisSchema,
	DesignDecisionSchema,
	DesignProvenanceRefSchema,
	EvidenceCardSchema,
	JsonValueSchema,
	ManuscriptRecordSchema,
	MonitorQuerySchema,
	MonitorSubscriptionSchema,
	ProjectSensitivitySchema,
	ProtocolRecordSchema,
	RecordRefSchema,
	ResearchQuestionVersionSchema,
	ReviewFindingSchema,
	ThemeSchema,
	TheoryRelationSchema,
} from "../contracts/schemas.ts";
export const SearchSourcesParameters = Type.Object(
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

export const MemoryInspectParameters = Type.Object(
	{
		action: Type.Union([Type.Literal("status"), Type.Literal("list"), Type.Literal("show"), Type.Literal("explain")]),
		filter: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		memoryId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		receiptId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	},
	{ additionalProperties: false },
);

export const MemoryFeedbackParameters = Type.Object(
	{
		action: Type.Union([Type.Literal("correct"), Type.Literal("forget"), Type.Literal("delete")]),
		memoryId: Type.String({ minLength: 1, maxLength: 256 }),
		value: Type.Optional(JsonValueSchema),
	},
	{ additionalProperties: false },
);

export const ImportSourcesParameters = Type.Object(
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

export const DocumentsParameters = Type.Object(
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

export const QueryCorpusParameters = Type.Object(
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

export const CORPUS_QUERY_DATA_CLASSES = {
	sources: ["bibliographic_metadata", "research_abstract"],
	documents: ["research_document_text"],
	evidence: ["research_evidence"],
	claims: ["research_claim"],
	all: [
		"bibliographic_metadata",
		"research_abstract",
		"research_document_text",
		"research_evidence",
		"research_claim",
	],
} as const satisfies Record<Static<typeof QueryCorpusParameters>["scope"], readonly string[]>;

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

export const CommitEvidenceParameters = Type.Object(
	{
		evidenceCards: Type.Array(EvidenceDraftSchema),
		claims: Type.Array(ClaimDraftSchema),
		expectedRevision: Type.Integer({ minimum: 0 }),
		validationMode: Type.Literal("strict"),
	},
	{ additionalProperties: false },
);

export const VerifyCitationsParameters = Type.Object(
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

export const ArtifactsParameters = Type.Object(
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
			Type.Literal("manuscript"),
			Type.Literal("ris"),
			Type.Literal("bibtex"),
			Type.Literal("json"),
			Type.Literal("obsidian"),
			Type.Literal("docx"),
			Type.Literal("pdf"),
			Type.Literal("xlsx"),
			Type.Literal("pptx"),
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

export const KnowledgeParameters = Type.Union([
	Type.Object(
		{
			action: Type.Literal("create_profile"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			name: Type.String({ minLength: 1 }),
			adapterId: Type.String({ minLength: 1 }),
			adapterVersion: Type.String({ minLength: 1 }),
			format: AdapterExportProfileSchema.properties.format,
			destination: AdapterExportProfileSchema.properties.destination,
			credentialAlias: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
			enabled: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("export_profile"),
			profileId: Type.String({ minLength: 1 }),
			sourceRefs: Type.Array(RecordRefSchema, { minItems: 1 }),
			targetStatus: Type.Union([Type.Literal("exploratory"), Type.Literal("evidence_checked")]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("zotero_push"),
			profileId: Type.String({ minLength: 1 }),
			sourceIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("build_catalog"),
			projects: Type.Array(
				Type.Object(
					{ root: Type.String({ minLength: 1 }), locator: Type.String({ minLength: 1 }) },
					{ additionalProperties: false },
				),
				{ minItems: 1 },
			),
			outputPath: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("query_catalog"),
			path: Type.String({ minLength: 1 }),
			strongIdentifier: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export const MonitorParameters = Type.Union([
	Type.Object(
		{
			action: Type.Literal("create"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			name: Type.String({ minLength: 1 }),
			adapterId: MonitorSubscriptionSchema.properties.adapterId,
			query: MonitorQuerySchema,
			budget: MonitorSubscriptionSchema.properties.budget,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("revise"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			monitorSubscriptionId: Type.String({ minLength: 1 }),
			name: Type.String({ minLength: 1 }),
			query: MonitorQuerySchema,
			budget: MonitorSubscriptionSchema.properties.budget,
			status: MonitorSubscriptionSchema.properties.status,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("run"),
			monitorSubscriptionId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
]);

const DesignBasisInputSchema = Type.Object(
	{
		summary: DesignBasisSchema.properties.summary,
		provenance: Type.Array(DesignProvenanceRefSchema),
		evidenceGap: DesignBasisSchema.properties.evidenceGap,
	},
	{ additionalProperties: false },
);

export const DesignParameters = Type.Union([
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

export const AnalysisParameters = Type.Union([
	Type.Object(
		{
			action: Type.Literal("import_dataset"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			path: Type.String({ minLength: 1 }),
			title: Type.String({ minLength: 1 }),
			sensitivity: ProjectSensitivitySchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("create_specification"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			title: Type.String({ minLength: 1 }),
			protocolId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
			datasetIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			runtime: Type.Union([Type.Literal("python"), Type.Literal("r"), Type.Literal("stata")]),
			scriptPath: Type.String({ minLength: 1 }),
			environmentPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
			parameters: JsonValueSchema,
			randomSeed: Type.Union([Type.Integer(), Type.Null()]),
			commandArguments: Type.Array(Type.String()),
			expectedOutputs: Type.Array(Type.String({ minLength: 1 })),
			timeoutSeconds: Type.Integer({ minimum: 1, maximum: 3_600 }),
			claimMode: Type.Union([
				Type.Literal("descriptive"),
				Type.Literal("associational"),
				Type.Literal("causal"),
				Type.Literal("interpretive"),
				Type.Literal("comparative"),
			]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("decide_specification"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			analysisSpecificationId: Type.String({ minLength: 1 }),
			expectedRecordRevision: Type.Integer({ minimum: 0 }),
			decision: Type.Union([Type.Literal("confirmed"), Type.Literal("rejected")]),
			note: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("detect_runtime"),
			runtime: Type.Union([Type.Literal("python"), Type.Literal("r"), Type.Literal("stata")]),
			executable: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("run"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			analysisSpecificationId: Type.String({ minLength: 1 }),
			executable: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		},
		{ additionalProperties: false },
	),
]);

export const QualitativeParameters = Type.Union([
	Type.Object(
		{
			action: Type.Literal("import_material"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			path: Type.String({ minLength: 1 }),
			title: Type.String({ minLength: 1 }),
			sensitivity: ProjectSensitivitySchema,
			deidentified: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("segment_material"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			qualitativeMaterialId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("create_codebook"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			title: Type.String({ minLength: 1 }),
			codes: Type.Array(CodebookCodeSchema, { minItems: 1 }),
			supersedesCodebookVersionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("decide_synthesis"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			kind: Type.Union([Type.Literal("codebook_version"), Type.Literal("theme_synthesis")]),
			id: Type.String({ minLength: 1 }),
			expectedRecordRevision: Type.Integer({ minimum: 0 }),
			decision: Type.Union([Type.Literal("confirmed"), Type.Literal("rejected")]),
			note: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("record_model_suggestion"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			qualitativeSegmentId: Type.String({ minLength: 1 }),
			codebookVersionId: Type.String({ minLength: 1 }),
			suggestedCodeIds: Type.Array(Type.String({ minLength: 1 })),
			rationale: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("record_coding_decision"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			qualitativeSegmentId: Type.String({ minLength: 1 }),
			codebookVersionId: Type.String({ minLength: 1 }),
			modelSuggestionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
			decision: Type.Union([Type.Literal("accepted"), Type.Literal("edited"), Type.Literal("rejected")]),
			assignedCodeIds: Type.Array(Type.String({ minLength: 1 })),
			note: Type.Optional(Type.String()),
			supersedesCodingDecisionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("create_theme_synthesis"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			codebookVersionId: Type.String({ minLength: 1 }),
			title: Type.String({ minLength: 1 }),
			themes: Type.Array(ThemeSchema, { minItems: 1 }),
			codingDecisionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			supersedesThemeSynthesisId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("audit"),
			expectedRevision: Type.Integer({ minimum: 0 }),
		},
		{ additionalProperties: false },
	),
]);

const ManuscriptOccurrenceDraftSchema = Type.Object(
	{
		claimId: Type.String({ minLength: 1 }),
		text: Type.String({ minLength: 1 }),
		charStart: Type.Integer({ minimum: 0 }),
		charEnd: Type.Integer({ minimum: 1 }),
		core: Type.Boolean(),
		citationKeys: Type.Array(Type.String({ minLength: 1 })),
		evidenceIds: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const ManuscriptSectionDraftSchema = Type.Object(
	{
		sectionKey: Type.String({ minLength: 1 }),
		title: Type.String({ minLength: 1 }),
		order: Type.Integer({ minimum: 0 }),
		content: Type.String(),
		occurrences: Type.Array(ManuscriptOccurrenceDraftSchema),
	},
	{ additionalProperties: false },
);

export const ManuscriptParameters = Type.Union([
	Type.Object(
		{
			action: Type.Literal("create_revision"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			title: ManuscriptRecordSchema.properties.title,
			paperType: ManuscriptRecordSchema.properties.paperType,
			abstract: ManuscriptRecordSchema.properties.abstract,
			bibliography: Type.Array(BibliographyEntrySchema),
			methodRecords: Type.Array(RecordRefSchema),
			sections: Type.Array(ManuscriptSectionDraftSchema, { minItems: 1 }),
			supersedesManuscriptId: ManuscriptRecordSchema.properties.supersedesManuscriptId,
			authoringOrigin: ManuscriptRecordSchema.properties.authoring.properties.origin,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("create_disclosure"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			manuscriptId: Type.String({ minLength: 1 }),
			aiUse: Type.String({ minLength: 1 }),
			modelIds: Type.Array(Type.String({ minLength: 1 })),
			humanResponsibilities: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			limitations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			unautomatedDecisions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("submission_gate"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			manuscriptId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("diff"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			fromManuscriptId: Type.String({ minLength: 1 }),
			toManuscriptId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

const ReviewFindingDraftSchema = Type.Object(
	{
		reviewerRole: ReviewFindingSchema.properties.reviewerRole,
		findingType: Type.Union([
			Type.Literal("evidence_based_concern"),
			Type.Literal("methodological_judgment"),
			Type.Literal("stylistic_suggestion"),
		]),
		severity: ReviewFindingSchema.properties.severity,
		title: ReviewFindingSchema.properties.title,
		message: ReviewFindingSchema.properties.message,
		sectionId: ReviewFindingSchema.properties.sectionId,
		claimOccurrenceId: ReviewFindingSchema.properties.claimOccurrenceId,
	},
	{ additionalProperties: false },
);

export const ReviewParameters = Type.Union([
	Type.Object(
		{
			action: Type.Literal("record_findings"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			manuscriptId: Type.String({ minLength: 1 }),
			findings: Type.Array(ReviewFindingDraftSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("record_integrity_findings"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			manuscriptId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("decide_finding"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			manuscriptId: Type.String({ minLength: 1 }),
			reviewFindingId: Type.String({ minLength: 1 }),
			decision: Type.Union([Type.Literal("accept"), Type.Literal("reject"), Type.Literal("defer")]),
			rationale: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("set_active_revision"),
			expectedRevision: Type.Integer({ minimum: 0 }),
			fromManuscriptId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
			toManuscriptId: Type.String({ minLength: 1 }),
			decision: Type.Union([Type.Literal("activate"), Type.Literal("rollback")]),
			rationale: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);
