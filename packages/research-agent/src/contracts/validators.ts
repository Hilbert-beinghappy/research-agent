// SPDX-License-Identifier: Apache-2.0

import { Compile } from "typebox/compile";
import { canonicalizeJson } from "./canonical-json.ts";
import {
	type AnalysisRun,
	type AnalysisSpecification,
	type ApprovalRecord,
	type ArtifactRecord,
	type CitationVerification,
	type ClaimRecord,
	type CodebookVersion,
	type CodingDecision,
	type ConceptRecord,
	type DatasetRecord,
	type DesignDecision,
	type DocumentRecord,
	type EvidenceCard,
	type FileRef,
	type JsonResearchResult,
	JsonResearchResultSchema,
	type ModelSuggestion,
	type OperationRecord,
	type PersistedRecord,
	PersistedRecordSchema,
	type ProtocolRecord,
	type QualitativeMaterial,
	type QualitativeSegment,
	type ResearchProjectManifest,
	type ResearchQuestionVersion,
	type ResearchTask,
	type SourceRecord,
	type ThemeSynthesis,
	type TheoryRelation,
} from "./schemas.ts";

export interface ContractIssue {
	path: string;
	code: string;
	message: string;
}

export type ContractValidation<T> =
	| { ok: true; value: T; issues: [] }
	| { ok: false; value: null; issues: [ContractIssue, ...ContractIssue[]] };

const persistedRecordValidator = Compile(PersistedRecordSchema);
const resultValidator = Compile(JsonResearchResultSchema);

function issue(path: string, code: string, message: string): ContractIssue {
	return { path, code, message };
}

function completeFile(file: FileRef | null): boolean {
	return file !== null && file.hash !== null && file.mediaType !== null && file.bytes !== null;
}

function conflictIssues(conflicts: SourceRecord["metadataConflicts"], path: string): ContractIssue[] {
	const issues: ContractIssue[] = [];
	for (const [index, conflict] of conflicts.entries()) {
		if (conflict.resolution === "unresolved" && (conflict.resolvedBy !== null || conflict.resolvedAt !== null)) {
			issues.push(
				issue(
					`${path}[${index}]`,
					"conflict.unresolved_has_resolution",
					"unresolved conflict cannot have resolution metadata",
				),
			);
		}
		if (conflict.resolution !== "unresolved" && (conflict.resolvedBy === null || conflict.resolvedAt === null)) {
			issues.push(
				issue(
					`${path}[${index}]`,
					"conflict.resolution_missing",
					"resolved conflict requires resolver and timestamp",
				),
			);
		}
	}
	return issues;
}

function manifestIssues(record: ResearchProjectManifest): ContractIssue[] {
	const issues: ContractIssue[] = [];
	const kinds = record.recordSets.map((entry) => entry.kind);
	if (new Set(kinds).size !== kinds.length) {
		issues.push(issue("recordSets", "manifest.duplicate_record_set", "record set kinds must be unique"));
	}
	for (const [index, question] of record.researchQuestions.entries()) {
		const hasTimestamp = question.confirmedAt !== null;
		const hasActor = question.confirmedBy !== null;
		if (
			hasTimestamp !== hasActor ||
			(question.status === "confirmed" && !hasTimestamp) ||
			(question.status === "draft" && hasTimestamp)
		) {
			issues.push(
				issue(
					`researchQuestions[${index}]`,
					"question.confirmation_mismatch",
					"draft questions cannot have confirmation metadata and confirmed questions require it",
				),
			);
		}
	}
	return issues;
}

function sourceIssues(record: SourceRecord): ContractIssue[] {
	const issues = conflictIssues(record.metadataConflicts, "metadataConflicts");
	for (const [index, identifier] of record.identifiers.entries()) {
		if (identifier.verified && identifier.verificationId === null) {
			issues.push(
				issue(
					`identifiers[${index}]`,
					"identifier.verification_mismatch",
					"verified identifier requires a verification ID",
				),
			);
		}
	}
	for (const [index, discovery] of record.discovery.entries()) {
		if (!completeFile(discovery.rawRecord)) {
			issues.push(
				issue(
					`discovery[${index}].rawRecord`,
					"source.raw_record_incomplete",
					"discovery raw record requires hash, media type, and byte size",
				),
			);
		}
	}
	if (record.duplicateStatus === "merged_alias" && record.canonicalSourceId === null) {
		issues.push(
			issue("canonicalSourceId", "source.alias_without_canonical", "merged alias requires a canonical source ID"),
		);
	}
	return issues;
}

function documentIssues(record: DocumentRecord): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (record.localFile !== null && !completeFile(record.localFile)) {
		issues.push(
			issue("localFile", "document.local_file_incomplete", "local file requires hash, media type, and byte size"),
		);
	}
	if (record.localFile !== null && !record.immutableOriginal) {
		issues.push(issue("immutableOriginal", "document.mutable_original", "acquired original must be immutable"));
	}
	const acquired = [
		"acquired_unparsed",
		"parsed",
		"parsed_with_warnings",
		"ocr_required",
		"parse_failed",
		"quarantined",
	].includes(record.fullTextStatus);
	if (acquired && record.localFile === null) {
		issues.push(
			issue("localFile", "document.acquired_without_file", "acquired document status requires a local file"),
		);
	}
	if (record.fullTextStatus === "parsed" || record.fullTextStatus === "parsed_with_warnings") {
		if (record.parser === null || record.parsedAt === null || !completeFile(record.parsedOutput)) {
			issues.push(
				issue(
					"parsedOutput",
					"document.parsed_output_incomplete",
					"parsed status requires parser, timestamp, and complete parsed output",
				),
			);
		}
		if (record.textLayer !== "present" && record.textLayer !== "partial") {
			issues.push(
				issue(
					"textLayer",
					"document.parsed_without_text",
					"parsed status requires a present or partial text layer",
				),
			);
		}
	}
	if (record.fullTextStatus === "parse_failed" && record.failure === null) {
		issues.push(issue("failure", "document.failure_missing", "parse failure requires a structured error"));
	}
	return issues;
}

function evidenceIssues(record: EvidenceCard): ContractIssue[] {
	const issues: ContractIssue[] = [];
	const located = ["fulltext_located", "table_or_figure_located", "dataset_or_appendix_located"].includes(
		record.evidenceLevel,
	);
	const sourceOnly = record.evidenceLevel === "metadata" || record.evidenceLevel === "abstract";
	if (located && (record.documentId === null || record.locator === null)) {
		issues.push(issue("locator", "evidence.locator_missing", "located evidence requires a document and locator"));
	}
	if (!located && record.locator !== null) {
		issues.push(issue("locator", "evidence.locator_unexpected", "unlocated evidence cannot carry a locator"));
	}
	if (sourceOnly && record.documentId !== null) {
		issues.push(
			issue("documentId", "evidence.source_level_has_document", "metadata and abstract evidence are source-level"),
		);
	}
	if (record.evidenceLevel === "fulltext_unlocated" && record.documentId === null) {
		issues.push(
			issue("documentId", "evidence.unlocated_document_missing", "unlocated full text still requires a document"),
		);
	}
	if (record.excerptExactMatch === true && record.excerpt === null) {
		issues.push(
			issue("excerpt", "evidence.exact_match_without_excerpt", "exact excerpt match requires stored excerpt text"),
		);
	}
	if (record.excerpt !== null && record.excerptExactMatch !== true) {
		issues.push(
			issue("excerptExactMatch", "evidence.stored_excerpt_unverified", "stored excerpts must be exact matches"),
		);
	}
	if (record.locator !== null) {
		if (record.locator.pageStart === 0) {
			issues.push(issue("locator.pageStart", "evidence.page_zero", "document page numbers are one-based"));
		}
		if (
			record.locator.pageEnd !== null &&
			(record.locator.pageStart === null || record.locator.pageEnd < record.locator.pageStart)
		) {
			issues.push(issue("locator.pageEnd", "evidence.page_range_invalid", "page range is invalid"));
		}
		if ((record.locator.charStart === null) !== (record.locator.charEnd === null)) {
			issues.push(
				issue("locator.charEnd", "evidence.char_range_incomplete", "character offsets must be provided together"),
			);
		}
		if (
			record.locator.charStart !== null &&
			record.locator.charEnd !== null &&
			record.locator.charEnd <= record.locator.charStart
		) {
			issues.push(issue("locator.charEnd", "evidence.char_range_invalid", "character range must be non-empty"));
		}
		if (located && record.locator.anchorHash === null) {
			issues.push(
				issue("locator.anchorHash", "evidence.anchor_missing", "located evidence requires an anchor hash"),
			);
		}
	}
	if (
		record.extraction.method === "model_suggested" &&
		(record.extraction.modelProvider === null ||
			record.extraction.modelId === null ||
			record.extraction.promptHash === null)
	) {
		issues.push(
			issue(
				"extraction",
				"evidence.model_provenance_missing",
				"model-suggested evidence requires provider, model, and prompt hash",
			),
		);
	}
	if (
		record.evidenceLevel === "table_or_figure_located" &&
		record.locator !== null &&
		record.locator.locatorType !== "table" &&
		record.locator.locatorType !== "figure"
	) {
		issues.push(
			issue(
				"locator.locatorType",
				"evidence.figure_locator_mismatch",
				"table or figure evidence requires a table or figure locator",
			),
		);
	}
	return issues;
}

function claimIssues(record: ClaimRecord): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (
		(record.supportStatus === "supported" || record.supportStatus === "partially_supported") &&
		record.evidenceLinks.length === 0
	) {
		issues.push(issue("evidenceLinks", "claim.support_without_evidence", "supported claim requires evidence links"));
	}
	if (record.supportStatus === "mixed") {
		const relations = new Set(record.evidenceLinks.map((link) => link.relation));
		if (!relations.has("supports") || (!relations.has("refutes") && !relations.has("qualifies"))) {
			issues.push(
				issue(
					"evidenceLinks",
					"claim.mixed_without_conflict",
					"mixed support requires supporting and refuting or qualifying evidence",
				),
			);
		}
	}
	if (record.publishability === "submission_candidate" && record.evidenceLinks.length === 0) {
		issues.push(
			issue("publishability", "claim.submission_without_evidence", "submission candidate requires evidence"),
		);
	}
	const reviewed = record.humanConfirmation.status !== "not_reviewed";
	if (reviewed !== (record.humanConfirmation.decidedAt !== null)) {
		issues.push(
			issue(
				"humanConfirmation.decidedAt",
				"claim.review_timestamp_mismatch",
				"reviewed claim requires decision timestamp only after review",
			),
		);
	}
	return issues;
}

function citationIssues(record: CitationVerification): ContractIssue[] {
	const issues = conflictIssues(record.conflicts, "conflicts");
	const bibliographicallyVerified =
		record.finalStatus === "verified" || record.finalStatus === "verified_with_warning";
	for (const [index, identifier] of record.identifiers.entries()) {
		if (identifier.verified !== (identifier.verificationId === record.verificationId)) {
			issues.push(
				issue(
					`identifiers[${index}]`,
					"citation.identifier_verification_mismatch",
					"citation identifier verification must reference this verification record",
				),
			);
		}
	}
	if (
		bibliographicallyVerified ||
		record.finalStatus === "not_found" ||
		record.finalStatus === "service_unavailable"
	) {
		if (record.verificationSources.length === 0) {
			issues.push(
				issue(
					"verificationSources",
					"citation.verified_without_source",
					"citation result requires an external verification source",
				),
			);
		}
		if (record.verificationSources.some((source) => !completeFile(source.rawRecord))) {
			issues.push(
				issue(
					"verificationSources",
					"citation.raw_record_incomplete",
					"verified citation sources require complete raw records",
				),
			);
		}
	}
	if (bibliographicallyVerified) {
		if (record.fieldChecks.some((check) => check.status === "conflict")) {
			issues.push(
				issue(
					"fieldChecks",
					"citation.verified_with_field_conflict",
					"bibliographically verified citation cannot contain conflicting fields",
				),
			);
		}
		if (record.fieldChecks.length === 0 || !record.identifiers.some((identifier) => identifier.verified)) {
			issues.push(
				issue(
					"fieldChecks",
					"citation.verification_basis_missing",
					"verified citation requires a verified identifier and field checks",
				),
			);
		}
		if (record.conflicts.some((conflict) => conflict.resolution === "unresolved")) {
			issues.push(
				issue(
					"conflicts",
					"citation.verified_with_conflict",
					"verified citation cannot contain unresolved metadata conflicts",
				),
			);
		}
	}
	if (
		record.finalStatus === "verified" &&
		(record.publicationStatus !== "normal" || record.fieldChecks.some((check) => check.status !== "match"))
	) {
		issues.push(
			issue(
				"finalStatus",
				"citation.warning_suppressed",
				"plain verified status requires normal publication status and exact field matches",
			),
		);
	}
	if (
		(record.finalStatus === "not_found" || record.finalStatus === "service_unavailable") &&
		(record.identifiers.some(({ verified }) => verified) || record.fieldChecks.length > 0)
	) {
		issues.push(
			issue(
				"finalStatus",
				"citation.absent_with_bibliographic_match",
				"not-found or unavailable result cannot contain verified identifiers or field matches",
			),
		);
	}
	if (
		!Number.isFinite(Date.parse(record.verifiedAt)) ||
		(record.expiresAt !== null &&
			(!Number.isFinite(Date.parse(record.expiresAt)) ||
				Date.parse(record.expiresAt) <= Date.parse(record.verifiedAt)))
	) {
		issues.push(issue("expiresAt", "citation.expiry_invalid", "citation expiry must follow its verification time"));
	}
	return issues;
}

type ReviewableDesignRecord =
	| ResearchQuestionVersion
	| ConceptRecord
	| TheoryRelation
	| DesignDecision
	| ProtocolRecord;

type ConfirmableRecord = Pick<ReviewableDesignRecord, "status" | "confirmation">;

function confirmationIssues(record: ConfirmableRecord): ContractIssue[] {
	const issues: ContractIssue[] = [];
	const { confirmation } = record;
	if (record.status === "draft" || record.status === "awaiting_confirmation") {
		if (confirmation.decision !== null || confirmation.decidedAt !== null || confirmation.decidedBy !== null) {
			issues.push(
				issue(
					"confirmation",
					"design.premature_confirmation",
					"draft or awaiting-confirmation records cannot carry a decision",
				),
			);
		}
		return issues;
	}
	if (record.status === "confirmed" || record.status === "rejected") {
		if (
			confirmation.decision !== record.status ||
			confirmation.decidedAt === null ||
			confirmation.decidedBy === null ||
			!Number.isFinite(Date.parse(confirmation.decidedAt))
		) {
			issues.push(
				issue(
					"confirmation",
					"design.confirmation_mismatch",
					"confirmed and rejected records require a matching user decision and timestamp",
				),
			);
		}
	}
	return issues;
}

function designReviewIssues(record: ReviewableDesignRecord): ContractIssue[] {
	const issues = confirmationIssues(record);
	if (record.status === "confirmed") {
		const hasOperation = record.basis.provenance.some(({ kind }) => kind === "operation");
		const hasEvidence = record.basis.provenance.some(({ kind }) => kind === "evidence" || kind === "claim");
		if (!hasOperation || (!record.basis.evidenceGap && !hasEvidence)) {
			issues.push(
				issue(
					"basis.provenance",
					"design.provenance_missing",
					"confirmed design requires an Operation and either Evidence/Claim provenance or an explicit evidence gap",
				),
			);
		}
	}
	return issues;
}

function researchQuestionVersionIssues(record: ResearchQuestionVersion): ContractIssue[] {
	const issues = designReviewIssues(record);
	if (
		(record.version === 1 && record.supersedesResearchQuestionVersionId !== null) ||
		(record.version > 1 && record.supersedesResearchQuestionVersionId === null)
	) {
		issues.push(
			issue(
				"supersedesResearchQuestionVersionId",
				"question.version_chain_invalid",
				"question version 1 cannot supersede another version and later versions must do so",
			),
		);
	}
	return issues;
}

function theoryRelationIssues(record: TheoryRelation): ContractIssue[] {
	const issues = designReviewIssues(record);
	if (
		record.status === "confirmed" &&
		(record.hypothesesOrPropositions.length === 0 ||
			record.alternativeExplanations.length === 0 ||
			record.boundaryConditions.length === 0)
	) {
		issues.push(
			issue(
				"hypothesesOrPropositions",
				"theory.confirmed_incomplete",
				"confirmed theory relations require a hypothesis or proposition, an alternative, and a boundary",
			),
		);
	}
	return issues;
}

function designDecisionIssues(record: DesignDecision): ContractIssue[] {
	const issues = designReviewIssues(record);
	const optionIds = record.options.map(({ optionId }) => optionId);
	if (new Set(optionIds).size !== optionIds.length) {
		issues.push(issue("options", "decision.duplicate_option", "decision option IDs must be unique"));
	}
	if (record.selectedOptionId !== null && !optionIds.includes(record.selectedOptionId)) {
		issues.push(issue("selectedOptionId", "decision.option_missing", "selected option must exist"));
	}
	if (
		record.status === "confirmed" &&
		(record.selectedOptionId === null ||
			record.rationale === null ||
			record.rationale.trim().length === 0 ||
			(record.critical &&
				(record.options.length < 2 ||
					record.alternativesConsidered.length === 0 ||
					record.limitations.length === 0)))
	) {
		issues.push(
			issue(
				"selectedOptionId",
				"decision.confirmed_incomplete",
				"confirmed decisions require a selected option and rationale; critical decisions also require alternatives and limitations",
			),
		);
	}
	return issues;
}

function protocolIssues(record: ProtocolRecord): ContractIssue[] {
	const issues = designReviewIssues(record);
	if (
		record.claimMode === "causal" &&
		(record.identificationStrategy === null || record.identificationAssumptions.length === 0)
	) {
		issues.push(
			issue(
				"identificationStrategy",
				"protocol.causal_identification_missing",
				"causal protocols require an identification strategy and explicit assumptions",
			),
		);
	}
	if (record.designType === "quantitative" && record.preanalysisPlan === null) {
		issues.push(
			issue(
				"preanalysisPlan",
				"protocol.quantitative_plan_missing",
				"quantitative protocols require a preanalysis plan",
			),
		);
	}
	if (record.designType === "qualitative" && record.interviewPlan === null && record.caseSelectionPlan === null) {
		issues.push(
			issue(
				"interviewPlan",
				"protocol.qualitative_plan_missing",
				"qualitative protocols require an interview or case-selection plan",
			),
		);
	}
	if (
		record.status === "confirmed" &&
		(record.decisionIds.length === 0 ||
			record.conceptIds.length === 0 ||
			record.inclusionCriteria.length === 0 ||
			record.exclusionCriteria.length === 0 ||
			record.alternativeExplanations.length === 0 ||
			record.boundaryConditions.length === 0 ||
			record.feasibilityLimits.length === 0 ||
			record.ethicsChecklist.length === 0)
	) {
		issues.push(
			issue(
				"status",
				"protocol.confirmed_incomplete",
				"confirmed protocols require decisions, concepts, criteria, alternatives, boundaries, feasibility limits, and ethics checks",
			),
		);
	}
	return issues;
}

function datasetIssues(record: DatasetRecord): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (!completeFile(record.sourceFile)) {
		issues.push(
			issue("sourceFile", "dataset.source_incomplete", "dataset source requires hash, media type, and byte size"),
		);
	}
	if (!record.immutableOriginal) {
		issues.push(issue("immutableOriginal", "dataset.mutable_original", "imported dataset must be immutable"));
	}
	if (
		record.columnCount !== record.variableIds.length ||
		new Set(record.variableIds).size !== record.variableIds.length
	) {
		issues.push(
			issue("variableIds", "dataset.variable_index_invalid", "dataset columns require one unique variable ID each"),
		);
	}
	if (!Number.isFinite(Date.parse(record.importedAt))) {
		issues.push(issue("importedAt", "dataset.import_time_invalid", "dataset import time must be an ISO date-time"));
	}
	return issues;
}

function analysisSpecificationIssues(record: AnalysisSpecification): ContractIssue[] {
	const issues = confirmationIssues(record);
	if (
		!completeFile(record.script) ||
		(record.environmentFile !== null && !completeFile(record.environmentFile)) ||
		record.inputFiles.some((file) => !completeFile(file))
	) {
		issues.push(
			issue(
				"inputFiles",
				"analysis_specification.file_integrity_missing",
				"analysis specifications require hashed script and input files",
			),
		);
	}
	if (new Set(record.expectedOutputs).size !== record.expectedOutputs.length) {
		issues.push(
			issue("expectedOutputs", "analysis_specification.duplicate_output", "expected output paths must be unique"),
		);
	}
	if (
		new Set(record.inputDatasetIds).size !== record.inputDatasetIds.length ||
		new Set(record.inputFiles.map(({ path }) => path)).size !== record.inputFiles.length
	) {
		issues.push(
			issue(
				"inputDatasetIds",
				"analysis_specification.duplicate_input",
				"analysis dataset and file inputs must be unique",
			),
		);
	}
	return issues;
}

function qualitativeMaterialIssues(record: QualitativeMaterial): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (!completeFile(record.sourceFile)) {
		issues.push(
			issue(
				"sourceFile",
				"qualitative_material.source_incomplete",
				"material source requires complete file metadata",
			),
		);
	}
	if (!record.immutableOriginal) {
		issues.push(
			issue("immutableOriginal", "qualitative_material.mutable_original", "imported material must be immutable"),
		);
	}
	return issues;
}

function qualitativeSegmentIssues(record: QualitativeSegment): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (
		record.locator.charEnd <= record.locator.charStart ||
		record.locator.charEnd - record.locator.charStart !== record.text.length
	) {
		issues.push(
			issue(
				"locator",
				"qualitative_segment.locator_invalid",
				"segment locator must be a half-open character range matching the stored text",
			),
		);
	}
	return issues;
}

function codebookIssues(record: CodebookVersion): ContractIssue[] {
	const issues = confirmationIssues(record);
	const codeIds = record.codes.map(({ codeId }) => codeId);
	if (new Set(codeIds).size !== codeIds.length) {
		issues.push(issue("codes", "codebook.duplicate_code", "code IDs must be unique within a version"));
	}
	if (
		(record.version === 1 && record.supersedesCodebookVersionId !== null) ||
		(record.version > 1 && record.supersedesCodebookVersionId === null)
	) {
		issues.push(
			issue(
				"supersedesCodebookVersionId",
				"codebook.version_chain_invalid",
				"codebook version 1 cannot supersede another version and later versions must do so",
			),
		);
	}
	return issues;
}

function modelSuggestionIssues(record: ModelSuggestion): ContractIssue[] {
	return new Set(record.suggestedCodeIds).size === record.suggestedCodeIds.length
		? []
		: [issue("suggestedCodeIds", "model_suggestion.duplicate_code", "suggested code IDs must be unique")];
}

function codingDecisionIssues(record: CodingDecision): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (
		(record.decision === "rejected" && record.assignedCodeIds.length > 0) ||
		(record.decision !== "rejected" && record.assignedCodeIds.length === 0) ||
		new Set(record.assignedCodeIds).size !== record.assignedCodeIds.length
	) {
		issues.push(
			issue(
				"assignedCodeIds",
				"coding_decision.assignment_invalid",
				"accepted or edited decisions require unique assigned codes; rejected decisions require none",
			),
		);
	}
	if (!Number.isFinite(Date.parse(record.decidedAt))) {
		issues.push(issue("decidedAt", "coding_decision.time_invalid", "coding decision time must be an ISO date-time"));
	}
	return issues;
}

function themeSynthesisIssues(record: ThemeSynthesis): ContractIssue[] {
	const issues = confirmationIssues(record);
	const themeIds = record.themes.map(({ themeId }) => themeId);
	if (new Set(themeIds).size !== themeIds.length) {
		issues.push(issue("themes", "theme_synthesis.duplicate_theme", "theme IDs must be unique"));
	}
	for (const [index, theme] of record.themes.entries()) {
		if (theme.negativeCaseSegmentIds.some((id) => !theme.qualitativeSegmentIds.includes(id))) {
			issues.push(
				issue(
					`themes[${index}].negativeCaseSegmentIds`,
					"theme_synthesis.negative_case_unlinked",
					"negative cases must also be listed among the theme's segments",
				),
			);
		}
	}
	return issues;
}

function taskIssues(record: ResearchTask): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (record.attemptCount > record.maxAttempts) {
		issues.push(issue("attemptCount", "task.attempt_limit_exceeded", "attempt count cannot exceed max attempts"));
	}
	if (["running", "awaiting_approval"].includes(record.status) && record.startedAt === null) {
		issues.push(issue("startedAt", "task.start_missing", "active task requires start timestamp"));
	}
	if (
		["succeeded", "partially_succeeded", "failed_retryable", "failed_permanent", "cancelled"].includes(
			record.status,
		) &&
		record.finishedAt === null
	) {
		issues.push(issue("finishedAt", "task.finish_missing", "completed attempt requires finish timestamp"));
	}
	if (record.status === "succeeded" && record.errors.length > 0) {
		issues.push(issue("errors", "task.success_with_errors", "successful task cannot contain errors"));
	}
	if (record.status === "partially_succeeded" && record.errors.length === 0) {
		issues.push(issue("errors", "task.partial_without_error", "partial success requires structured errors"));
	}
	if ((record.status === "failed_retryable" || record.status === "failed_permanent") && record.errors.length === 0) {
		issues.push(issue("errors", "task.failure_without_error", "failed task requires structured errors"));
	}
	return issues;
}

function operationIssues(record: OperationRecord): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (["running", "awaiting_approval"].includes(record.status) && record.startedAt === null) {
		issues.push(issue("startedAt", "operation.start_missing", "active operation requires start timestamp"));
	}
	if (
		["succeeded", "partially_succeeded", "failed_retryable", "failed_permanent", "blocked", "cancelled"].includes(
			record.status,
		) &&
		record.finishedAt === null
	) {
		issues.push(issue("finishedAt", "operation.finish_missing", "completed operation requires finish timestamp"));
	}
	if (record.operationKind === "model" && record.modelExecution === null) {
		issues.push(
			issue(
				"modelExecution",
				"operation.model_provenance_missing",
				"model operation requires model execution metadata",
			),
		);
	}
	if (record.operationKind === "adapter" && record.adapterExecution === null) {
		issues.push(
			issue(
				"adapterExecution",
				"operation.adapter_provenance_missing",
				"adapter operation requires adapter execution metadata",
			),
		);
	}
	if (record.status === "succeeded" || record.status === "partially_succeeded") {
		if (record.error !== null && record.status === "succeeded") {
			issues.push(issue("error", "operation.success_with_error", "successful operation cannot contain an error"));
		}
		if (
			record.outputs.some((output) => output.revision === null) ||
			record.outputFiles.some((output) => output.hash === null)
		) {
			issues.push(
				issue(
					"outputs",
					"operation.output_integrity_missing",
					"successful outputs require record revisions or file hashes",
				),
			);
		}
	}
	if ((record.status === "failed_retryable" || record.status === "failed_permanent") && record.error === null) {
		issues.push(issue("error", "operation.failure_without_error", "failed operation requires a structured error"));
	}
	return issues;
}

function analysisIssues(record: AnalysisRun): ContractIssue[] {
	const issues: ContractIssue[] = [];
	const terminal = ["succeeded", "failed", "aborted", "non_converged"].includes(record.status);
	if (terminal && (record.startedAt === null || record.finishedAt === null)) {
		issues.push(
			issue("finishedAt", "analysis.timestamps_missing", "terminal analysis requires start and finish times"),
		);
	}
	if (
		terminal &&
		(record.inputIntegrity.length !== record.inputs.length ||
			new Set(record.inputIntegrity.map(({ path }) => path)).size !== record.inputIntegrity.length)
	) {
		issues.push(
			issue("inputIntegrity", "analysis.input_check_incomplete", "each input requires one integrity check"),
		);
	}
	if (record.status === "succeeded") {
		if (record.exitCode !== 0 || record.startedAt === null || record.finishedAt === null || record.failure !== null) {
			issues.push(
				issue(
					"status",
					"analysis.success_metadata_invalid",
					"successful analysis requires timestamps, exit code 0, and no failure",
				),
			);
		}
		if (record.script.hash === null || record.inputs.some((input) => input.hash === null)) {
			issues.push(
				issue("inputs", "analysis.input_integrity_missing", "successful analysis requires script and input hashes"),
			);
		}
		if (record.outputs.some((output) => output.hash === null)) {
			issues.push(
				issue("outputs", "analysis.output_integrity_missing", "successful analysis outputs require hashes"),
			);
		}
		if (
			record.inputIntegrity.some(
				(check) => check.mutationDetected || !check.unchanged || check.before.value !== check.after.value,
			)
		) {
			issues.push(
				issue("inputIntegrity", "analysis.raw_input_changed", "successful analysis cannot alter a raw input"),
			);
		}
	}
	if (["failed", "aborted", "non_converged"].includes(record.status) && record.failure === null) {
		issues.push(
			issue("failure", "analysis.failure_missing", "failed, aborted, or non-converged analysis requires an error"),
		);
	}
	return issues;
}

function artifactIssues(record: ArtifactRecord): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (!completeFile(record.outputFile)) {
		issues.push(
			issue("outputFile", "artifact.output_incomplete", "artifact output requires hash, media type, and byte size"),
		);
	}
	if (record.publishability === "submission_candidate" && record.validation.status !== "passed") {
		issues.push(
			issue(
				"validation.status",
				"artifact.submission_gate_failed",
				"submission candidate requires passed validation",
			),
		);
	}
	return issues;
}

function approvalIssues(record: ApprovalRecord): ContractIssue[] {
	const issues: ContractIssue[] = [];
	if (record.decidedAt === null || record.decidedBy === null) {
		issues.push(
			issue(
				"decidedAt",
				"approval.decision_metadata_missing",
				"canonical approval requires decision timestamp and actor",
			),
		);
	}
	if (record.decision === "approved" && record.scope === "once" && record.operationId === null) {
		issues.push(issue("operationId", "approval.once_without_operation", "once approval requires operation ID"));
	}
	if (record.decision === "approved" && record.scope === "session" && record.scopeTarget.sessionId === null) {
		issues.push(
			issue("scopeTarget.sessionId", "approval.session_without_session", "session approval requires session ID"),
		);
	}
	return issues;
}

function invariantIssues(record: PersistedRecord): ContractIssue[] {
	switch (record.kind) {
		case "research_project_manifest":
			return manifestIssues(record);
		case "source":
			return sourceIssues(record);
		case "document":
			return documentIssues(record);
		case "evidence":
			return evidenceIssues(record);
		case "claim":
			return claimIssues(record);
		case "citation_verification":
			return citationIssues(record);
		case "research_question_version":
			return researchQuestionVersionIssues(record);
		case "concept":
			return designReviewIssues(record);
		case "theory_relation":
			return theoryRelationIssues(record);
		case "design_decision":
			return designDecisionIssues(record);
		case "protocol":
			return protocolIssues(record);
		case "dataset":
			return datasetIssues(record);
		case "variable":
			return [];
		case "analysis_specification":
			return analysisSpecificationIssues(record);
		case "qualitative_material":
			return qualitativeMaterialIssues(record);
		case "qualitative_segment":
			return qualitativeSegmentIssues(record);
		case "codebook_version":
			return codebookIssues(record);
		case "model_suggestion":
			return modelSuggestionIssues(record);
		case "coding_decision":
			return codingDecisionIssues(record);
		case "theme_synthesis":
			return themeSynthesisIssues(record);
		case "task":
			return taskIssues(record);
		case "operation":
			return operationIssues(record);
		case "analysis_run":
			return analysisIssues(record);
		case "artifact":
			return artifactIssues(record);
		case "approval":
			return approvalIssues(record);
	}
}

function validateWith<T>(
	value: unknown,
	validator: typeof persistedRecordValidator | typeof resultValidator,
): ContractValidation<T> {
	try {
		canonicalizeJson(value);
	} catch (error) {
		return {
			ok: false,
			value: null,
			issues: [issue("$root", "json.non_canonical_value", error instanceof Error ? error.message : String(error))],
		};
	}

	const schemaIssues = validator
		.Errors(value)
		.map((error) => issue(error.instancePath || "$root", `schema.${error.keyword}`, error.message));
	if (schemaIssues.length > 0)
		return { ok: false, value: null, issues: schemaIssues as [ContractIssue, ...ContractIssue[]] };
	return { ok: true, value: value as T, issues: [] };
}

export function validatePersistedRecord(value: unknown): ContractValidation<PersistedRecord> {
	const schemaResult = validateWith<PersistedRecord>(value, persistedRecordValidator);
	if (!schemaResult.ok) return schemaResult;
	const issues = invariantIssues(schemaResult.value);
	return issues.length === 0
		? schemaResult
		: { ok: false, value: null, issues: issues as [ContractIssue, ...ContractIssue[]] };
}

export function validateJsonResearchResult(value: unknown): ContractValidation<JsonResearchResult> {
	return validateWith<JsonResearchResult>(value, resultValidator);
}
