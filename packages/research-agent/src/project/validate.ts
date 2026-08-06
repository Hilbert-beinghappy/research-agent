// SPDX-License-Identifier: Apache-2.0

import { stat } from "node:fs/promises";
import type { FileRef, OperationRecord, RecordKind, RecordRef } from "../contracts/schemas.ts";
import { readParsedPdfDocument, resolveParsedPdfLocator } from "../evidence/query.ts";
import { hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
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
					requireRecord("operation", record.extraction.operationId, `${path}#extraction.operationId`);
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
					const extraction = records.get("operation")?.get(record.extraction.operationId);
					if (extraction?.kind === "operation") {
						if (!operationHasRecord(extraction, "source", record.sourceId)) {
							issues.push({
								code: "MISSING_EVIDENCE_SOURCE_SNAPSHOT",
								path: `${path}#extraction.operationId`,
								message: "Extraction operation does not reference the evidence source",
							});
						}
						if (record.documentId !== null && !operationHasRecord(extraction, "document", record.documentId)) {
							issues.push({
								code: "MISSING_EVIDENCE_DOCUMENT_SNAPSHOT",
								path: `${path}#extraction.operationId`,
								message: "Extraction operation does not reference the evidence document",
							});
						}
						if (
							record.extraction.method === "model_suggested" &&
							(extraction.modelExecution === null ||
								extraction.modelExecution.provider !== record.extraction.modelProvider ||
								extraction.modelExecution.modelId !== record.extraction.modelId ||
								extraction.modelExecution.promptHash.value !== record.extraction.promptHash?.value)
						) {
							issues.push({
								code: "INVALID_EVIDENCE_MODEL_PROVENANCE",
								path: `${path}#extraction`,
								message: "Evidence model provenance conflicts with its extraction operation",
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
								path: `${path}#extraction.operationId`,
								message: "Evidence extraction does not reference the current document snapshot",
							});
						}
						if (
							record.validity === "active" &&
							record.evidenceLevel === "fulltext_located" &&
							record.locator !== null
						) {
							let parsed = parsedDocuments.get(document.documentId);
							if (parsed === undefined) {
								parsed = await readParsedPdfDocument(opened.root, document, record.extraction.operationId);
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
									record.extraction.operationId,
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
				case "claim":
					for (const link of record.evidenceLinks)
						requireRecord("evidence", link.evidenceId, `${path}#evidenceLinks`);
					for (const evidenceId of record.conflictEvidenceIds)
						requireRecord("evidence", evidenceId, `${path}#conflictEvidenceIds`);
					break;
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
