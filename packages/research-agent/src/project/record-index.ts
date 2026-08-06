// SPDX-License-Identifier: Apache-2.0

import { readdir } from "node:fs/promises";
import type {
	HashValue,
	PersistedRecord,
	ProjectRecordSet,
	RecordKind,
	ResearchProjectManifest,
} from "../contracts/schemas.ts";
import { isOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";

export type ProjectRecord = Exclude<PersistedRecord, { kind: "research_project_manifest" }>;

export function projectRecordId(record: ProjectRecord): string {
	switch (record.kind) {
		case "source":
			return record.sourceId;
		case "document":
			return record.documentId;
		case "evidence":
			return record.evidenceId;
		case "claim":
			return record.claimId;
		case "citation_verification":
			return record.verificationId;
		case "research_question_version":
			return record.researchQuestionVersionId;
		case "concept":
			return record.conceptId;
		case "theory_relation":
			return record.theoryRelationId;
		case "design_decision":
			return record.designDecisionId;
		case "protocol":
			return record.protocolId;
		case "dataset":
			return record.datasetId;
		case "variable":
			return record.variableId;
		case "analysis_specification":
			return record.analysisSpecificationId;
		case "qualitative_material":
			return record.qualitativeMaterialId;
		case "qualitative_segment":
			return record.qualitativeSegmentId;
		case "codebook_version":
			return record.codebookVersionId;
		case "model_suggestion":
			return record.modelSuggestionId;
		case "coding_decision":
			return record.codingDecisionId;
		case "theme_synthesis":
			return record.themeSynthesisId;
		case "task":
			return record.taskId;
		case "operation":
			return record.operationId;
		case "analysis_run":
			return record.analysisRunId;
		case "artifact":
			return record.artifactId;
		case "approval":
			return record.approvalId;
	}
}

export function projectRecordRevision(record: ProjectRecord): number {
	return record.kind === "task" ? record.revision : record.audit.revision;
}

export function projectRecordIdField(kind: RecordKind): string {
	switch (kind) {
		case "source":
			return "sourceId";
		case "document":
			return "documentId";
		case "evidence":
			return "evidenceId";
		case "claim":
			return "claimId";
		case "citation_verification":
			return "verificationId";
		case "research_question_version":
			return "researchQuestionVersionId";
		case "concept":
			return "conceptId";
		case "theory_relation":
			return "theoryRelationId";
		case "design_decision":
			return "designDecisionId";
		case "protocol":
			return "protocolId";
		case "dataset":
			return "datasetId";
		case "variable":
			return "variableId";
		case "analysis_specification":
			return "analysisSpecificationId";
		case "qualitative_material":
			return "qualitativeMaterialId";
		case "qualitative_segment":
			return "qualitativeSegmentId";
		case "codebook_version":
			return "codebookVersionId";
		case "model_suggestion":
			return "modelSuggestionId";
		case "coding_decision":
			return "codingDecisionId";
		case "theme_synthesis":
			return "themeSynthesisId";
		case "task":
			return "taskId";
		case "operation":
			return "operationId";
		case "analysis_run":
			return "analysisRunId";
		case "artifact":
			return "artifactId";
		case "approval":
			return "approvalId";
	}
}

export function projectRecordSet(manifest: ResearchProjectManifest, kind: RecordKind): ProjectRecordSet {
	const recordSet = manifest.recordSets.find((entry) => entry.kind === kind);
	if (recordSet === undefined) throw new TypeError(`Project has no record set for ${kind}`);
	return recordSet;
}

export function projectRecordPath(manifest: ResearchProjectManifest, kind: RecordKind, id: string): string {
	if (!isOpaqueId(id, kind)) throw new TypeError(`Invalid ${kind} ID: ${id}`);
	return `${projectRecordSet(manifest, kind).path}/${id}.json`;
}

export async function listProjectRecordIds(
	projectRoot: string,
	manifest: ResearchProjectManifest,
	kind: RecordKind,
): Promise<string[]> {
	const recordSet = projectRecordSet(manifest, kind);
	const ids = (await readdir(await resolveProjectPath(projectRoot, recordSet.path)))
		.filter((fileName) => fileName.endsWith(".json"))
		.map((fileName) => fileName.slice(0, -5));
	for (const id of ids) {
		if (!isOpaqueId(id, kind)) throw new TypeError(`Invalid ${kind} record file: ${id}.json`);
	}
	return ids.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export async function calculateRecordSetIndex(
	projectRoot: string,
	manifest: ResearchProjectManifest,
	kind: RecordKind,
	changes: readonly { id: string; hash: HashValue | null }[] | { id: string; hash: HashValue | null } = [],
): Promise<{ count: number; contentHash: HashValue | null }> {
	const recordSet = projectRecordSet(manifest, kind);
	const directory = await resolveProjectPath(projectRoot, recordSet.path);
	const hashes = new Map<string, HashValue>();
	// ponytail: O(n) hash scan; add a derived index only when project-size benchmarks require it.
	for (const fileName of await readdir(directory)) {
		if (!fileName.endsWith(".json")) continue;
		const id = fileName.slice(0, -5);
		hashes.set(id, await hashFile(await resolveProjectPath(projectRoot, `${recordSet.path}/${fileName}`)));
	}
	const pendingChanges = Array.isArray(changes) ? changes : [changes as { id: string; hash: HashValue | null }];
	for (const change of pendingChanges) {
		if (change.hash === null) hashes.delete(change.id);
		else hashes.set(change.id, change.hash);
	}
	const entries = [...hashes].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return {
		count: entries.length,
		contentHash: entries.length === 0 ? null : hashCanonicalJson(entries.map(([id, hash]) => ({ id, hash }))),
	};
}
