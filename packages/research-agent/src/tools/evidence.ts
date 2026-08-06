// SPDX-License-Identifier: Apache-2.0

import type { ClaimRecord, EvidenceCard, OperationRecord, ResearchResult } from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { type EvidenceCardDraft, evidenceFingerprint, validateEvidenceCardDraft } from "../evidence/commit.ts";
import { type CorpusQueryInput, type CorpusQueryPage, queryCorpusRecords } from "../evidence/query.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { type OpenedProject, openProject } from "../project/open.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { createRecord, createRecordWithUpdate, readRecord, updateRecord } from "../project/records.ts";

export interface QueryCorpusRequest extends CorpusQueryInput {
	operationId: string;
}

export interface CommitEvidenceCardRequest {
	operationId: string;
	expectedManifestRevision: number;
	validationMode: "strict";
	draft: EvidenceCardDraft;
}

export interface InvalidateEvidenceCardRequest {
	operationId: string;
	expectedManifestRevision: number;
	evidenceId: string;
	expectedEvidenceRevision: number;
}

export type ClaimDraft = Pick<ClaimRecord, "text" | "claimType" | "scope" | "evidenceLinks" | "conflictEvidenceIds">;

export interface CommitClaimRequest {
	operationId: string;
	expectedManifestRevision: number;
	draft: ClaimDraft;
}

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

async function runningOperation(projectRoot: string, operationId: string): Promise<ResearchResult<OperationRecord>> {
	const result = await readRecord(projectRoot, "operation", operationId);
	if (!result.ok) return propagatedFailure(result, operationId);
	if (result.value.kind !== "operation" || result.value.status !== "running") {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_OPERATION_NOT_RUNNING",
			"validation",
			`Operation ${operationId} is not persisted as running`,
			operationId,
		);
	}
	return successResult(result.value, operationId);
}

async function currentProject(
	projectRoot: string,
	expectedRevision: number,
	operationId: string,
): Promise<ResearchResult<Extract<OpenedProject, { compatibility: "current" }>>> {
	try {
		const opened = await openProject(projectRoot, expectedRevision);
		return opened.compatibility === "current"
			? successResult(opened, operationId)
			: failureResult(
					"PERMANENT_FAILURE",
					"EVIDENCE_PROJECT_READ_ONLY",
					"migration",
					"Research project schema is read-only",
					operationId,
				);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Research project could not be opened";
		return failureResult(
			message.startsWith("DATA_CONFLICT:") ? "DATA_CONFLICT" : "PERMANENT_FAILURE",
			message.startsWith("DATA_CONFLICT:") ? "EVIDENCE_REVISION_CONFLICT" : "EVIDENCE_PROJECT_OPEN_FAILED",
			message.startsWith("DATA_CONFLICT:") ? "data_conflict" : "runtime",
			message,
			operationId,
		);
	}
}

export async function queryCorpus(
	projectRoot: string,
	request: QueryCorpusRequest,
): Promise<ResearchResult<CorpusQueryPage>> {
	const operation = await runningOperation(projectRoot, request.operationId);
	if (!operation.ok) return operation;
	return queryCorpusRecords(projectRoot, request, request.operationId);
}

export async function findActiveEvidenceCardByFingerprint(
	projectRoot: string,
	fingerprint: string,
	operationId: string,
): Promise<ResearchResult<EvidenceCard | null>> {
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
	for (const evidenceId of await listProjectRecordIds(opened.root, opened.manifest, "evidence")) {
		const existing = await readRecord(projectRoot, "evidence", evidenceId);
		if (!existing.ok) return propagatedFailure(existing, operationId);
		if (
			existing.value.kind === "evidence" &&
			existing.value.validity === "active" &&
			evidenceFingerprint(existing.value).value === fingerprint
		) {
			return successResult(existing.value, operationId);
		}
	}
	return successResult(null, operationId);
}

export async function commitEvidenceCard(
	projectRoot: string,
	request: CommitEvidenceCardRequest,
): Promise<ResearchResult<EvidenceCard>> {
	const operation = await runningOperation(projectRoot, request.operationId);
	if (!operation.ok) return operation;
	if (request.validationMode !== "strict") {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_VALIDATION_MODE_UNSUPPORTED",
			"validation",
			"Evidence cards can only be committed with strict validation",
			request.operationId,
		);
	}
	const opened = await currentProject(projectRoot, request.expectedManifestRevision, request.operationId);
	if (!opened.ok) return opened;
	const validated = await validateEvidenceCardDraft(projectRoot, request.draft, request.operationId);
	if (!validated.ok) return validated;
	const fingerprint = evidenceFingerprint(validated.value.card).value;
	const existing = await findActiveEvidenceCardByFingerprint(projectRoot, fingerprint, request.operationId);
	if (!existing.ok) return existing;
	if (existing.value !== null) return successResult(existing.value, request.operationId);
	const created =
		validated.value.superseded === null
			? await createRecord(projectRoot, validated.value.card, {
					expectedManifestRevision: request.expectedManifestRevision,
					operationId: request.operationId,
				})
			: await createRecordWithUpdate(
					projectRoot,
					validated.value.card,
					{
						kind: "evidence",
						id: validated.value.superseded.evidenceId,
						expectedRecordRevision: validated.value.superseded.audit.revision,
						changes: { validity: "superseded" },
					},
					{
						expectedManifestRevision: request.expectedManifestRevision,
						operationId: request.operationId,
					},
				);
	if (!created.ok) return propagatedFailure(created, request.operationId);
	const result = await readRecord(projectRoot, "evidence", validated.value.card.evidenceId);
	if (!result.ok) return propagatedFailure(result, request.operationId);
	return result.value.kind === "evidence"
		? successResult(result.value, request.operationId)
		: failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_COMMIT_READBACK_INVALID",
				"integrity",
				"Committed evidence could not be read back",
				request.operationId,
			);
}

export function deriveClaimSupportStatus(evidenceLinks: ClaimRecord["evidenceLinks"]): ClaimRecord["supportStatus"] {
	const relations = new Set(evidenceLinks.map(({ relation }) => relation));
	if (relations.size === 0) return "unsupported";
	if (relations.has("supports") && relations.has("refutes")) return "mixed";
	if (relations.has("refutes")) return "contradicted";
	if (relations.has("supports") && relations.has("qualifies")) return "partially_supported";
	if (relations.has("supports")) return "supported";
	if (relations.has("qualifies")) return "partially_supported";
	return "unassessed";
}

function claimFingerprint(
	claim: Pick<ClaimRecord, "text" | "claimType" | "scope" | "evidenceLinks" | "conflictEvidenceIds">,
) {
	return hashCanonicalJson({
		text: claim.text.normalize("NFKC").replace(/\s+/gu, " ").trim(),
		claimType: claim.claimType,
		scope: claim.scope.normalize("NFKC").replace(/\s+/gu, " ").trim(),
		evidenceLinks: [...claim.evidenceLinks].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
		conflictEvidenceIds: [...claim.conflictEvidenceIds].sort(),
	});
}

export async function commitClaim(
	projectRoot: string,
	request: CommitClaimRequest,
): Promise<ResearchResult<ClaimRecord>> {
	const operation = await runningOperation(projectRoot, request.operationId);
	if (!operation.ok) return operation;
	const opened = await currentProject(projectRoot, request.expectedManifestRevision, request.operationId);
	if (!opened.ok) return opened;
	if (request.draft.text.trim().length === 0 || request.draft.scope.trim().length === 0) {
		return failureResult(
			"PERMANENT_FAILURE",
			"CLAIM_TEXT_REQUIRED",
			"validation",
			"Claim text and scope must not be empty",
			request.operationId,
		);
	}
	const linkedEvidenceIds = request.draft.evidenceLinks.map(({ evidenceId }) => evidenceId);
	if (
		new Set(linkedEvidenceIds).size !== linkedEvidenceIds.length ||
		new Set(request.draft.conflictEvidenceIds).size !== request.draft.conflictEvidenceIds.length
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"CLAIM_EVIDENCE_DUPLICATE",
			"validation",
			"Claim evidence references must be unique",
			request.operationId,
		);
	}
	for (const evidenceId of new Set([...linkedEvidenceIds, ...request.draft.conflictEvidenceIds])) {
		const evidence = await readRecord(projectRoot, "evidence", evidenceId);
		if (!evidence.ok) return propagatedFailure(evidence, request.operationId);
		if (evidence.value.kind !== "evidence" || evidence.value.validity !== "active") {
			return failureResult(
				"DATA_CONFLICT",
				"CLAIM_EVIDENCE_INVALID",
				"data_conflict",
				`Claim evidence ${evidenceId} is not active`,
				request.operationId,
			);
		}
	}
	const fingerprint = claimFingerprint(request.draft).value;
	// ponytail: O(n) claim scan; add a derived fingerprint index only after project benchmarks require it.
	for (const claimId of await listProjectRecordIds(opened.value.root, opened.value.manifest, "claim")) {
		const existing = await readRecord(projectRoot, "claim", claimId);
		if (!existing.ok) return propagatedFailure(existing, request.operationId);
		if (existing.value.kind === "claim" && claimFingerprint(existing.value).value === fingerprint) {
			return successResult(existing.value, request.operationId);
		}
	}
	const now = new Date().toISOString();
	const supportStatus = deriveClaimSupportStatus(request.draft.evidenceLinks);
	const claim: ClaimRecord = {
		kind: "claim",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		claimId: createOpaqueId("claim"),
		text: request.draft.text.trim(),
		claimType: request.draft.claimType,
		scope: request.draft.scope.trim(),
		evidenceLinks: request.draft.evidenceLinks,
		supportStatus,
		conflictEvidenceIds: request.draft.conflictEvidenceIds,
		humanConfirmation: { status: "not_reviewed", decidedAt: null, note: null },
		publishability: supportStatus === "unassessed" || supportStatus === "unsupported" ? "blocked" : "exploratory",
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: request.operationId,
			updatedByOperationId: request.operationId,
		},
	};
	const created = await createRecord(projectRoot, claim, {
		expectedManifestRevision: request.expectedManifestRevision,
		operationId: request.operationId,
	});
	if (!created.ok) return propagatedFailure(created, request.operationId);
	const stored = await readRecord(projectRoot, "claim", claim.claimId);
	if (!stored.ok) return propagatedFailure(stored, request.operationId);
	return stored.value.kind === "claim"
		? successResult(stored.value, request.operationId)
		: failureResult(
				"PERMANENT_FAILURE",
				"CLAIM_COMMIT_READBACK_INVALID",
				"integrity",
				"Committed claim could not be read back",
				request.operationId,
			);
}

export async function invalidateEvidenceCard(
	projectRoot: string,
	request: InvalidateEvidenceCardRequest,
): Promise<ResearchResult<EvidenceCard>> {
	const operation = await runningOperation(projectRoot, request.operationId);
	if (!operation.ok) return operation;
	const opened = await currentProject(projectRoot, request.expectedManifestRevision, request.operationId);
	if (!opened.ok) return opened;
	const current = await readRecord(projectRoot, "evidence", request.evidenceId);
	if (!current.ok) return propagatedFailure(current, request.operationId);
	if (current.value.kind !== "evidence") {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_RECORD_INVALID",
			"integrity",
			`Record ${request.evidenceId} is not evidence`,
			request.operationId,
		);
	}
	if (current.value.audit.revision !== request.expectedEvidenceRevision) {
		return failureResult(
			"DATA_CONFLICT",
			"EVIDENCE_REVISION_CONFLICT",
			"data_conflict",
			`Expected evidence revision ${request.expectedEvidenceRevision}, found ${current.value.audit.revision}`,
			request.operationId,
		);
	}
	if (current.value.validity === "invalidated") return successResult(current.value, request.operationId);
	if (current.value.validity !== "active") {
		return failureResult(
			"DATA_CONFLICT",
			"EVIDENCE_VALIDITY_CONFLICT",
			"data_conflict",
			"Only active evidence can be invalidated",
			request.operationId,
		);
	}
	if (current.value.humanStatus !== "not_reviewed") {
		return failureResult(
			"PERMISSION_BLOCKED",
			"EVIDENCE_HUMAN_REVIEW_PROTECTED",
			"permission",
			"Human-reviewed evidence must be replaced with an explicit superseding card",
			request.operationId,
		);
	}
	const updated = await updateRecord(projectRoot, "evidence", request.evidenceId, {
		expectedManifestRevision: request.expectedManifestRevision,
		expectedRecordRevision: request.expectedEvidenceRevision,
		operationId: request.operationId,
		changes: { validity: "invalidated" },
	});
	if (!updated.ok) return propagatedFailure(updated, request.operationId);
	const result = await readRecord(projectRoot, "evidence", request.evidenceId);
	if (!result.ok) return propagatedFailure(result, request.operationId);
	return result.value.kind === "evidence"
		? successResult(result.value, request.operationId)
		: failureResult(
				"PERMANENT_FAILURE",
				"EVIDENCE_INVALIDATION_READBACK_INVALID",
				"integrity",
				"Invalidated evidence could not be read back",
				request.operationId,
			);
}
