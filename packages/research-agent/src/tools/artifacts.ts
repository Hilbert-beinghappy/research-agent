// SPDX-License-Identifier: Apache-2.0

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import {
	type ArtifactValidation,
	type ArtifactValidationCheck,
	evaluateArtifactGates,
	operationHasArtifactInputs,
} from "../artifacts/gates.ts";
import {
	artifactFormatSpec,
	artifactTypeFromGenerator,
	type RenderedArtifact,
	type ResearchArtifactType,
	renderArtifact,
} from "../artifacts/render.ts";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import type {
	ApprovalRecord,
	ArtifactRecord,
	FileRef,
	HashValue,
	ManuscriptRecord,
	Publishability,
	RecordKind,
	RecordRef,
	ResearchResult,
	SubmissionGateReport,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashBytes, hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath, validateProjectRelativePath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import {
	listProjectRecordIds,
	type ProjectRecord,
	projectRecordId,
	projectRecordRevision,
} from "../project/record-index.ts";
import { createRecord, readRecord } from "../project/records.ts";
import { brokerProjectFile } from "../security/broker-files.ts";

export const ARTIFACT_GENERATOR_VERSION = "0.5.0";

export interface GenerateArtifactRequest {
	action: "generate_structured" | "commit_markdown";
	artifactType: ResearchArtifactType;
	content: string | null;
	sourceRefs: RecordRef[];
	targetStatus: Exclude<Publishability, "blocked">;
	outputPath: string | null;
}

export interface ArtifactSnapshot {
	records: ProjectRecord[];
	sourceRecords: RecordRef[];
	sourceFiles: FileRef[];
	selectedClaimIds: Set<string>;
	allProjectClaimIds: string[];
}

export interface PreparedArtifact {
	request: GenerateArtifactRequest;
	rendered: RenderedArtifact;
	snapshot: ArtifactSnapshot;
	outputFile: FileRef & { hash: HashValue; mediaType: string; bytes: number };
	inputAggregateHash: HashValue;
	validation: ArtifactValidation;
}

export interface ArtifactToolValue {
	artifact: ArtifactRecord;
	reused: boolean;
	requestedStatus: Publishability;
	blockers: ArtifactValidationCheck[];
}

const GENERATION_INPUT_KINDS = new Set<RecordKind>([
	"source",
	"document",
	"evidence",
	"claim",
	"citation_verification",
	"research_question_version",
	"concept",
	"theory_relation",
	"design_decision",
	"protocol",
	"analysis_specification",
	"qualitative_material",
	"qualitative_segment",
	"codebook_version",
	"model_suggestion",
	"coding_decision",
	"theme_synthesis",
	"manuscript",
	"section",
	"claim_occurrence",
	"review_finding",
	"revision_decision",
	"disclosure",
	"submission_gate_report",
	"adapter_export_profile",
	"external_item_link",
	"monitor_subscription",
	"monitor_run",
	"analysis_run",
	"approval",
]);

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

function recordRef(record: ProjectRecord): RecordRef {
	return {
		kind: record.kind,
		id: projectRecordId(record),
		revision: projectRecordRevision(record),
	};
}

function fileKey(file: FileRef): string {
	return `${file.path}:${file.hash?.value ?? ""}:${file.mediaType ?? ""}:${file.bytes ?? ""}`;
}

function completeFile(file: FileRef | null): file is FileRef & {
	hash: HashValue;
	mediaType: string;
	bytes: number;
} {
	return file !== null && file.hash !== null && file.mediaType !== null && file.bytes !== null;
}

function sourceFiles(records: readonly ProjectRecord[]): FileRef[] {
	const files = records.flatMap((record) => {
		if (record.kind === "source") return record.discovery.map(({ rawRecord }) => rawRecord).filter(completeFile);
		if (record.kind === "document") return [record.localFile, record.parsedOutput].filter(completeFile);
		if (record.kind === "citation_verification") {
			return record.verificationSources.map(({ rawRecord }) => rawRecord).filter(completeFile);
		}
		if (record.kind === "analysis_specification") {
			return [record.script, record.environmentFile, ...record.inputFiles].filter(completeFile);
		}
		if (record.kind === "analysis_run") {
			return [record.script, ...record.inputs, ...record.outputs, ...record.logs].filter(completeFile);
		}
		if (record.kind === "qualitative_material") return [record.sourceFile].filter(completeFile);
		return [];
	});
	return [...new Map(files.map((file) => [fileKey(file), file])).values()].sort((left, right) =>
		left.path.localeCompare(right.path),
	);
}

function enqueueDependencies(record: ProjectRecord, pending: RecordRef[]): void {
	if (
		record.kind === "research_question_version" ||
		record.kind === "concept" ||
		record.kind === "theory_relation" ||
		record.kind === "design_decision" ||
		record.kind === "protocol"
	) {
		pending.push(...record.basis.provenance.filter(({ kind }) => kind !== "operation"));
	}
	if (record.kind === "theory_relation") {
		pending.push(
			{ kind: "concept", id: record.fromConceptId, revision: null },
			{ kind: "concept", id: record.toConceptId, revision: null },
		);
	}
	if (record.kind === "protocol") {
		pending.push({ kind: "research_question_version", id: record.researchQuestionVersionId, revision: null });
		pending.push(...record.decisionIds.map((id) => ({ kind: "design_decision" as const, id, revision: null })));
		pending.push(...record.conceptIds.map((id) => ({ kind: "concept" as const, id, revision: null })));
		pending.push(...record.theoryRelationIds.map((id) => ({ kind: "theory_relation" as const, id, revision: null })));
	}
	if (record.kind === "claim") {
		for (const evidenceId of new Set([
			...record.evidenceLinks.map(({ evidenceId }) => evidenceId),
			...record.conflictEvidenceIds,
		])) {
			pending.push({ kind: "evidence", id: evidenceId, revision: null });
		}
	}
	if (record.kind === "evidence") {
		pending.push({ kind: "source", id: record.sourceId, revision: null });
		if (record.documentId !== null) pending.push({ kind: "document", id: record.documentId, revision: null });
	}
	if (record.kind === "document" || record.kind === "citation_verification") {
		pending.push({ kind: "source", id: record.sourceId, revision: null });
	}
	if (record.kind === "manuscript") {
		pending.push(...record.sectionIds.map((id) => ({ kind: "section" as const, id, revision: null })));
		pending.push(
			...record.claimOccurrenceIds.map((id) => ({ kind: "claim_occurrence" as const, id, revision: null })),
		);
		pending.push(
			...record.bibliography.map(({ sourceId }) => ({ kind: "source" as const, id: sourceId, revision: null })),
		);
		pending.push(...record.methodRecords);
	}
	if (record.kind === "section") pending.push({ kind: "manuscript", id: record.manuscriptId, revision: null });
	if (record.kind === "claim_occurrence") {
		pending.push(
			{ kind: "manuscript", id: record.manuscriptId, revision: null },
			{ kind: "section", id: record.sectionId, revision: null },
			{ kind: "claim", id: record.claimId, revision: null },
		);
		pending.push(...record.evidenceIds.map((id) => ({ kind: "evidence" as const, id, revision: null })));
	}
	if (record.kind === "review_finding") {
		pending.push({ kind: "manuscript", id: record.manuscriptId, revision: null });
		if (record.sectionId !== null) pending.push({ kind: "section", id: record.sectionId, revision: null });
		if (record.claimOccurrenceId !== null) {
			pending.push({ kind: "claim_occurrence", id: record.claimOccurrenceId, revision: null });
		}
	}
	if (record.kind === "revision_decision") {
		pending.push({ kind: "manuscript", id: record.toManuscriptId, revision: null });
		if (record.fromManuscriptId !== null) {
			pending.push({ kind: "manuscript", id: record.fromManuscriptId, revision: null });
		}
		if (record.reviewFindingId !== null) {
			pending.push({ kind: "review_finding", id: record.reviewFindingId, revision: null });
		}
	}
	if (record.kind === "disclosure") pending.push({ kind: "manuscript", id: record.manuscriptId, revision: null });
	if (record.kind === "submission_gate_report") {
		pending.push({ kind: "manuscript", id: record.manuscriptId, revision: null });
		if (record.approvalId !== null) pending.push({ kind: "approval", id: record.approvalId, revision: null });
		pending.push(...record.checks.flatMap(({ recordRefs }) => recordRefs));
	}
	if (record.kind === "analysis_run") {
		pending.push({ kind: "analysis_specification", id: record.analysisSpecificationId, revision: null });
	}
	if (record.kind === "theme_synthesis") {
		pending.push({ kind: "codebook_version", id: record.codebookVersionId, revision: null });
		pending.push(...record.codingDecisionIds.map((id) => ({ kind: "coding_decision" as const, id, revision: null })));
		for (const theme of record.themes) {
			pending.push(
				...theme.qualitativeSegmentIds.map((id) => ({ kind: "qualitative_segment" as const, id, revision: null })),
			);
		}
	}
	if (record.kind === "coding_decision") {
		pending.push(
			{ kind: "qualitative_segment", id: record.qualitativeSegmentId, revision: null },
			{ kind: "codebook_version", id: record.codebookVersionId, revision: null },
		);
		if (record.modelSuggestionId !== null) {
			pending.push({ kind: "model_suggestion", id: record.modelSuggestionId, revision: null });
		}
	}
	if (record.kind === "model_suggestion") {
		pending.push(
			{ kind: "qualitative_segment", id: record.qualitativeSegmentId, revision: null },
			{ kind: "codebook_version", id: record.codebookVersionId, revision: null },
		);
	}
	if (record.kind === "qualitative_segment") {
		pending.push({ kind: "qualitative_material", id: record.qualitativeMaterialId, revision: null });
	}
}

export async function loadArtifactSnapshot(
	projectRoot: string,
	sourceRefs: readonly RecordRef[],
	operationId: string,
): Promise<ResearchResult<ArtifactSnapshot>> {
	try {
		if (sourceRefs.length === 0) throw new TypeError("Artifact generation requires at least one source record");
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const selectedClaimIds = new Set(sourceRefs.filter(({ kind }) => kind === "claim").map(({ id }) => id));
		const pending = [...sourceRefs];
		const records = new Map<string, ProjectRecord>();
		while (pending.length > 0) {
			const ref = pending.shift();
			if (ref === undefined) break;
			if (!GENERATION_INPUT_KINDS.has(ref.kind)) {
				throw new TypeError(`Record kind ${ref.kind} cannot be an artifact generation input`);
			}
			const key = `${ref.kind}:${ref.id}`;
			const existing = records.get(key);
			if (existing !== undefined) {
				if (ref.revision !== null && ref.revision !== projectRecordRevision(existing)) {
					throw new Error(`DATA_CONFLICT: stale ${ref.kind} snapshot ${ref.id}`);
				}
				continue;
			}
			const result = await readRecord(opened.root, ref.kind, ref.id);
			if (!result.ok) return propagatedFailure(result, operationId);
			if (ref.revision !== null && ref.revision !== projectRecordRevision(result.value)) {
				throw new Error(`DATA_CONFLICT: stale ${ref.kind} snapshot ${ref.id}`);
			}
			records.set(key, result.value);
			enqueueDependencies(result.value, pending);
		}

		const sourceIds = new Set(
			[...records.values()]
				.filter((record) => record.kind === "source")
				.map((record) => (record.kind === "source" ? record.sourceId : "")),
		);
		for (const verificationId of await listProjectRecordIds(opened.root, opened.manifest, "citation_verification")) {
			const result = await readRecord(opened.root, "citation_verification", verificationId);
			if (!result.ok) return propagatedFailure(result, operationId);
			if (result.value.kind === "citation_verification" && sourceIds.has(result.value.sourceId)) {
				records.set(`citation_verification:${verificationId}`, result.value);
			}
		}
		const values = [...records.values()].sort((left, right) =>
			`${left.kind}:${projectRecordId(left)}`.localeCompare(`${right.kind}:${projectRecordId(right)}`),
		);
		return successResult(
			{
				records: values,
				sourceRecords: values.map(recordRef),
				sourceFiles: sourceFiles(values),
				selectedClaimIds,
				allProjectClaimIds: await listProjectRecordIds(opened.root, opened.manifest, "claim"),
			},
			operationId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Artifact inputs could not be loaded";
		return failureResult(
			message.startsWith("DATA_CONFLICT:") ? "DATA_CONFLICT" : "PERMANENT_FAILURE",
			message.startsWith("DATA_CONFLICT:") ? "ARTIFACT_INPUT_STALE" : "ARTIFACT_INPUT_INVALID",
			message.startsWith("DATA_CONFLICT:") ? "data_conflict" : "validation",
			message,
			operationId,
		);
	}
}

export function artifactInputAggregateHash(
	rendered: Pick<RenderedArtifact, "artifactKind" | "generatorId">,
	sourceRecords: readonly RecordRef[],
	sourceFiles: readonly FileRef[],
	outputHash: HashValue,
): HashValue {
	return hashCanonicalJson({
		generator: { id: rendered.generatorId, version: ARTIFACT_GENERATOR_VERSION },
		artifactKind: rendered.artifactKind,
		sourceRecords,
		sourceFiles,
		outputHash,
	});
}

function outputPath(request: GenerateArtifactRequest, rendered: RenderedArtifact, aggregateHash: HashValue): string {
	const path = validateProjectRelativePath(
		request.outputPath ??
			`${rendered.directory}/${request.artifactType}-${aggregateHash.value.slice(0, 16)}.${rendered.extension}`,
	);
	if (!path.startsWith("artifacts/")) throw new TypeError("Artifact outputPath must be inside artifacts/");
	if (extname(path).toLowerCase() !== `.${rendered.extension}`) {
		throw new TypeError(`Artifact outputPath must use .${rendered.extension}`);
	}
	return path;
}

export async function prepareArtifact(
	projectRoot: string,
	request: GenerateArtifactRequest,
	operationId: string,
): Promise<ResearchResult<PreparedArtifact>> {
	try {
		if (request.action === "commit_markdown" && request.artifactType !== "review") {
			throw new TypeError("commit_markdown only accepts review artifacts");
		}
		if (request.action === "generate_structured" && request.artifactType === "review") {
			throw new TypeError("Review artifacts require commit_markdown content");
		}
		if (request.action === "generate_structured" && request.content !== null) {
			throw new TypeError("Structured artifacts are generated from canonical records and cannot accept content");
		}
		const snapshot = await loadArtifactSnapshot(projectRoot, request.sourceRefs, operationId);
		if (!snapshot.ok) return snapshot;
		if (
			!(await Promise.all(snapshot.value.sourceFiles.map((file) => outputMatches(projectRoot, file)))).every(Boolean)
		) {
			return failureResult(
				"DATA_CONFLICT",
				"ARTIFACT_SOURCE_FILE_CHANGED",
				"data_conflict",
				"An artifact source file is missing or no longer matches its recorded hash",
				operationId,
			);
		}
		const rendered = renderArtifact(request.artifactType, snapshot.value.records, request.content);
		const outputHash = hashBytes(rendered.content);
		const inputAggregateHash = artifactInputAggregateHash(
			rendered,
			snapshot.value.sourceRecords,
			snapshot.value.sourceFiles,
			outputHash,
		);
		const validation = await evaluateArtifactGates({
			projectRoot,
			artifactType: request.artifactType,
			targetStatus: request.targetStatus,
			records: snapshot.value.records,
			selectedClaimIds: snapshot.value.selectedClaimIds,
			allProjectClaimIds: snapshot.value.allProjectClaimIds,
			warningsAccepted: false,
		});
		return successResult(
			{
				request,
				rendered,
				snapshot: snapshot.value,
				outputFile: {
					path: outputPath(request, rendered, inputAggregateHash),
					hash: outputHash,
					mediaType: rendered.mediaType,
					bytes:
						typeof rendered.content === "string"
							? Buffer.byteLength(rendered.content)
							: rendered.content.byteLength,
				},
				inputAggregateHash,
				validation,
			},
			operationId,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"ARTIFACT_PREPARATION_FAILED",
			"validation",
			error instanceof Error ? error.message : "Artifact could not be prepared",
			operationId,
		);
	}
}

async function outputMatches(projectRoot: string, file: FileRef): Promise<boolean> {
	if (!completeFile(file)) return false;
	try {
		const path = await resolveProjectPath(projectRoot, file.path);
		return (await stat(path)).size === file.bytes && (await hashFile(path)).value === file.hash.value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function existingArtifact(
	projectRoot: string,
	prepared: PreparedArtifact,
	validation: ArtifactValidation,
	publishability: Publishability,
): Promise<ArtifactRecord | null> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const validationKey = canonicalStringify({
		...validation,
		checks: validation.checks.map((item) =>
			item.name === "human_final_confirmation" ? { ...item, recordRefs: [] } : item,
		),
	});
	// ponytail: O(n) artifact scan; add a derived index only after project benchmarks require it.
	for (const artifactId of await listProjectRecordIds(opened.root, opened.manifest, "artifact")) {
		const result = await readRecord(opened.root, "artifact", artifactId);
		if (!result.ok || result.value.kind !== "artifact") throw new TypeError(`Invalid artifact ${artifactId}`);
		const artifact = result.value;
		if (
			artifact.artifactKind === prepared.rendered.artifactKind &&
			artifact.generator.id === prepared.rendered.generatorId &&
			artifact.generator.version === ARTIFACT_GENERATOR_VERSION &&
			artifact.inputAggregateHash.value === prepared.inputAggregateHash.value &&
			artifact.outputFile.path === prepared.outputFile.path &&
			artifact.outputFile.hash?.value === prepared.outputFile.hash.value &&
			artifact.publishability === publishability &&
			canonicalStringify({
				...artifact.validation,
				checks: artifact.validation.checks.map((item) =>
					item.name === "human_final_confirmation" ? { ...item, recordRefs: [] } : item,
				),
			}) === validationKey &&
			(await outputMatches(projectRoot, artifact.outputFile))
		) {
			return artifact;
		}
	}
	return null;
}

async function supersededArtifactId(projectRoot: string, outputPath: string): Promise<string | null> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const matches: ArtifactRecord[] = [];
	for (const artifactId of await listProjectRecordIds(opened.root, opened.manifest, "artifact")) {
		const result = await readRecord(opened.root, "artifact", artifactId);
		if (!result.ok || result.value.kind !== "artifact") throw new TypeError(`Invalid artifact ${artifactId}`);
		if (result.value.outputFile.path === outputPath) matches.push(result.value);
	}
	return (
		matches.sort(
			(left, right) =>
				Date.parse(right.audit.createdAt) - Date.parse(left.audit.createdAt) ||
				right.artifactId.localeCompare(left.artifactId),
		)[0]?.artifactId ?? null
	);
}

function actualPublishability(
	target: GenerateArtifactRequest["targetStatus"],
	validation: ArtifactValidation,
): Publishability {
	if (validation.status === "failed") return "blocked";
	if (target === "submission_candidate" && validation.status !== "passed") return "blocked";
	return target;
}

function manuscriptSubmissionApproval(records: readonly ProjectRecord[]): ApprovalRecord | null {
	const manuscripts = records.filter((record): record is ManuscriptRecord => record.kind === "manuscript");
	if (manuscripts.length !== 1) return null;
	const manuscript = manuscripts[0];
	if (manuscript === undefined) return null;
	const report = records
		.filter(
			(record): record is SubmissionGateReport =>
				record.kind === "submission_gate_report" &&
				record.manuscriptId === manuscript.manuscriptId &&
				record.passed,
		)
		.sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt))[0];
	if (report?.kind !== "submission_gate_report" || report.approvalId === null) return null;
	const approval = records.find((record) => record.kind === "approval" && record.approvalId === report.approvalId);
	return approval?.kind === "approval" &&
		approval.decision === "approved" &&
		approval.actionClass === "publish_or_submit" &&
		approval.actionName === "research.manuscript.mark_submission_candidate" &&
		approval.dataEgress.recordRefs.some(({ kind, id }) => kind === "manuscript" && id === manuscript.manuscriptId)
		? approval
		: null;
}

export async function commitPreparedArtifact(
	projectRoot: string,
	prepared: PreparedArtifact,
	operationId: string,
	sessionId: string | null,
	submissionApprovalId: string | null,
): Promise<ResearchResult<ArtifactToolValue>> {
	try {
		const explicitApproval =
			submissionApprovalId === null
				? null
				: await validSubmissionApproval(projectRoot, operationId, submissionApprovalId);
		if (submissionApprovalId !== null && explicitApproval === null) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"SUBMISSION_APPROVAL_INVALID",
				"permission",
				"Submission candidate approval is missing, denied, or not linked to this Operation",
				operationId,
			);
		}
		const approval =
			explicitApproval ??
			(prepared.request.artifactType === "manuscript"
				? manuscriptSubmissionApproval(prepared.snapshot.records)
				: null);
		const warningsAccepted = prepared.request.targetStatus === "submission_candidate" && approval !== null;
		const validation = await evaluateArtifactGates({
			projectRoot,
			artifactType: prepared.request.artifactType,
			targetStatus: prepared.request.targetStatus,
			records: prepared.snapshot.records,
			selectedClaimIds: prepared.snapshot.selectedClaimIds,
			allProjectClaimIds: prepared.snapshot.allProjectClaimIds,
			warningsAccepted,
		});
		if (
			prepared.request.targetStatus === "submission_candidate" &&
			validation.status !== "failed" &&
			approval === null
		) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"SUBMISSION_APPROVAL_REQUIRED",
				"permission",
				"A submission candidate requires final user confirmation",
				operationId,
			);
		}
		if (approval !== null) {
			validation.checks.push({
				name: "human_final_confirmation",
				status: "passed",
				message: "User confirmed this submission candidate",
				recordRefs: [{ kind: "approval", id: approval.approvalId, revision: approval.audit.revision }],
			});
		}
		const publishability = actualPublishability(prepared.request.targetStatus, validation);
		const reusable = await existingArtifact(projectRoot, prepared, validation, publishability);
		if (reusable !== null) {
			return successResult(
				{
					artifact: reusable,
					reused: true,
					requestedStatus: prepared.request.targetStatus,
					blockers: validation.checks.filter(({ status }) => status === "failed"),
				},
				operationId,
			);
		}
		if (!(await outputMatches(projectRoot, prepared.outputFile))) {
			const opened = await openProject(projectRoot);
			if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
			const written = await brokerProjectFile(opened.root, {
				operationId,
				sessionId,
				expectedManifestRevision: opened.manifest.revision,
				path: prepared.outputFile.path,
				content: prepared.rendered.content,
				dataClasses: ["research_artifact"],
			});
			if (!written.ok) return propagatedFailure(written, operationId);
		}
		const artifactId = createOpaqueId("artifact");
		const now = new Date().toISOString();
		const artifact: ArtifactRecord = {
			kind: "artifact",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			artifactId,
			artifactKind: prepared.rendered.artifactKind,
			title: prepared.rendered.title,
			sourceRecords: prepared.snapshot.sourceRecords,
			sourceFiles: prepared.snapshot.sourceFiles,
			outputFile: prepared.outputFile,
			generator: {
				id: prepared.rendered.generatorId,
				version: ARTIFACT_GENERATOR_VERSION,
				operationId,
				templateId: null,
				templateVersion: null,
			},
			inputAggregateHash: prepared.inputAggregateHash,
			validation,
			publishability,
			supersedesArtifactId: await supersededArtifactId(projectRoot, prepared.outputFile.path),
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: operationId,
				updatedByOperationId: operationId,
			},
		};
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const created = await createRecord(opened.root, artifact, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		if (!created.ok) return propagatedFailure(created, operationId);
		const stored = await readRecord(opened.root, "artifact", artifactId);
		if (!stored.ok) return propagatedFailure(stored, operationId);
		if (stored.value.kind !== "artifact") throw new TypeError(`Created artifact ${artifactId} is invalid`);
		return successResult(
			{
				artifact: stored.value,
				reused: false,
				requestedStatus: prepared.request.targetStatus,
				blockers: validation.checks.filter(({ status }) => status === "failed"),
			},
			operationId,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"ARTIFACT_COMMIT_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Artifact could not be committed",
			operationId,
		);
	}
}

async function validSubmissionApproval(
	projectRoot: string,
	operationId: string,
	approvalId: string,
): Promise<ApprovalRecord | null> {
	const [approval, operation] = await Promise.all([
		readRecord(projectRoot, "approval", approvalId),
		readRecord(projectRoot, "operation", operationId),
	]);
	return approval.ok &&
		approval.value.kind === "approval" &&
		approval.value.actionClass === "publish_or_submit" &&
		approval.value.actionName === "research.artifact.mark_submission_candidate" &&
		approval.value.decision === "approved" &&
		approval.value.operationId === operationId &&
		operation.ok &&
		operation.value.kind === "operation" &&
		operation.value.approvalIds.includes(approvalId)
		? approval.value
		: null;
}

export async function validateArtifact(
	projectRoot: string,
	artifactId: string,
	expectedRevision: number | null,
	artifactType: ResearchArtifactType,
	targetStatus: Exclude<Publishability, "blocked">,
	operationId: string,
): Promise<ResearchResult<ArtifactToolValue>> {
	try {
		const result = await readRecord(projectRoot, "artifact", artifactId);
		if (!result.ok) return propagatedFailure(result, operationId);
		if (result.value.kind !== "artifact") throw new TypeError(`Record ${artifactId} is not an artifact`);
		const artifact = result.value;
		if (expectedRevision !== null && artifact.audit.revision !== expectedRevision) {
			return failureResult(
				"DATA_CONFLICT",
				"ARTIFACT_REVISION_CONFLICT",
				"data_conflict",
				`Expected artifact revision ${expectedRevision}, found ${artifact.audit.revision}`,
				operationId,
			);
		}
		if (artifactTypeFromGenerator(artifact.generator.id) !== artifactType) {
			throw new TypeError("Artifact type does not match its generator");
		}
		const snapshot = await loadArtifactSnapshot(projectRoot, artifact.sourceRecords, operationId);
		if (!snapshot.ok) return snapshot;
		const checks = (
			await evaluateArtifactGates({
				projectRoot,
				artifactType,
				targetStatus,
				records: snapshot.value.records,
				selectedClaimIds: new Set(
					artifact.sourceRecords.filter(({ kind }) => kind === "claim").map(({ id }) => id),
				),
				allProjectClaimIds: snapshot.value.allProjectClaimIds,
				warningsAccepted: artifact.publishability === "submission_candidate",
			})
		).checks;
		checks.push({
			name: "artifact_output_integrity",
			status: (await outputMatches(projectRoot, artifact.outputFile)) ? "passed" : "failed",
			message: "Artifact output must match its stored hash and byte count",
			recordRefs: [{ kind: "artifact", id: artifact.artifactId, revision: artifact.audit.revision }],
		});
		checks.push({
			name: "artifact_input_file_integrity",
			status: (await Promise.all(snapshot.value.sourceFiles.map((file) => outputMatches(projectRoot, file)))).every(
				Boolean,
			)
				? "passed"
				: "failed",
			message: "Artifact source files must match their stored hashes and byte counts",
			recordRefs: [{ kind: "artifact", id: artifact.artifactId, revision: artifact.audit.revision }],
		});
		const aggregate = artifactInputAggregateHash(
			artifactFormatSpec(artifactType),
			snapshot.value.sourceRecords,
			snapshot.value.sourceFiles,
			artifact.outputFile.hash ?? hashBytes(""),
		);
		checks.push({
			name: "artifact_input_hash",
			status:
				artifact.outputFile.hash !== null && aggregate.value === artifact.inputAggregateHash.value
					? "passed"
					: "failed",
			message: "Artifact aggregate hash must match its generator, inputs, and output",
			recordRefs: [{ kind: "artifact", id: artifact.artifactId, revision: artifact.audit.revision }],
		});
		const generator = await readRecord(projectRoot, "operation", artifact.generator.operationId);
		let submissionApproval: ApprovalRecord | null =
			artifactType === "manuscript" ? manuscriptSubmissionApproval(snapshot.value.records) : null;
		if (generator.ok && generator.value.kind === "operation") {
			const generatorOperation = generator.value;
			submissionApproval ??=
				(
					await Promise.all(
						generatorOperation.approvalIds.map((approvalId) =>
							validSubmissionApproval(projectRoot, generatorOperation.operationId, approvalId),
						),
					)
				).find((approval) => approval !== null) ?? null;
		}
		if (targetStatus === "submission_candidate") {
			checks.push({
				name: "human_final_confirmation",
				status: submissionApproval === null ? "failed" : "passed",
				message:
					submissionApproval === null
						? "Submission candidate has no valid final user confirmation"
						: "Submission candidate has a valid final user confirmation",
				recordRefs:
					submissionApproval === null
						? []
						: [
								{
									kind: "approval",
									id: submissionApproval.approvalId,
									revision: submissionApproval.audit.revision,
								},
							],
			});
		}
		checks.push({
			name: "artifact_operation_provenance",
			status:
				generator.ok &&
				generator.value.kind === "operation" &&
				operationHasArtifactInputs(generator.value, snapshot.value.records, snapshot.value.sourceFiles)
					? "passed"
					: "failed",
			message: "Artifact generator Operation must reference every canonical input snapshot",
			recordRefs: [{ kind: "artifact", id: artifact.artifactId, revision: artifact.audit.revision }],
		});
		const hasFailure = checks.some(({ status }) => status === "failed");
		const hasWarning = checks.some(({ status }) => status === "warning");
		const validation: ArtifactValidation = {
			status:
				hasFailure || (targetStatus === "submission_candidate" && submissionApproval === null)
					? "failed"
					: hasWarning && targetStatus !== "submission_candidate"
						? "passed_with_warnings"
						: "passed",
			checks,
		};
		return successResult(
			{
				artifact: { ...artifact, validation },
				reused: true,
				requestedStatus: targetStatus,
				blockers: checks.filter(({ status }) => status === "failed"),
			},
			operationId,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"ARTIFACT_VALIDATION_FAILED",
			"validation",
			error instanceof Error ? error.message : "Artifact could not be validated",
			operationId,
		);
	}
}
