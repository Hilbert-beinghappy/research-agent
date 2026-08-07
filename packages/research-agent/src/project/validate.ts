// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from "node:fs/promises";
import type { FileRef, OperationRecord, RecordKind, RecordRef } from "../contracts/schemas.ts";
import { readParsedPdfDocument, resolveParsedPdfLocator } from "../evidence/query.ts";
import { hashBytes, hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { countManuscriptWords, manuscriptContentHash, reviewFindingFingerprint } from "../tools/writing.ts";
import { openProject } from "./open.ts";
import {
	calculateRecordSetIndex,
	listProjectRecordIds,
	type ProjectRecord,
	projectRecordRevision,
} from "./record-index.ts";
import { readRecord } from "./records.ts";
import { listPendingProjectTransactions } from "./transactions.ts";

export interface ProjectValidationIssue {
	code: string;
	path: string;
	message: string;
}

export interface ProjectValidationReport {
	valid: boolean;
	projectId: string;
	revision: number;
	checkedRecords: number;
	pendingTransactionIds: string[];
	issues: ProjectValidationIssue[];
}

const RECORD_KINDS = new Set<RecordKind>([
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
	"dataset",
	"variable",
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
	"adapter_registration",
	"exchange_record",
	"collaboration_merge",
	"model_route_decision",
	"task",
	"operation",
	"analysis_run",
	"artifact",
	"approval",
]);

function operationHasRecord(operation: OperationRecord, kind: "source" | "document", id: string): boolean {
	return operation.inputs.some((input) => input.kind === kind && input.id === id && input.revision !== null);
}

function fileMatches(left: FileRef, right: FileRef): boolean {
	return (
		left.path === right.path &&
		left.hash?.value === right.hash?.value &&
		left.mediaType === right.mediaType &&
		left.bytes === right.bytes
	);
}

function normalizedExactText(value: string): string {
	return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function collectRecordRefs(value: unknown, refs: RecordRef[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectRecordRefs(item, refs);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const object = value as Record<string, unknown>;
	if (
		typeof object.kind === "string" &&
		RECORD_KINDS.has(object.kind as RecordKind) &&
		typeof object.id === "string" &&
		Object.hasOwn(object, "revision")
	) {
		refs.push(object as unknown as RecordRef);
	}
	for (const child of Object.values(object)) collectRecordRefs(child, refs);
}

export async function validateProject(projectRoot: string): Promise<ProjectValidationReport> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError(`Project schema ${opened.schemaVersion} is read-only`);
	const issues: ProjectValidationIssue[] = [];
	const records = new Map<RecordKind, Map<string, ProjectRecord>>();
	let checkedRecords = 0;

	for (const recordSet of opened.manifest.recordSets) {
		const actual = await calculateRecordSetIndex(opened.root, opened.manifest, recordSet.kind);
		if (actual.count !== recordSet.count || actual.contentHash?.value !== recordSet.contentHash?.value) {
			issues.push({
				code: "RECORD_SET_HASH_MISMATCH",
				path: recordSet.path,
				message: `Manifest index does not match ${recordSet.kind} records`,
			});
		}
		const kindRecords = new Map<string, ProjectRecord>();
		records.set(recordSet.kind, kindRecords);
		for (const id of await listProjectRecordIds(opened.root, opened.manifest, recordSet.kind)) {
			const result = await readRecord(opened.root, recordSet.kind, id);
			if (!result.ok) {
				issues.push({
					code: result.errors[0].code,
					path: `${recordSet.path}/${id}.json`,
					message: result.errors[0].message,
				});
				continue;
			}
			kindRecords.set(id, result.value);
			checkedRecords += 1;
		}
	}

	const requireRecord = (
		kind: RecordKind,
		id: string,
		path: string,
		revision: number | null = null,
		allowHistorical = false,
	): void => {
		const record = records.get(kind)?.get(id);
		if (record === undefined) {
			issues.push({ code: "MISSING_RECORD_REFERENCE", path, message: `Missing ${kind} record ${id}` });
			return;
		}
		if (
			revision !== null &&
			(projectRecordRevision(record) < revision || (!allowHistorical && projectRecordRevision(record) !== revision))
		) {
			issues.push({
				code: projectRecordRevision(record) < revision ? "FUTURE_RECORD_REFERENCE" : "STALE_RECORD_REFERENCE",
				path,
				message: `Expected ${kind} ${id} revision ${revision}`,
			});
		}
	};
	const requireConfirmedDesign = (
		kind: "research_question_version" | "concept" | "theory_relation" | "design_decision" | "protocol",
		id: string,
		path: string,
	): void => {
		requireRecord(kind, id, path);
		const record = records.get(kind)?.get(id);
		if (record !== undefined && "confirmation" in record && record.status !== "confirmed") {
			issues.push({
				code: "DESIGN_REFERENCE_NOT_CONFIRMED",
				path,
				message: `${kind} ${id} is ${record.status}, not confirmed`,
			});
		}
	};
	const requireFile = async (file: FileRef, path: string): Promise<void> => {
		try {
			const filePath = await resolveProjectPath(opened.root, file.path);
			const fileStat = await stat(filePath);
			const fileHash = await hashFile(filePath);
			if (
				file.hash === null ||
				file.bytes === null ||
				fileStat.size !== file.bytes ||
				fileHash.value !== file.hash.value
			) {
				throw new TypeError("file does not match its FileRef");
			}
		} catch (error) {
			issues.push({
				code: "INVALID_FILE_REFERENCE",
				path,
				message: error instanceof Error ? error.message : "File reference is invalid",
			});
		}
	};

	for (const taskId of opened.manifest.activeTaskIds)
		requireRecord("task", taskId, "research-project.json#activeTaskIds");
	if (opened.manifest.lastCommittedOperationId !== null) {
		requireRecord(
			"operation",
			opened.manifest.lastCommittedOperationId,
			"research-project.json#lastCommittedOperationId",
		);
	}
	const supersededEvidenceIds = new Set(
		[...(records.get("evidence")?.values() ?? [])]
			.filter((record) => record.kind === "evidence" && record.supersedesEvidenceId !== null)
			.map((record) => (record.kind === "evidence" ? record.supersedesEvidenceId : null))
			.filter((id): id is string => id !== null),
	);
	const supersededArtifactIds = new Set(
		[...(records.get("artifact")?.values() ?? [])]
			.filter((record) => record.kind === "artifact" && record.supersedesArtifactId !== null)
			.map((record) => (record.kind === "artifact" ? record.supersedesArtifactId : null))
			.filter((id): id is string => id !== null),
	);
	const parsedDocuments = new Map<string, Awaited<ReturnType<typeof readParsedPdfDocument>>>();
	const materialTexts = new Map<string, string>();

	for (const [kind, kindRecords] of records) {
		for (const [id, record] of kindRecords) {
			const path = `${kind}:${id}`;
			const refs: RecordRef[] = [];
			collectRecordRefs(record, refs);
			for (const ref of refs) requireRecord(ref.kind, ref.id, path, ref.revision, true);
			if (record.kind !== "task") {
				requireRecord("operation", record.audit.createdByOperationId, `${path}#audit.createdByOperationId`);
				requireRecord("operation", record.audit.updatedByOperationId, `${path}#audit.updatedByOperationId`);
			}
			switch (record.kind) {
				case "source":
					if (record.canonicalSourceId !== null)
						requireRecord("source", record.canonicalSourceId, `${path}#canonicalSourceId`);
					break;
				case "document":
					requireRecord("source", record.sourceId, `${path}#sourceId`);
					if (record.acquisition.approvalId !== null)
						requireRecord("approval", record.acquisition.approvalId, `${path}#acquisition.approvalId`);
					break;
				case "evidence": {
					requireRecord("source", record.sourceId, `${path}#sourceId`);
					if (record.documentId !== null) requireRecord("document", record.documentId, `${path}#documentId`);
					if (record.extraction.operationId !== null)
						requireRecord("operation", record.extraction.operationId, `${path}#extraction.operationId`);
					if (
						record.sourceVerification?.operationId !== null &&
						record.sourceVerification?.operationId !== undefined
					)
						requireRecord(
							"operation",
							record.sourceVerification.operationId,
							`${path}#sourceVerification.operationId`,
						);
					for (const link of record.claimLinks) requireRecord("claim", link.claimId, `${path}#claimLinks`);
					if (record.supersedesEvidenceId !== null) {
						requireRecord("evidence", record.supersedesEvidenceId, `${path}#supersedesEvidenceId`);
						const superseded = records.get("evidence")?.get(record.supersedesEvidenceId);
						if (
							superseded?.kind === "evidence" &&
							(superseded.validity !== "superseded" || superseded.sourceId !== record.sourceId)
						) {
							issues.push({
								code: "INVALID_EVIDENCE_SUPERSESSION",
								path: `${path}#supersedesEvidenceId`,
								message: "Superseded evidence must be marked superseded and belong to the same source",
							});
						}
					}
					if (record.validity === "superseded" && !supersededEvidenceIds.has(record.evidenceId)) {
						issues.push({
							code: "MISSING_EVIDENCE_SUCCESSOR",
							path: `${path}#validity`,
							message: "Superseded evidence has no successor card",
						});
					}
					const source = records.get("source")?.get(record.sourceId);
					const document =
						record.documentId === null ? undefined : records.get("document")?.get(record.documentId);
					const verificationOperationId = record.sourceVerification?.operationId ?? record.extraction.operationId;
					const extraction =
						verificationOperationId === null ? undefined : records.get("operation")?.get(verificationOperationId);
					if (extraction?.kind === "operation") {
						if (!operationHasRecord(extraction, "source", record.sourceId)) {
							issues.push({
								code: "MISSING_EVIDENCE_SOURCE_SNAPSHOT",
								path: `${path}#sourceVerification.operationId`,
								message: "Source verification operation does not reference the evidence source",
							});
						}
						if (record.documentId !== null && !operationHasRecord(extraction, "document", record.documentId)) {
							issues.push({
								code: "MISSING_EVIDENCE_DOCUMENT_SNAPSHOT",
								path: `${path}#sourceVerification.operationId`,
								message: "Source verification operation does not reference the evidence document",
							});
						}
						if (
							record.extraction.method === "model_suggested" &&
							(extraction.operationKind !== "tool" || extraction.session === null)
						) {
							issues.push({
								code: "INVALID_EVIDENCE_MODEL_PROVENANCE",
								path: `${path}#extraction`,
								message: "Evidence model provenance is not bound to a tool session operation",
							});
						}
					}
					if (document?.kind === "document") {
						if (document.sourceId !== record.sourceId) {
							issues.push({
								code: "EVIDENCE_DOCUMENT_SOURCE_MISMATCH",
								path: `${path}#documentId`,
								message: "Evidence source and document source do not match",
							});
						}
						const snapshot =
							record.evidenceLevel === "fulltext_unlocated" ? document.localFile : document.parsedOutput;
						if (
							record.validity === "active" &&
							extraction?.kind === "operation" &&
							(snapshot === null || !extraction.inputFiles.some((file) => fileMatches(file, snapshot)))
						) {
							issues.push({
								code: "STALE_EVIDENCE_DOCUMENT_SNAPSHOT",
								path: `${path}#sourceVerification.operationId`,
								message: "Evidence source verification does not reference the current document snapshot",
							});
						}
						if (
							record.validity === "active" &&
							record.evidenceLevel === "fulltext_located" &&
							record.locator !== null
						) {
							let parsed = parsedDocuments.get(document.documentId);
							if (parsed === undefined) {
								parsed = await readParsedPdfDocument(
									opened.root,
									document,
									verificationOperationId ?? record.audit.createdByOperationId,
								);
								parsedDocuments.set(document.documentId, parsed);
							}
							if (!parsed.ok) {
								issues.push({
									code: parsed.errors[0].code,
									path: `${path}#documentId`,
									message: parsed.errors[0].message,
								});
							} else {
								const located = resolveParsedPdfLocator(
									parsed.value,
									record.locator,
									verificationOperationId ?? record.audit.createdByOperationId,
								);
								if (!located.ok) {
									issues.push({
										code: located.errors[0].code,
										path: `${path}#locator`,
										message: located.errors[0].message,
									});
								} else if (
									record.excerptExactMatch === true &&
									record.excerpt !== null &&
									normalizedExactText(located.value.text) !== normalizedExactText(record.excerpt)
								) {
									issues.push({
										code: "EVIDENCE_EXCERPT_MISMATCH",
										path: `${path}#excerpt`,
										message: "Evidence excerpt does not match its current parsed locator",
									});
								}
							}
						}
						if (record.validity === "active") {
							for (const warning of document.warnings) {
								if (record.confidence.limitations.includes(warning)) continue;
								issues.push({
									code: "EVIDENCE_DOCUMENT_WARNING_MISSING",
									path: `${path}#confidence.limitations`,
									message: "Evidence card does not inherit its document warning",
								});
							}
						}
					} else if (
						record.validity === "active" &&
						record.documentId === null &&
						record.excerptExactMatch === true &&
						record.excerpt !== null
					) {
						const target =
							source?.kind !== "source"
								? null
								: record.evidenceLevel === "metadata"
									? source.title
									: record.evidenceLevel === "abstract"
										? source.abstractText
										: null;
						if (target === null || !normalizedExactText(target).includes(normalizedExactText(record.excerpt))) {
							issues.push({
								code: "EVIDENCE_EXCERPT_MISMATCH",
								path: `${path}#excerpt`,
								message: "Evidence excerpt does not match its current source record",
							});
						}
					}
					break;
				}
				case "claim": {
					for (const link of record.evidenceLinks)
						requireRecord("evidence", link.evidenceId, `${path}#evidenceLinks`);
					for (const evidenceId of record.conflictEvidenceIds)
						requireRecord("evidence", evidenceId, `${path}#conflictEvidenceIds`);
					const claimProvenanceOperationId = record.semanticProvenance?.claim.operationId;
					if (claimProvenanceOperationId !== null && claimProvenanceOperationId !== undefined)
						requireRecord(
							"operation",
							claimProvenanceOperationId,
							`${path}#semanticProvenance.claim.operationId`,
						);
					for (const [index, provenance] of (record.semanticProvenance?.evidenceLinks ?? []).entries()) {
						if (provenance.operationId !== null)
							requireRecord(
								"operation",
								provenance.operationId,
								`${path}#semanticProvenance.evidenceLinks[${index}].operationId`,
							);
					}
					break;
				}
				case "citation_verification":
					requireRecord("source", record.sourceId, `${path}#sourceId`);
					{
						const citationSource = records.get("source")?.get(record.sourceId);
						const creator = records.get("operation")?.get(record.audit.createdByOperationId);
						if (
							citationSource?.kind === "source" &&
							creator?.kind === "operation" &&
							!creator.inputs.some(
								(input) =>
									input.kind === "source" &&
									input.id === record.sourceId &&
									input.revision === citationSource.audit.revision,
							)
						) {
							issues.push({
								code: "STALE_CITATION_SOURCE_SNAPSHOT",
								path: `${path}#audit.createdByOperationId`,
								message: "Citation verification does not reference the current source snapshot",
							});
						}
						for (const verificationSource of record.verificationSources) {
							requireRecord("operation", verificationSource.operationId, `${path}#verificationSources`);
							const operation = records.get("operation")?.get(verificationSource.operationId);
							if (operation?.kind !== "operation") continue;
							if (
								operation.adapterExecution?.adapterId !== verificationSource.adapterId ||
								operation.adapterExecution.adapterVersion !== verificationSource.adapterVersion ||
								operation.rawResponse === null ||
								!fileMatches(operation.rawResponse, verificationSource.rawRecord) ||
								operation.finishedAt !== verificationSource.checkedAt
							) {
								issues.push({
									code: "INVALID_CITATION_PROVIDER_PROVENANCE",
									path: `${path}#verificationSources`,
									message: "Citation provider provenance conflicts with its Operation",
								});
							}
							try {
								const rawPath = await resolveProjectPath(opened.root, verificationSource.rawRecord.path);
								const rawStat = await stat(rawPath);
								const rawHash = await hashFile(rawPath);
								if (
									verificationSource.rawRecord.hash === null ||
									verificationSource.rawRecord.bytes === null ||
									rawStat.size !== verificationSource.rawRecord.bytes ||
									rawHash.value !== verificationSource.rawRecord.hash.value
								) {
									throw new TypeError("citation raw evidence does not match its FileRef");
								}
							} catch (error) {
								issues.push({
									code: "INVALID_CITATION_RAW_EVIDENCE",
									path: `${path}#verificationSources`,
									message: error instanceof Error ? error.message : "Citation raw evidence is invalid",
								});
							}
							if (
								citationSource?.kind === "source" &&
								!operation.inputs.some(
									(input) =>
										input.kind === "source" &&
										input.id === record.sourceId &&
										input.revision === citationSource.audit.revision,
								)
							) {
								issues.push({
									code: "STALE_CITATION_PROVIDER_SNAPSHOT",
									path: `${path}#verificationSources`,
									message: "Citation provider Operation does not reference the current source snapshot",
								});
							}
						}
					}
					break;
				case "research_question_version":
					if (record.supersedesResearchQuestionVersionId !== null) {
						requireRecord(
							"research_question_version",
							record.supersedesResearchQuestionVersionId,
							`${path}#supersedesResearchQuestionVersionId`,
						);
						const previous = records
							.get("research_question_version")
							?.get(record.supersedesResearchQuestionVersionId);
						if (
							previous?.kind === "research_question_version" &&
							(previous.questionSeriesId !== record.questionSeriesId || previous.version >= record.version)
						) {
							issues.push({
								code: "INVALID_QUESTION_VERSION_CHAIN",
								path: `${path}#supersedesResearchQuestionVersionId`,
								message: "Question versions must advance within the same series",
							});
						}
					}
					break;
				case "concept":
					if (record.supersedesConceptId !== null)
						requireRecord("concept", record.supersedesConceptId, `${path}#supersedesConceptId`);
					break;
				case "theory_relation":
					if (record.status === "confirmed") {
						requireConfirmedDesign("concept", record.fromConceptId, `${path}#fromConceptId`);
						requireConfirmedDesign("concept", record.toConceptId, `${path}#toConceptId`);
					} else {
						requireRecord("concept", record.fromConceptId, `${path}#fromConceptId`);
						requireRecord("concept", record.toConceptId, `${path}#toConceptId`);
					}
					if (record.supersedesTheoryRelationId !== null)
						requireRecord(
							"theory_relation",
							record.supersedesTheoryRelationId,
							`${path}#supersedesTheoryRelationId`,
						);
					break;
				case "design_decision":
					if (record.supersedesDesignDecisionId !== null)
						requireRecord(
							"design_decision",
							record.supersedesDesignDecisionId,
							`${path}#supersedesDesignDecisionId`,
						);
					break;
				case "protocol":
					if (record.status === "confirmed") {
						requireConfirmedDesign(
							"research_question_version",
							record.researchQuestionVersionId,
							`${path}#researchQuestionVersionId`,
						);
						for (const decisionId of record.decisionIds)
							requireConfirmedDesign("design_decision", decisionId, `${path}#decisionIds`);
						for (const conceptId of record.conceptIds)
							requireConfirmedDesign("concept", conceptId, `${path}#conceptIds`);
						for (const relationId of record.theoryRelationIds)
							requireConfirmedDesign("theory_relation", relationId, `${path}#theoryRelationIds`);
					} else {
						requireRecord(
							"research_question_version",
							record.researchQuestionVersionId,
							`${path}#researchQuestionVersionId`,
						);
						for (const decisionId of record.decisionIds)
							requireRecord("design_decision", decisionId, `${path}#decisionIds`);
						for (const conceptId of record.conceptIds) requireRecord("concept", conceptId, `${path}#conceptIds`);
						for (const relationId of record.theoryRelationIds)
							requireRecord("theory_relation", relationId, `${path}#theoryRelationIds`);
					}
					if (record.supersedesProtocolId !== null)
						requireRecord("protocol", record.supersedesProtocolId, `${path}#supersedesProtocolId`);
					break;
				case "dataset":
					await requireFile(record.sourceFile, `${path}#sourceFile`);
					for (const [position, variableId] of record.variableIds.entries()) {
						requireRecord("variable", variableId, `${path}#variableIds`);
						const variable = records.get("variable")?.get(variableId);
						if (
							variable?.kind === "variable" &&
							(variable.datasetId !== record.datasetId || variable.position !== position)
						) {
							issues.push({
								code: "DATASET_VARIABLE_MISMATCH",
								path: `${path}#variableIds`,
								message: `Variable ${variableId} does not match dataset column ${position}`,
							});
						}
					}
					break;
				case "variable": {
					requireRecord("dataset", record.datasetId, `${path}#datasetId`);
					const dataset = records.get("dataset")?.get(record.datasetId);
					if (dataset?.kind === "dataset" && dataset.variableIds[record.position] !== record.variableId) {
						issues.push({
							code: "VARIABLE_DATASET_MISMATCH",
							path: `${path}#datasetId`,
							message: "Variable is not indexed at its declared dataset position",
						});
					}
					break;
				}
				case "analysis_specification":
					if (record.protocolId !== null) {
						if (record.status === "confirmed")
							requireConfirmedDesign("protocol", record.protocolId, `${path}#protocolId`);
						else requireRecord("protocol", record.protocolId, `${path}#protocolId`);
					}
					for (const datasetId of record.inputDatasetIds)
						requireRecord("dataset", datasetId, `${path}#inputDatasetIds`);
					await requireFile(record.script, `${path}#script`);
					if (record.environmentFile !== null)
						await requireFile(record.environmentFile, `${path}#environmentFile`);
					for (const inputFile of record.inputFiles) await requireFile(inputFile, `${path}#inputFiles`);
					break;
				case "qualitative_material":
					await requireFile(record.sourceFile, `${path}#sourceFile`);
					break;
				case "qualitative_segment": {
					requireRecord("qualitative_material", record.qualitativeMaterialId, `${path}#qualitativeMaterialId`);
					const material = records.get("qualitative_material")?.get(record.qualitativeMaterialId);
					if (material?.kind === "qualitative_material") {
						try {
							let text = materialTexts.get(material.qualitativeMaterialId);
							if (text === undefined) {
								text = await readFile(await resolveProjectPath(opened.root, material.sourceFile.path), "utf8");
								materialTexts.set(material.qualitativeMaterialId, text);
							}
							if (
								text.slice(record.locator.charStart, record.locator.charEnd) !== record.text ||
								hashBytes(record.text).value !== record.locator.anchorHash.value
							) {
								throw new TypeError("segment text or anchor no longer matches the source material");
							}
						} catch (error) {
							issues.push({
								code: "INVALID_QUALITATIVE_LOCATOR",
								path: `${path}#locator`,
								message: error instanceof Error ? error.message : "Qualitative locator is invalid",
							});
						}
					}
					break;
				}
				case "codebook_version":
					if (record.supersedesCodebookVersionId !== null) {
						requireRecord(
							"codebook_version",
							record.supersedesCodebookVersionId,
							`${path}#supersedesCodebookVersionId`,
						);
						const previous = records.get("codebook_version")?.get(record.supersedesCodebookVersionId);
						if (
							previous?.kind === "codebook_version" &&
							(previous.codebookSeriesId !== record.codebookSeriesId || previous.version + 1 !== record.version)
						) {
							issues.push({
								code: "INVALID_CODEBOOK_VERSION_CHAIN",
								path: `${path}#supersedesCodebookVersionId`,
								message: "Codebook versions must advance by one within the same series",
							});
						}
					}
					break;
				case "model_suggestion": {
					requireRecord("qualitative_segment", record.qualitativeSegmentId, `${path}#qualitativeSegmentId`);
					requireRecord("codebook_version", record.codebookVersionId, `${path}#codebookVersionId`);
					requireRecord("operation", record.provenance.operationId, `${path}#provenance.operationId`);
					const codebook = records.get("codebook_version")?.get(record.codebookVersionId);
					if (
						codebook?.kind === "codebook_version" &&
						record.suggestedCodeIds.some((id) => !codebook.codes.some(({ codeId }) => codeId === id))
					) {
						issues.push({
							code: "UNKNOWN_SUGGESTED_CODE",
							path: `${path}#suggestedCodeIds`,
							message: "Model suggestion references a code outside its codebook version",
						});
					}
					break;
				}
				case "coding_decision": {
					requireRecord("qualitative_segment", record.qualitativeSegmentId, `${path}#qualitativeSegmentId`);
					requireRecord("codebook_version", record.codebookVersionId, `${path}#codebookVersionId`);
					if (record.modelSuggestionId !== null)
						requireRecord("model_suggestion", record.modelSuggestionId, `${path}#modelSuggestionId`);
					if (record.supersedesCodingDecisionId !== null)
						requireRecord(
							"coding_decision",
							record.supersedesCodingDecisionId,
							`${path}#supersedesCodingDecisionId`,
						);
					const codebook = records.get("codebook_version")?.get(record.codebookVersionId);
					if (
						codebook?.kind === "codebook_version" &&
						record.assignedCodeIds.some((id) => !codebook.codes.some(({ codeId }) => codeId === id))
					) {
						issues.push({
							code: "UNKNOWN_ASSIGNED_CODE",
							path: `${path}#assignedCodeIds`,
							message: "Coding decision references a code outside its codebook version",
						});
					}
					if (record.modelSuggestionId !== null) {
						const suggestion = records.get("model_suggestion")?.get(record.modelSuggestionId);
						if (
							suggestion?.kind === "model_suggestion" &&
							(suggestion.qualitativeSegmentId !== record.qualitativeSegmentId ||
								suggestion.codebookVersionId !== record.codebookVersionId)
						) {
							issues.push({
								code: "CODING_SUGGESTION_MISMATCH",
								path: `${path}#modelSuggestionId`,
								message: "Coding decision and model suggestion use different segment or codebook versions",
							});
						}
					}
					if (record.supersedesCodingDecisionId !== null) {
						const previous = records.get("coding_decision")?.get(record.supersedesCodingDecisionId);
						if (
							previous?.kind === "coding_decision" &&
							(previous.qualitativeSegmentId !== record.qualitativeSegmentId ||
								previous.codebookVersionId !== record.codebookVersionId)
						) {
							issues.push({
								code: "CODING_DECISION_SUCCESSION_MISMATCH",
								path: `${path}#supersedesCodingDecisionId`,
								message: "Coding decision revisions must retain the segment and codebook version",
							});
						}
					}
					break;
				}
				case "theme_synthesis": {
					requireRecord("codebook_version", record.codebookVersionId, `${path}#codebookVersionId`);
					for (const decisionId of record.codingDecisionIds)
						requireRecord("coding_decision", decisionId, `${path}#codingDecisionIds`);
					for (const theme of record.themes)
						for (const segmentId of theme.qualitativeSegmentIds)
							requireRecord("qualitative_segment", segmentId, `${path}#themes`);
					if (record.supersedesThemeSynthesisId !== null)
						requireRecord(
							"theme_synthesis",
							record.supersedesThemeSynthesisId,
							`${path}#supersedesThemeSynthesisId`,
						);
					const themeCodebook = records.get("codebook_version")?.get(record.codebookVersionId);
					const availableCodes = new Set(
						themeCodebook?.kind === "codebook_version" ? themeCodebook.codes.map(({ codeId }) => codeId) : [],
					);
					const linkedSegments = new Set<string>();
					for (const decisionId of record.codingDecisionIds) {
						const decision = records.get("coding_decision")?.get(decisionId);
						if (decision?.kind !== "coding_decision") continue;
						linkedSegments.add(decision.qualitativeSegmentId);
						if (decision.codebookVersionId !== record.codebookVersionId) {
							issues.push({
								code: "THEME_CODING_VERSION_MISMATCH",
								path: `${path}#codingDecisionIds`,
								message: "Theme synthesis and coding decisions must use the same codebook version",
							});
						}
					}
					for (const theme of record.themes) {
						if (
							theme.codeIds.some((id) => !availableCodes.has(id)) ||
							theme.qualitativeSegmentIds.some((id) => !linkedSegments.has(id))
						) {
							issues.push({
								code: "THEME_EVIDENCE_LINK_MISMATCH",
								path: `${path}#themes`,
								message: "Themes must use declared codes and segments with human coding decisions",
							});
						}
					}
					if (record.supersedesThemeSynthesisId !== null) {
						const previous = records.get("theme_synthesis")?.get(record.supersedesThemeSynthesisId);
						if (previous?.kind === "theme_synthesis" && previous.codebookVersionId !== record.codebookVersionId) {
							issues.push({
								code: "THEME_SUCCESSION_MISMATCH",
								path: `${path}#supersedesThemeSynthesisId`,
								message: "Theme synthesis revisions must retain the codebook version",
							});
						}
					}
					break;
				}
				case "manuscript": {
					for (const sectionId of record.sectionIds) requireRecord("section", sectionId, `${path}#sectionIds`);
					for (const claimOccurrenceId of record.claimOccurrenceIds)
						requireRecord("claim_occurrence", claimOccurrenceId, `${path}#claimOccurrenceIds`);
					for (const entry of record.bibliography) requireRecord("source", entry.sourceId, `${path}#bibliography`);
					if (record.supersedesManuscriptId !== null) {
						requireRecord("manuscript", record.supersedesManuscriptId, `${path}#supersedesManuscriptId`);
						const previous = records.get("manuscript")?.get(record.supersedesManuscriptId);
						if (
							previous?.kind === "manuscript" &&
							(previous.manuscriptSeriesId !== record.manuscriptSeriesId ||
								previous.paperType !== record.paperType ||
								previous.version + 1 !== record.version)
						) {
							issues.push({
								code: "INVALID_MANUSCRIPT_VERSION_CHAIN",
								path: `${path}#supersedesManuscriptId`,
								message: "Manuscript revisions must advance by one in the same series and paper type",
							});
						}
					}
					const manuscriptSections = record.sectionIds
						.map((sectionId) => records.get("section")?.get(sectionId))
						.filter((section) => section?.kind === "section");
					const manuscriptOccurrences = record.claimOccurrenceIds
						.map((claimOccurrenceId) => records.get("claim_occurrence")?.get(claimOccurrenceId))
						.filter((occurrence) => occurrence?.kind === "claim_occurrence");
					if (
						manuscriptSections.length === record.sectionIds.length &&
						manuscriptOccurrences.length === record.claimOccurrenceIds.length
					) {
						const reconstructed = manuscriptContentHash({
							title: record.title,
							paperType: record.paperType,
							abstract: record.abstract,
							bibliography: record.bibliography,
							methodRecords: record.methodRecords,
							sections: manuscriptSections.map((section) => ({
								sectionKey: section.sectionKey,
								title: section.title,
								order: section.order,
								content: section.content,
								occurrences: manuscriptOccurrences
									.filter((occurrence) => occurrence.sectionId === section.sectionId)
									.map((occurrence) => ({
										claimId: occurrence.claimId,
										text: occurrence.text,
										charStart: occurrence.charStart,
										charEnd: occurrence.charEnd,
										core: occurrence.core,
										citationKeys: occurrence.citationKeys,
										evidenceIds: occurrence.evidenceIds,
									})),
							})),
						});
						if (reconstructed.value !== record.contentHash.value) {
							issues.push({
								code: "MANUSCRIPT_CONTENT_HASH_MISMATCH",
								path: `${path}#contentHash`,
								message: "Manuscript content hash does not match its canonical sections and references",
							});
						}
					}
					break;
				}
				case "section": {
					requireRecord("manuscript", record.manuscriptId, `${path}#manuscriptId`);
					const manuscript = records.get("manuscript")?.get(record.manuscriptId);
					if (
						manuscript?.kind === "manuscript" &&
						(!manuscript.sectionIds.includes(record.sectionId) ||
							record.contentHash.value !== hashBytes(record.content).value ||
							record.wordCount !== countManuscriptWords(record.content))
					) {
						issues.push({
							code: "INVALID_MANUSCRIPT_SECTION",
							path,
							message: "Section index, content hash, or word count does not match its manuscript snapshot",
						});
					}
					break;
				}
				case "claim_occurrence": {
					requireRecord("manuscript", record.manuscriptId, `${path}#manuscriptId`);
					requireRecord("section", record.sectionId, `${path}#sectionId`);
					requireRecord("claim", record.claimId, `${path}#claimId`);
					for (const evidenceId of record.evidenceIds)
						requireRecord("evidence", evidenceId, `${path}#evidenceIds`);
					const manuscript = records.get("manuscript")?.get(record.manuscriptId);
					const section = records.get("section")?.get(record.sectionId);
					const claim = records.get("claim")?.get(record.claimId);
					if (
						manuscript?.kind === "manuscript" &&
						section?.kind === "section" &&
						claim?.kind === "claim" &&
						(!manuscript.claimOccurrenceIds.includes(record.claimOccurrenceId) ||
							section.manuscriptId !== record.manuscriptId ||
							section.content.slice(record.charStart, record.charEnd) !== record.text ||
							hashBytes(record.text).value !== record.anchorHash.value ||
							record.evidenceIds.some(
								(evidenceId) => !claim.evidenceLinks.some((link) => link.evidenceId === evidenceId),
							))
					) {
						issues.push({
							code: "INVALID_CLAIM_OCCURRENCE",
							path,
							message: "ClaimOccurrence locator, anchor, manuscript index, or evidence link is invalid",
						});
					}
					break;
				}
				case "review_finding": {
					requireRecord("manuscript", record.manuscriptId, `${path}#manuscriptId`);
					if (record.sectionId !== null) requireRecord("section", record.sectionId, `${path}#sectionId`);
					if (record.claimOccurrenceId !== null)
						requireRecord("claim_occurrence", record.claimOccurrenceId, `${path}#claimOccurrenceId`);
					const section = record.sectionId === null ? undefined : records.get("section")?.get(record.sectionId);
					const occurrence =
						record.claimOccurrenceId === null
							? undefined
							: records.get("claim_occurrence")?.get(record.claimOccurrenceId);
					const fingerprint = reviewFindingFingerprint(record.manuscriptId, {
						reviewerRole: record.reviewerRole,
						findingType: record.findingType,
						severity: record.severity,
						title: record.title,
						message: record.message,
						sectionId: record.sectionId,
						claimOccurrenceId: record.claimOccurrenceId,
					});
					if (
						(section?.kind === "section" && section.manuscriptId !== record.manuscriptId) ||
						(occurrence?.kind === "claim_occurrence" && occurrence.manuscriptId !== record.manuscriptId) ||
						fingerprint.value !== record.fingerprint.value
					) {
						issues.push({
							code: "INVALID_REVIEW_FINDING",
							path,
							message: "Review finding target or deterministic fingerprint is invalid",
						});
					}
					break;
				}
				case "revision_decision": {
					requireRecord("manuscript", record.toManuscriptId, `${path}#toManuscriptId`);
					if (record.fromManuscriptId !== null)
						requireRecord("manuscript", record.fromManuscriptId, `${path}#fromManuscriptId`);
					if (record.reviewFindingId !== null)
						requireRecord("review_finding", record.reviewFindingId, `${path}#reviewFindingId`);
					const target = records.get("manuscript")?.get(record.toManuscriptId);
					const source =
						record.fromManuscriptId === null
							? undefined
							: records.get("manuscript")?.get(record.fromManuscriptId);
					const finding =
						record.reviewFindingId === null
							? undefined
							: records.get("review_finding")?.get(record.reviewFindingId);
					if (
						target?.kind === "manuscript" &&
						(target.manuscriptSeriesId !== record.manuscriptSeriesId ||
							(source?.kind === "manuscript" && source.manuscriptSeriesId !== record.manuscriptSeriesId) ||
							(finding?.kind === "review_finding" && finding.manuscriptId !== record.toManuscriptId))
					) {
						issues.push({
							code: "INVALID_REVISION_DECISION",
							path,
							message: "Revision decision series or review target is inconsistent",
						});
					}
					break;
				}
				case "disclosure":
					requireRecord("manuscript", record.manuscriptId, `${path}#manuscriptId`);
					break;
				case "submission_gate_report": {
					requireRecord("manuscript", record.manuscriptId, `${path}#manuscriptId`);
					if (record.approvalId !== null) requireRecord("approval", record.approvalId, `${path}#approvalId`);
					const approval =
						record.approvalId === null ? undefined : records.get("approval")?.get(record.approvalId);
					const validApproval =
						approval?.kind === "approval" &&
						approval.decision === "approved" &&
						approval.actionClass === "publish_or_submit" &&
						approval.actionName === "research.manuscript.mark_submission_candidate" &&
						approval.dataEgress.recordRefs.some(
							({ kind, id }) => kind === "manuscript" && id === record.manuscriptId,
						);
					if (
						(record.approvalId !== null && !validApproval) ||
						(record.passed &&
							(!validApproval ||
								record.publishability !== "submission_candidate" ||
								!record.warningsAccepted ||
								record.checks.some(({ status }) => status === "failed"))) ||
						(!record.passed && record.publishability === "submission_candidate")
					) {
						issues.push({
							code: "INVALID_SUBMISSION_GATE_REPORT",
							path,
							message: "Submission gate state or approval is inconsistent with its manuscript",
						});
					}
					break;
				}
				case "adapter_export_profile":
					break;
				case "external_item_link":
					requireRecord("adapter_export_profile", record.adapterExportProfileId, `${path}#adapterExportProfileId`);
					break;
				case "monitor_subscription": {
					if (record.supersedesMonitorSubscriptionId !== null) {
						requireRecord(
							"monitor_subscription",
							record.supersedesMonitorSubscriptionId,
							`${path}#supersedesMonitorSubscriptionId`,
						);
						const previous = records.get("monitor_subscription")?.get(record.supersedesMonitorSubscriptionId);
						if (
							previous?.kind === "monitor_subscription" &&
							(previous.monitorSubscriptionSeriesId !== record.monitorSubscriptionSeriesId ||
								previous.version + 1 !== record.version)
						) {
							issues.push({
								code: "INVALID_MONITOR_SUBSCRIPTION_CHAIN",
								path,
								message: "Monitor subscription series or version chain is invalid",
							});
						}
					}
					if (record.lastSuccessfulRunId !== null) {
						requireRecord("monitor_run", record.lastSuccessfulRunId, `${path}#lastSuccessfulRunId`);
						const run = records.get("monitor_run")?.get(record.lastSuccessfulRunId);
						if (
							run?.kind === "monitor_run" &&
							(run.status === "failed_retryable" ||
								run.nextMonitorSubscriptionId !== record.monitorSubscriptionId ||
								run.monitorSubscriptionId !== record.supersedesMonitorSubscriptionId ||
								hashCanonicalJson(run.cursorAfter).value !== hashCanonicalJson(record.cursor).value)
						) {
							issues.push({
								code: "INVALID_MONITOR_CHECKPOINT",
								path: `${path}#lastSuccessfulRunId`,
								message: "Monitor checkpoint does not match the run that created it",
							});
						}
					}
					break;
				}
				case "monitor_run": {
					requireRecord("monitor_subscription", record.monitorSubscriptionId, `${path}#monitorSubscriptionId`);
					requireRecord("operation", record.operationId, `${path}#operationId`);
					if (record.retryTaskId !== null) requireRecord("task", record.retryTaskId, `${path}#retryTaskId`);
					if (record.nextMonitorSubscriptionId !== null)
						requireRecord(
							"monitor_subscription",
							record.nextMonitorSubscriptionId,
							`${path}#nextMonitorSubscriptionId`,
						);
					for (const sourceId of [...record.createdSourceIds, ...record.reusedSourceIds])
						requireRecord("source", sourceId, `${path}#sourceIds`);
					const subscription = records.get("monitor_subscription")?.get(record.monitorSubscriptionId);
					if (
						subscription?.kind === "monitor_subscription" &&
						(subscription.queryHash.value !== record.queryHash.value ||
							hashCanonicalJson(subscription.cursor).value !== hashCanonicalJson(record.cursorBefore).value)
					) {
						issues.push({
							code: "MONITOR_RUN_INPUT_MISMATCH",
							path,
							message: "Monitor run query or input cursor differs from its subscription revision",
						});
					}
					if (record.nextMonitorSubscriptionId !== null) {
						const next = records.get("monitor_subscription")?.get(record.nextMonitorSubscriptionId);
						if (
							next?.kind === "monitor_subscription" &&
							(next.supersedesMonitorSubscriptionId !== record.monitorSubscriptionId ||
								next.lastSuccessfulRunId !== record.monitorRunId ||
								hashCanonicalJson(next.cursor).value !== hashCanonicalJson(record.cursorAfter).value)
						) {
							issues.push({
								code: "INVALID_MONITOR_CHECKPOINT",
								path: `${path}#nextMonitorSubscriptionId`,
								message: "Monitor run does not match its next checkpoint revision",
							});
						}
					}
					if (
						record.status === "failed_retryable" &&
						hashCanonicalJson(record.cursorBefore).value !== hashCanonicalJson(record.cursorAfter).value
					) {
						issues.push({
							code: "FAILED_MONITOR_CURSOR_ADVANCED",
							path: `${path}#cursorAfter`,
							message: "A failed monitor run cannot advance its cursor",
						});
					}
					break;
				}
				case "adapter_registration":
				case "exchange_record":
				case "model_route_decision":
					break;
				case "collaboration_merge":
					for (const ref of record.applied) requireRecord(ref.kind, ref.id, `${path}#applied`);
					for (const ref of record.skipped) requireRecord(ref.kind, ref.id, `${path}#skipped`);
					break;
				case "task":
					for (const dependencyId of record.dependencyTaskIds)
						requireRecord("task", dependencyId, `${path}#dependencyTaskIds`);
					for (const operationId of record.operationIds)
						requireRecord("operation", operationId, `${path}#operationIds`);
					break;
				case "operation":
					if (record.taskId !== null) requireRecord("task", record.taskId, `${path}#taskId`);
					for (const approvalId of record.approvalIds)
						requireRecord("approval", approvalId, `${path}#approvalIds`);
					break;
				case "analysis_run":
					requireRecord("task", record.taskId, `${path}#taskId`);
					requireRecord(
						"analysis_specification",
						record.analysisSpecificationId,
						`${path}#analysisSpecificationId`,
					);
					for (const input of record.inputs) await requireFile(input, `${path}#inputs`);
					for (const output of record.outputs) await requireFile(output, `${path}#outputs`);
					for (const log of record.logs) await requireFile(log, `${path}#logs`);
					{
						const specification = records.get("analysis_specification")?.get(record.analysisSpecificationId);
						if (
							specification?.kind === "analysis_specification" &&
							(specification.runtime !== record.runtime.kind ||
								!fileMatches(specification.script, record.script))
						) {
							issues.push({
								code: "ANALYSIS_SPECIFICATION_MISMATCH",
								path: `${path}#analysisSpecificationId`,
								message: "Analysis run runtime or script differs from its specification",
							});
						}
					}
					break;
				case "artifact": {
					requireRecord("operation", record.generator.operationId, `${path}#generator.operationId`);
					if (record.supersedesArtifactId !== null)
						requireRecord("artifact", record.supersedesArtifactId, `${path}#supersedesArtifactId`);
					const generator = records.get("operation")?.get(record.generator.operationId);
					if (
						generator?.kind !== "operation" ||
						!["succeeded", "partially_succeeded"].includes(generator.status) ||
						!record.sourceRecords.every((sourceRef) =>
							generator.inputs.some(
								(input) =>
									input.kind === sourceRef.kind &&
									input.id === sourceRef.id &&
									input.revision === sourceRef.revision,
							),
						) ||
						!record.sourceFiles.every((sourceFile) =>
							generator.inputFiles.some((inputFile) => fileMatches(inputFile, sourceFile)),
						) ||
						!generator.outputs.some(
							(output) =>
								output.kind === "artifact" &&
								output.id === record.artifactId &&
								output.revision === record.audit.revision,
						) ||
						!generator.outputFiles.some((file) => fileMatches(file, record.outputFile))
					) {
						issues.push({
							code: "INVALID_ARTIFACT_OPERATION_PROVENANCE",
							path: `${path}#generator.operationId`,
							message: "Artifact generator Operation does not reference its inputs and outputs",
						});
					}
					if (!supersededArtifactIds.has(record.artifactId)) {
						try {
							const outputPath = await resolveProjectPath(opened.root, record.outputFile.path);
							const outputStat = await stat(outputPath);
							const outputHash = await hashFile(outputPath);
							if (
								record.outputFile.hash === null ||
								record.outputFile.bytes === null ||
								outputStat.size !== record.outputFile.bytes ||
								outputHash.value !== record.outputFile.hash.value
							) {
								throw new TypeError("artifact output does not match its FileRef");
							}
						} catch (error) {
							issues.push({
								code: "INVALID_ARTIFACT_OUTPUT",
								path: `${path}#outputFile`,
								message: error instanceof Error ? error.message : "Artifact output is invalid",
							});
						}
					}
					for (const sourceFile of record.sourceFiles) {
						try {
							const sourcePath = await resolveProjectPath(opened.root, sourceFile.path);
							const sourceStat = await stat(sourcePath);
							const sourceHash = await hashFile(sourcePath);
							if (
								sourceFile.hash === null ||
								sourceFile.bytes === null ||
								sourceStat.size !== sourceFile.bytes ||
								sourceHash.value !== sourceFile.hash.value
							) {
								throw new TypeError("artifact source file does not match its FileRef");
							}
						} catch (error) {
							issues.push({
								code: "INVALID_ARTIFACT_SOURCE_FILE",
								path: `${path}#sourceFiles`,
								message: error instanceof Error ? error.message : "Artifact source file is invalid",
							});
						}
					}
					break;
				}
				case "approval":
					if (record.taskId !== null) requireRecord("task", record.taskId, `${path}#taskId`);
					if (record.operationId !== null) requireRecord("operation", record.operationId, `${path}#operationId`);
					break;
			}
		}
	}

	const pendingTransactionIds = await listPendingProjectTransactions(opened.root);
	for (const transactionId of pendingTransactionIds) {
		issues.push({
			code: "PENDING_TRANSACTION",
			path: `.research/transactions/pending/${transactionId}`,
			message: "Project has an interrupted transaction",
		});
	}
	return {
		valid: issues.length === 0,
		projectId: opened.manifest.projectId,
		revision: opened.manifest.revision,
		checkedRecords,
		pendingTransactionIds,
		issues,
	};
}
