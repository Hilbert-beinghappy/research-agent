// SPDX-License-Identifier: Apache-2.0

import type {
	ClaimRecord,
	DocumentRecord,
	EvidenceCard,
	FileRef,
	HashValue,
	OperationRecord,
	ResearchResult,
	SourceRecord,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds, projectRecordRevision } from "../project/record-index.ts";
import { readRecord, updateRecord } from "../project/records.ts";
import { readParsedPdfDocument, resolveParsedPdfLocator } from "./query.ts";

export type EvidenceCardDraft = Omit<EvidenceCard, "kind" | "schemaVersion" | "evidenceId" | "validity" | "audit">;

export interface ValidatedEvidenceCard {
	card: EvidenceCard;
	superseded: EvidenceCard | null;
}

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
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
				"EVIDENCE_SOURCE_INVALID",
				"integrity",
				`Record ${sourceId} is not a source`,
				operationId,
			);
}

async function documentRecord(
	projectRoot: string,
	documentId: string,
	operationId: string,
): Promise<ResearchResult<DocumentRecord>> {
	const result = await readRecord(projectRoot, "document", documentId);
	if (!result.ok) return propagatedFailure(result, operationId);
	return result.value.kind === "document"
		? successResult(result.value, operationId)
		: failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_DOCUMENT_INVALID",
				"integrity",
				`Record ${documentId} is not a document`,
				operationId,
			);
}

async function operationRecord(
	projectRoot: string,
	operationId: string,
	requestOperationId: string,
): Promise<ResearchResult<OperationRecord>> {
	const result = await readRecord(projectRoot, "operation", operationId);
	if (!result.ok) return propagatedFailure(result, requestOperationId);
	if (result.value.kind !== "operation") {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_EXTRACTION_OPERATION_INVALID",
			"integrity",
			`Record ${operationId} is not an operation`,
			requestOperationId,
		);
	}
	if (!["running", "succeeded", "partially_succeeded"].includes(result.value.status)) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_EXTRACTION_NOT_EXECUTED",
			"validation",
			"Evidence extraction operation has not executed successfully",
			requestOperationId,
		);
	}
	return successResult(result.value, requestOperationId);
}

function hasInput(operation: OperationRecord, kind: "source" | "document", id: string, revision: number): boolean {
	return operation.inputs.some((input) => input.kind === kind && input.id === id && input.revision === revision);
}

function fileMatches(left: FileRef, right: FileRef): boolean {
	return (
		left.path === right.path &&
		left.hash?.value === right.hash?.value &&
		left.mediaType === right.mediaType &&
		left.bytes === right.bytes
	);
}

function hasInputFile(operation: OperationRecord, file: FileRef): boolean {
	return operation.inputFiles.some((input) => fileMatches(input, file));
}

function normalizedExactText(value: string): string {
	return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function storedWordCount(value: string): number {
	return value.match(/\p{Script=Han}|[\p{L}\p{N}]+/gu)?.length ?? 0;
}

async function claimsForLinks(
	projectRoot: string,
	draft: EvidenceCardDraft,
	operationId: string,
): Promise<ResearchResult<ClaimRecord[]>> {
	if (new Set(draft.claimLinks.map(({ claimId }) => claimId)).size !== draft.claimLinks.length) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_CLAIM_LINK_DUPLICATE",
			"validation",
			"Evidence card contains duplicate claim links",
			operationId,
		);
	}
	const claims: ClaimRecord[] = [];
	for (const link of draft.claimLinks) {
		const result = await readRecord(projectRoot, "claim", link.claimId);
		if (!result.ok) return propagatedFailure(result, operationId);
		if (result.value.kind !== "claim") {
			return failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_CLAIM_INVALID",
				"integrity",
				`Record ${link.claimId} is not a claim`,
				operationId,
			);
		}
		claims.push(result.value);
	}
	return successResult(claims, operationId);
}

function extractionIssue(draft: EvidenceCardDraft, operation: OperationRecord): string | null {
	const extraction = draft.extraction;
	if (extraction.method === "model_suggested") {
		return operation.operationKind !== "model" ||
			operation.modelExecution === null ||
			operation.modelExecution.provider !== extraction.modelProvider ||
			operation.modelExecution.modelId !== extraction.modelId ||
			operation.modelExecution.promptHash.value !== extraction.promptHash?.value
			? "Model extraction provenance does not match its OperationRecord"
			: null;
	}
	if (extraction.modelProvider !== null || extraction.modelId !== null || extraction.promptHash !== null) {
		return "Non-model evidence cannot declare model provenance";
	}
	if (extraction.method === "deterministic" && operation.operationKind !== "tool") {
		return "Deterministic evidence requires a tool operation";
	}
	if (extraction.method === "human_entered" && operation.operationKind !== "human") {
		return "Human-entered evidence requires a human operation";
	}
	if (
		extraction.method === "imported" &&
		operation.operationKind !== "adapter" &&
		operation.operationKind !== "tool"
	) {
		return "Imported evidence requires an adapter or tool operation";
	}
	return null;
}

async function supersededEvidence(
	projectRoot: string,
	evidenceId: string | null,
	sourceId: string,
	operationId: string,
): Promise<ResearchResult<EvidenceCard | null>> {
	if (evidenceId === null) return successResult(null, operationId);
	const result = await readRecord(projectRoot, "evidence", evidenceId);
	if (!result.ok) return propagatedFailure(result, operationId);
	if (result.value.kind !== "evidence" || result.value.sourceId !== sourceId || result.value.validity !== "active") {
		return failureResult(
			"DATA_CONFLICT",
			"EVIDENCE_SUPERSESSION_INVALID",
			"data_conflict",
			"Superseded evidence must be an active card for the same source",
			operationId,
		);
	}
	return successResult(result.value, operationId);
}

export async function validateEvidenceCardDraft(
	projectRoot: string,
	draft: EvidenceCardDraft,
	commitOperationId: string,
): Promise<ResearchResult<ValidatedEvidenceCard>> {
	const source = await sourceRecord(projectRoot, draft.sourceId, commitOperationId);
	if (!source.ok) return source;
	const claims = await claimsForLinks(projectRoot, draft, commitOperationId);
	if (!claims.ok) return claims;
	const extraction = await operationRecord(projectRoot, draft.extraction.operationId, commitOperationId);
	if (!extraction.ok) return extraction;
	const provenanceIssue = extractionIssue(draft, extraction.value);
	if (provenanceIssue !== null) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_EXTRACTION_PROVENANCE_INVALID",
			"validation",
			provenanceIssue,
			commitOperationId,
		);
	}
	if (!hasInput(extraction.value, "source", source.value.sourceId, projectRecordRevision(source.value))) {
		return failureResult(
			"DATA_CONFLICT",
			"EVIDENCE_SOURCE_SNAPSHOT_MISSING",
			"integrity",
			"Extraction operation does not reference the current SourceRecord revision",
			commitOperationId,
		);
	}

	let document: DocumentRecord | null = null;
	let exactTarget: string | null = null;
	let targetRequiresEquality = false;
	let inheritedWarnings: string[] = [];
	if (draft.evidenceLevel === "metadata" || draft.evidenceLevel === "abstract") {
		if (draft.documentId !== null || draft.locator !== null) {
			return failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_LEVEL_DOCUMENT_MISMATCH",
				"validation",
				"Metadata and abstract evidence cannot carry a document locator",
				commitOperationId,
			);
		}
		exactTarget = draft.evidenceLevel === "metadata" ? source.value.title : source.value.abstractText;
		if (exactTarget === null) {
			return failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_ABSTRACT_MISSING",
				"validation",
				"Abstract evidence requires abstract text in the SourceRecord",
				commitOperationId,
			);
		}
	} else {
		if (draft.documentId === null) {
			return failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_DOCUMENT_REQUIRED",
				"validation",
				"Full-text evidence requires a DocumentRecord",
				commitOperationId,
			);
		}
		const result = await documentRecord(projectRoot, draft.documentId, commitOperationId);
		if (!result.ok) return result;
		document = result.value;
		inheritedWarnings = [...document.warnings];
		if (document.sourceId !== source.value.sourceId) {
			return failureResult(
				"DATA_CONFLICT",
				"EVIDENCE_DOCUMENT_SOURCE_MISMATCH",
				"data_conflict",
				"Evidence source and document source do not match",
				commitOperationId,
			);
		}
		if (!hasInput(extraction.value, "document", document.documentId, projectRecordRevision(document))) {
			return failureResult(
				"DATA_CONFLICT",
				"EVIDENCE_DOCUMENT_SNAPSHOT_MISSING",
				"integrity",
				"Extraction operation does not reference the current DocumentRecord revision",
				commitOperationId,
			);
		}
		if (draft.evidenceLevel === "fulltext_unlocated") {
			if (draft.locator !== null || draft.excerpt !== null || draft.excerptExactMatch !== null) {
				return failureResult(
					"PERMANENT_FAILURE",
					"EVIDENCE_UNLOCATED_EXCERPT_INVALID",
					"validation",
					"Unlocated full text can only store a paraphrase without an excerpt or locator",
					commitOperationId,
				);
			}
			if (document.localFile === null || !hasInputFile(extraction.value, document.localFile)) {
				return failureResult(
					"DATA_CONFLICT",
					"EVIDENCE_DOCUMENT_FILE_SNAPSHOT_MISSING",
					"integrity",
					"Extraction operation does not reference the current document file",
					commitOperationId,
				);
			}
		} else if (draft.evidenceLevel === "fulltext_located") {
			if (draft.locator === null) {
				return failureResult(
					"PERMANENT_FAILURE",
					"EVIDENCE_LOCATOR_REQUIRED",
					"validation",
					"Located full text requires a stable locator",
					commitOperationId,
				);
			}
			if (document.parsedOutput === null || !hasInputFile(extraction.value, document.parsedOutput)) {
				return failureResult(
					"DATA_CONFLICT",
					"EVIDENCE_PARSED_SNAPSHOT_MISSING",
					"integrity",
					"Extraction operation does not reference the current parsed PDF output",
					commitOperationId,
				);
			}
			const parsed = await readParsedPdfDocument(projectRoot, document, commitOperationId);
			if (!parsed.ok) return parsed;
			const located = resolveParsedPdfLocator(parsed.value, draft.locator, commitOperationId);
			if (!located.ok) {
				return located;
			}
			exactTarget = located.value.text;
			targetRequiresEquality = true;
		} else {
			return failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_LEVEL_UNSUPPORTED",
				"validation",
				"Table, figure, dataset, and appendix evidence require a parser that emits those locators",
				commitOperationId,
			);
		}
	}

	if (
		draft.evidenceLevel === "metadata" &&
		claims.value.some(
			(claim, index) => claim.claimType !== "bibliographic" && draft.claimLinks[index]?.relation !== "context_only",
		)
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_METADATA_CLAIM_INVALID",
			"validation",
			"Metadata can only support bibliographic claims; other links must be context-only",
			commitOperationId,
		);
	}
	if (draft.excerpt === null) {
		if (draft.excerptExactMatch !== null) {
			return failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_EXACT_STATUS_INVALID",
				"validation",
				"Evidence without a stored excerpt must use a null exact-match status",
				commitOperationId,
			);
		}
	} else {
		if (draft.excerptExactMatch !== true || exactTarget === null) {
			return failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_EXCERPT_UNVERIFIED",
				"validation",
				"Stored excerpts require a deterministic exact-match target",
				commitOperationId,
			);
		}
		if (draft.rights.excerptAllowed !== true) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"EVIDENCE_EXCERPT_RIGHTS_BLOCKED",
				"permission",
				"Excerpt storage is not explicitly allowed",
				commitOperationId,
			);
		}
		if (draft.evidenceLevel === "abstract" && source.value.abstractRights !== "display_allowed") {
			return failureResult(
				"PERMISSION_BLOCKED",
				"EVIDENCE_ABSTRACT_RIGHTS_BLOCKED",
				"permission",
				"SourceRecord rights do not allow storing an abstract excerpt",
				commitOperationId,
			);
		}
		const target = normalizedExactText(exactTarget);
		const excerpt = normalizedExactText(draft.excerpt);
		if ((targetRequiresEquality && target !== excerpt) || (!targetRequiresEquality && !target.includes(excerpt))) {
			return failureResult(
				"DATA_CONFLICT",
				"EVIDENCE_EXCERPT_MISMATCH",
				"integrity",
				"Stored excerpt does not exactly match the declared source material",
				commitOperationId,
			);
		}
		if (draft.rights.maxStoredWords !== null && storedWordCount(draft.excerpt) > draft.rights.maxStoredWords) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"EVIDENCE_EXCERPT_WORD_LIMIT",
				"permission",
				"Stored excerpt exceeds its rights limit",
				commitOperationId,
			);
		}
	}
	const superseded = await supersededEvidence(
		projectRoot,
		draft.supersedesEvidenceId,
		draft.sourceId,
		commitOperationId,
	);
	if (!superseded.ok) return superseded;
	const now = new Date().toISOString();
	const card: EvidenceCard = {
		...draft,
		kind: "evidence",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		evidenceId: createOpaqueId("evidence"),
		confidence: {
			...draft.confidence,
			limitations: [...new Set([...draft.confidence.limitations, ...inheritedWarnings])],
		},
		validity: "active",
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: commitOperationId,
			updatedByOperationId: commitOperationId,
		},
	};
	return successResult({ card, superseded: superseded.value }, commitOperationId);
}

export function evidenceFingerprint(card: EvidenceCard): HashValue {
	return hashCanonicalJson({
		sourceId: card.sourceId,
		documentId: card.documentId,
		evidenceLevel: card.evidenceLevel,
		locator: card.locator,
		representation: {
			excerpt: card.excerpt,
			paraphrase: card.paraphrase,
			evidenceStatement: card.evidenceStatement,
		},
		claimLinks: [...card.claimLinks].sort((left, right) => {
			const leftKey = `${left.claimId}:${left.relation}:${left.rationale}`;
			const rightKey = `${right.claimId}:${right.relation}:${right.rationale}`;
			return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
		}),
		supersedesEvidenceId: card.supersedesEvidenceId,
	});
}

function currentEvidenceInput(document: DocumentRecord, evidence: EvidenceCard): FileRef | null {
	return evidence.evidenceLevel === "fulltext_unlocated" ? document.localFile : document.parsedOutput;
}

async function invalidateStaleEvidenceForDocumentUnchecked(
	projectRoot: string,
	document: DocumentRecord,
	operationId: string,
): Promise<ResearchResult<number>> {
	let invalidated = 0;
	const initial = await openProject(projectRoot);
	if (initial.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	for (const evidenceId of await listProjectRecordIds(projectRoot, initial.manifest, "evidence")) {
		const result = await readRecord(projectRoot, "evidence", evidenceId);
		if (!result.ok) return propagatedFailure(result, operationId);
		if (
			result.value.kind !== "evidence" ||
			result.value.documentId !== document.documentId ||
			result.value.validity !== "active"
		) {
			continue;
		}
		const extraction = await readRecord(projectRoot, "operation", result.value.extraction.operationId);
		const currentInput = currentEvidenceInput(document, result.value);
		if (
			extraction.ok &&
			extraction.value.kind === "operation" &&
			currentInput !== null &&
			hasInputFile(extraction.value, currentInput)
		) {
			continue;
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
		const update = await updateRecord(projectRoot, "evidence", evidenceId, {
			expectedManifestRevision: opened.manifest.revision,
			expectedRecordRevision: result.value.audit.revision,
			operationId,
			changes: { validity: "invalidated" },
		});
		if (!update.ok) return propagatedFailure(update, operationId);
		invalidated += 1;
	}
	return successResult(invalidated, operationId);
}

export async function invalidateStaleEvidenceForDocument(
	projectRoot: string,
	document: DocumentRecord,
	operationId: string,
): Promise<ResearchResult<number>> {
	try {
		return await invalidateStaleEvidenceForDocumentUnchecked(projectRoot, document, operationId);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_INVALIDATION_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Stale evidence could not be invalidated",
			operationId,
		);
	}
}
