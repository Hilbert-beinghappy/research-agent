// SPDX-License-Identifier: Apache-2.0

import { Compile } from "typebox/compile";
import { canonicalizeJson } from "./canonical-json.ts";
import {
	type AnalysisRun,
	type ApprovalRecord,
	type ArtifactRecord,
	type CitationVerification,
	type ClaimRecord,
	type DocumentRecord,
	type EvidenceCard,
	type FileRef,
	type JsonResearchResult,
	JsonResearchResultSchema,
	type OperationRecord,
	type PersistedRecord,
	PersistedRecordSchema,
	type ResearchProjectManifest,
	type ResearchTask,
	type SourceRecord,
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
	}
	if ((record.status === "failed" || record.status === "non_converged") && record.failure === null) {
		issues.push(
			issue("failure", "analysis.failure_missing", "failed or non-converged analysis requires a structured error"),
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
