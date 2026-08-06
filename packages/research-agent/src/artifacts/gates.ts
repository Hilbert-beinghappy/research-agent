// SPDX-License-Identifier: Apache-2.0

import type {
	ArtifactRecord,
	CitationVerification,
	ClaimRecord,
	EvidenceCard,
	FileRef,
	OperationRecord,
	Publishability,
	RecordRef,
	SourceRecord,
} from "../contracts/schemas.ts";
import type { ProjectRecord } from "../project/record-index.ts";
import { projectRecordRevision } from "../project/record-index.ts";
import { readRecord } from "../project/records.ts";
import type { ResearchArtifactType } from "./render.ts";

export type ArtifactValidation = ArtifactRecord["validation"];
export type ArtifactValidationCheck = ArtifactValidation["checks"][number];

export interface ArtifactGateInput {
	projectRoot: string;
	artifactType: ResearchArtifactType;
	targetStatus: Publishability;
	records: readonly ProjectRecord[];
	selectedClaimIds: ReadonlySet<string>;
	allProjectClaimIds: readonly string[];
	warningsAccepted: boolean;
}

function recordRef(record: ProjectRecord): RecordRef {
	switch (record.kind) {
		case "source":
			return { kind: "source", id: record.sourceId, revision: record.audit.revision };
		case "document":
			return { kind: "document", id: record.documentId, revision: record.audit.revision };
		case "evidence":
			return { kind: "evidence", id: record.evidenceId, revision: record.audit.revision };
		case "claim":
			return { kind: "claim", id: record.claimId, revision: record.audit.revision };
		case "citation_verification":
			return { kind: "citation_verification", id: record.verificationId, revision: record.audit.revision };
		case "research_question_version":
			return {
				kind: "research_question_version",
				id: record.researchQuestionVersionId,
				revision: record.audit.revision,
			};
		case "concept":
			return { kind: "concept", id: record.conceptId, revision: record.audit.revision };
		case "theory_relation":
			return { kind: "theory_relation", id: record.theoryRelationId, revision: record.audit.revision };
		case "design_decision":
			return { kind: "design_decision", id: record.designDecisionId, revision: record.audit.revision };
		case "protocol":
			return { kind: "protocol", id: record.protocolId, revision: record.audit.revision };
		case "task":
			return { kind: "task", id: record.taskId, revision: record.revision };
		case "operation":
			return { kind: "operation", id: record.operationId, revision: record.audit.revision };
		case "analysis_run":
			return { kind: "analysis_run", id: record.analysisRunId, revision: record.audit.revision };
		case "artifact":
			return { kind: "artifact", id: record.artifactId, revision: record.audit.revision };
		case "approval":
			return { kind: "approval", id: record.approvalId, revision: record.audit.revision };
	}
}

function check(
	name: string,
	status: ArtifactValidationCheck["status"],
	message: string,
	records: readonly ProjectRecord[],
): ArtifactValidationCheck {
	return { name, status, message, recordRefs: records.map(recordRef) };
}

function locatedEvidence(evidence: EvidenceCard | undefined): evidence is EvidenceCard {
	return (
		evidence !== undefined &&
		evidence.validity === "active" &&
		evidence.locator !== null &&
		["fulltext_located", "table_or_figure_located", "dataset_or_appendix_located"].includes(evidence.evidenceLevel) &&
		(evidence.excerpt === null || evidence.excerptExactMatch === true)
	);
}

async function currentCitation(
	projectRoot: string,
	source: SourceRecord,
	candidates: readonly CitationVerification[],
): Promise<CitationVerification | null> {
	const current: CitationVerification[] = [];
	for (const citation of candidates) {
		if (
			citation.sourceId !== source.sourceId ||
			(citation.expiresAt !== null && Date.parse(citation.expiresAt) <= Date.now())
		) {
			continue;
		}
		const creator = await readRecord(projectRoot, "operation", citation.audit.createdByOperationId);
		if (
			creator.ok &&
			creator.value.kind === "operation" &&
			creator.value.inputs.some(
				(input) =>
					input.kind === "source" && input.id === source.sourceId && input.revision === source.audit.revision,
			)
		) {
			current.push(citation);
		}
	}
	return (
		current.sort(
			(left, right) =>
				Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt) ||
				right.verificationId.localeCompare(left.verificationId),
		)[0] ?? null
	);
}

function claimSupportCheck(claim: ClaimRecord): ArtifactValidationCheck {
	if (claim.supportStatus === "supported" || claim.supportStatus === "partially_supported") {
		return check("claim_support", "passed", `Claim ${claim.claimId} has assessed support`, [claim]);
	}
	if (claim.supportStatus === "mixed") {
		return check("claim_support", "warning", `Claim ${claim.claimId} has mixed evidence`, [claim]);
	}
	return check("claim_support", "failed", `Claim ${claim.claimId} is ${claim.supportStatus}`, [claim]);
}

function sourceIntegrityCheck(source: SourceRecord): ArtifactValidationCheck {
	const unresolved = source.metadataConflicts.some(({ resolution }) => resolution === "unresolved");
	if (
		unresolved ||
		source.duplicateStatus === "possible_duplicate" ||
		["retracted", "withdrawn", "expression_of_concern"].includes(source.publicationStatus)
	) {
		return check(
			"source_metadata",
			"failed",
			`Source ${source.sourceId} has unresolved metadata or duplicate status`,
			[source],
		);
	}
	return check("source_metadata", "passed", `Source ${source.sourceId} metadata is resolved`, [source]);
}

function citationStatusCheck(source: SourceRecord, citation: CitationVerification | null): ArtifactValidationCheck {
	if (citation === null) {
		return check(
			"citation_verification",
			"failed",
			`Source ${source.sourceId} has no current unexpired citation verification`,
			[source],
		);
	}
	if (citation.finalStatus !== "verified" && citation.finalStatus !== "verified_with_warning") {
		return check(
			"citation_verification",
			"failed",
			`Source ${source.sourceId} citation status is ${citation.finalStatus}`,
			[source, citation],
		);
	}
	if (["retracted", "withdrawn", "expression_of_concern"].includes(citation.publicationStatus)) {
		return check(
			"citation_verification",
			"failed",
			`Source ${source.sourceId} publication status is ${citation.publicationStatus}`,
			[source, citation],
		);
	}
	if (citation.finalStatus === "verified_with_warning" || citation.publicationStatus !== "normal") {
		return check(
			"citation_verification",
			"warning",
			`Source ${source.sourceId} is verified with publication status ${citation.publicationStatus}`,
			[source, citation],
		);
	}
	return check(
		"citation_verification",
		"passed",
		`Source ${source.sourceId} citation and publication status are verified`,
		[source, citation],
	);
}

export async function evaluateArtifactGates(input: ArtifactGateInput): Promise<ArtifactValidation> {
	if (input.targetStatus === "blocked" || input.targetStatus === "exploratory") {
		return {
			status: "passed",
			checks: [check("artifact_inputs", "passed", "Artifact inputs are valid project snapshots", input.records)],
		};
	}

	const checks: ArtifactValidationCheck[] = [];
	const claimBased = input.artifactType === "review" || input.artifactType === "evidence-matrix";
	const claims = input.records
		.filter((record): record is ClaimRecord => record.kind === "claim")
		.filter((claim) => input.selectedClaimIds.has(claim.claimId))
		.sort((left, right) => left.claimId.localeCompare(right.claimId));
	const evidenceById = new Map(
		input.records
			.filter((record): record is EvidenceCard => record.kind === "evidence")
			.map((evidence) => [evidence.evidenceId, evidence]),
	);
	if (claimBased && claims.length === 0) {
		checks.push(check("claim_scope", "failed", "Evidence-checked artifacts require at least one ClaimRecord", []));
	}
	if (input.targetStatus === "submission_candidate") {
		if (input.artifactType !== "review") {
			checks.push(
				check("submission_artifact_type", "failed", "Only review artifacts can be submission candidates", []),
			);
		}
		const missing = input.allProjectClaimIds.filter((claimId) => !input.selectedClaimIds.has(claimId));
		checks.push(
			check(
				"claim_scope",
				missing.length === 0 && input.allProjectClaimIds.length > 0 ? "passed" : "failed",
				input.allProjectClaimIds.length === 0
					? "Submission candidate requires at least one project claim"
					: missing.length === 0
						? "All project claims are included in the submission candidate"
						: `Submission candidate omits claims: ${missing.join(", ")}`,
				claims,
			),
		);
	}

	const usedSourceIds = new Set(
		claimBased
			? []
			: input.records
					.filter((record): record is SourceRecord => record.kind === "source")
					.map(({ sourceId }) => sourceId),
	);
	for (const claim of claims) {
		checks.push(claimSupportCheck(claim));
		const allLinked = claim.evidenceLinks
			.map(({ evidenceId }) => evidenceById.get(evidenceId))
			.filter((evidence): evidence is EvidenceCard => evidence !== undefined && evidence.validity === "active");
		for (const evidence of allLinked) usedSourceIds.add(evidence.sourceId);
		const linked = claim.evidenceLinks
			.filter(({ relation }) => relation === "supports" || relation === "qualifies")
			.map(({ evidenceId }) => evidenceById.get(evidenceId))
			.filter(locatedEvidence);
		for (const evidence of linked) usedSourceIds.add(evidence.sourceId);
		checks.push(
			check(
				"located_evidence",
				linked.length > 0 ? "passed" : "failed",
				linked.length > 0
					? `Claim ${claim.claimId} has source-located supporting evidence`
					: `Claim ${claim.claimId} has no active located supporting evidence`,
				[claim, ...linked],
			),
		);
		if (claim.conflictEvidenceIds.length > 0 || claim.supportStatus === "mixed") {
			checks.push(
				check("conflicting_evidence", "warning", `Claim ${claim.claimId} retains conflicting evidence`, [claim]),
			);
		}
		if (input.targetStatus === "submission_candidate" && claim.humanConfirmation.status === "not_reviewed") {
			checks.push(
				check("claim_human_review", "warning", `Claim ${claim.claimId} has not been individually reviewed`, [
					claim,
				]),
			);
		}
	}

	const sources = input.records.filter(
		(record): record is SourceRecord => record.kind === "source" && usedSourceIds.has(record.sourceId),
	);
	if (!claimBased && sources.length === 0) {
		checks.push(check("source_scope", "failed", "Evidence-checked exports require at least one SourceRecord", []));
	}
	const citations = input.records.filter(
		(record): record is CitationVerification => record.kind === "citation_verification",
	);
	for (const source of sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
		checks.push(sourceIntegrityCheck(source));
		checks.push(citationStatusCheck(source, await currentCitation(input.projectRoot, source, citations)));
	}
	if (usedSourceIds.size > sources.length) {
		checks.push(check("source_closure", "failed", "Located evidence is missing a SourceRecord snapshot", sources));
	}

	const hasFailure = checks.some(({ status }) => status === "failed");
	const hasWarning = checks.some(({ status }) => status === "warning");
	return {
		status: hasFailure ? "failed" : hasWarning && !input.warningsAccepted ? "passed_with_warnings" : "passed",
		checks,
	};
}

export function operationHasArtifactInputs(
	operation: OperationRecord,
	records: readonly ProjectRecord[],
	files: readonly FileRef[],
): boolean {
	return (
		records.every((record) => {
			const ref = recordRef(record);
			return operation.inputs.some(
				(input) =>
					input.kind === ref.kind && input.id === ref.id && input.revision === projectRecordRevision(record),
			);
		}) &&
		files.every((file) =>
			operation.inputFiles.some(
				(input) =>
					input.path === file.path &&
					input.hash?.value === file.hash?.value &&
					input.mediaType === file.mediaType &&
					input.bytes === file.bytes,
			),
		)
	);
}
