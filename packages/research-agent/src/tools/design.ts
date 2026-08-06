// SPDX-License-Identifier: Apache-2.0

import type {
	ConceptRecord,
	DesignDecision,
	DesignProvenanceRef,
	OperationRecord,
	ProtocolRecord,
	RecordKind,
	ResearchQuestionVersion,
	ResearchResult,
	TheoryRelation,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { type ProjectRecord, projectRecordRevision } from "../project/record-index.ts";
import { createRecord, readRecord, updateRecord } from "../project/records.ts";
import { commitProjectTransaction } from "../project/transactions.ts";

export type DesignRecord = ResearchQuestionVersion | ConceptRecord | TheoryRelation | DesignDecision | ProtocolRecord;
export type DesignRecordKind = DesignRecord["kind"];

export type ResearchQuestionVersionDraft = Omit<
	ResearchQuestionVersion,
	"kind" | "schemaVersion" | "researchQuestionVersionId" | "status" | "confirmation" | "audit"
>;
export type ConceptRecordDraft = Omit<
	ConceptRecord,
	"kind" | "schemaVersion" | "conceptId" | "status" | "confirmation" | "audit"
>;
export type TheoryRelationDraft = Omit<
	TheoryRelation,
	"kind" | "schemaVersion" | "theoryRelationId" | "status" | "confirmation" | "audit"
>;
export type DesignDecisionDraft = Omit<
	DesignDecision,
	"kind" | "schemaVersion" | "designDecisionId" | "status" | "confirmation" | "audit"
>;
export type ProtocolRecordDraft = Omit<
	ProtocolRecord,
	"kind" | "schemaVersion" | "protocolId" | "status" | "confirmation" | "audit"
>;

export type DesignDraft =
	| { kind: "research_question_version"; value: ResearchQuestionVersionDraft }
	| { kind: "concept"; value: ConceptRecordDraft }
	| { kind: "theory_relation"; value: TheoryRelationDraft }
	| { kind: "design_decision"; value: DesignDecisionDraft }
	| { kind: "protocol"; value: ProtocolRecordDraft };

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

export function isDesignRecord(record: ProjectRecord): record is DesignRecord {
	return ["research_question_version", "concept", "theory_relation", "design_decision", "protocol"].includes(
		record.kind,
	);
}

async function operationRecord(projectRoot: string, operationId: string): Promise<OperationRecord> {
	const result = await readRecord(projectRoot, "operation", operationId);
	if (!result.ok || result.value.kind !== "operation" || result.value.status !== "running") {
		throw new TypeError(`Design operation ${operationId} is not running`);
	}
	return result.value;
}

async function requireRecord(
	projectRoot: string,
	kind: RecordKind,
	id: string,
	revision: number | null = null,
): Promise<ProjectRecord> {
	const result = await readRecord(projectRoot, kind, id);
	if (!result.ok) throw new TypeError(result.errors[0].message);
	if (revision !== null && projectRecordRevision(result.value) < revision) {
		throw new TypeError(`Design provenance references future ${kind} ${id} revision ${revision}`);
	}
	return result.value;
}

async function validateBasis(projectRoot: string, provenance: readonly DesignProvenanceRef[]): Promise<void> {
	for (const ref of provenance) await requireRecord(projectRoot, ref.kind, ref.id, ref.revision);
}

async function validateDependencies(projectRoot: string, record: DesignRecord, confirmed: boolean): Promise<void> {
	await validateBasis(projectRoot, record.basis.provenance);
	const requireDesign = async (kind: DesignRecordKind, id: string): Promise<DesignRecord> => {
		const dependency = await requireRecord(projectRoot, kind, id);
		if (!isDesignRecord(dependency)) throw new TypeError(`${kind} ${id} is not a design record`);
		if (confirmed && dependency.status !== "confirmed") {
			throw new TypeError(`${kind} ${id} must be confirmed first`);
		}
		return dependency;
	};
	if (record.kind === "research_question_version" && record.supersedesResearchQuestionVersionId !== null) {
		const previous = await requireDesign("research_question_version", record.supersedesResearchQuestionVersionId);
		if (
			previous.kind !== "research_question_version" ||
			previous.questionSeriesId !== record.questionSeriesId ||
			previous.version >= record.version
		) {
			throw new TypeError("Question versions must advance within the same series");
		}
	}
	if (record.kind === "concept" && record.supersedesConceptId !== null) {
		await requireDesign("concept", record.supersedesConceptId);
	}
	if (record.kind === "theory_relation") {
		await requireDesign("concept", record.fromConceptId);
		await requireDesign("concept", record.toConceptId);
		if (record.supersedesTheoryRelationId !== null) {
			await requireDesign("theory_relation", record.supersedesTheoryRelationId);
		}
	}
	if (record.kind === "design_decision" && record.supersedesDesignDecisionId !== null) {
		await requireDesign("design_decision", record.supersedesDesignDecisionId);
	}
	if (record.kind === "protocol") {
		await requireDesign("research_question_version", record.researchQuestionVersionId);
		for (const id of record.decisionIds) await requireDesign("design_decision", id);
		for (const id of record.conceptIds) await requireDesign("concept", id);
		for (const id of record.theoryRelationIds) await requireDesign("theory_relation", id);
		if (record.supersedesProtocolId !== null) await requireDesign("protocol", record.supersedesProtocolId);
	}
}

function audit(operationId: string) {
	const now = new Date().toISOString();
	return {
		createdAt: now,
		updatedAt: now,
		revision: 0,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

function basisWithOperation(basis: DesignRecord["basis"], operation: OperationRecord): DesignRecord["basis"] {
	const provenance = [
		...basis.provenance,
		{ kind: "operation" as const, id: operation.operationId, revision: operation.audit.revision },
	];
	return {
		...basis,
		provenance: [...new Map(provenance.map((ref) => [`${ref.kind}:${ref.id}:${ref.revision}`, ref])).values()],
	};
}

function draftRecord(draft: DesignDraft, operation: OperationRecord): DesignRecord {
	const common = {
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		status: "draft" as const,
		confirmation: { decision: null, decidedAt: null, decidedBy: null, note: null },
		audit: audit(operation.operationId),
	};
	const value = { ...draft.value, basis: basisWithOperation(draft.value.basis, operation) };
	switch (draft.kind) {
		case "research_question_version":
			return {
				...value,
				...common,
				kind: draft.kind,
				researchQuestionVersionId: createOpaqueId(draft.kind),
			} as ResearchQuestionVersion;
		case "concept":
			return { ...value, ...common, kind: draft.kind, conceptId: createOpaqueId(draft.kind) } as ConceptRecord;
		case "theory_relation":
			return {
				...value,
				...common,
				kind: draft.kind,
				theoryRelationId: createOpaqueId(draft.kind),
			} as TheoryRelation;
		case "design_decision":
			return {
				...value,
				...common,
				kind: draft.kind,
				designDecisionId: createOpaqueId(draft.kind),
			} as DesignDecision;
		case "protocol":
			return { ...value, ...common, kind: draft.kind, protocolId: createOpaqueId(draft.kind) } as ProtocolRecord;
	}
}

async function readDesignRecord(projectRoot: string, kind: DesignRecordKind, id: string): Promise<DesignRecord> {
	const result = await readRecord(projectRoot, kind, id);
	if (!result.ok) throw new TypeError(result.errors[0].message);
	if (!isDesignRecord(result.value)) throw new TypeError(`${kind} ${id} is not a design record`);
	return result.value;
}

export async function commitDesignDraft(
	projectRoot: string,
	operationId: string,
	draft: DesignDraft,
): Promise<ResearchResult<DesignRecord>> {
	try {
		const operation = await operationRecord(projectRoot, operationId);
		const record = draftRecord(draft, operation);
		await validateDependencies(projectRoot, record, false);
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const created = await createRecord(opened.root, record, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		if (!created.ok) return propagatedFailure(created, operationId);
		let current = await openProject(opened.root);
		if (current.compatibility !== "current") throw new TypeError("Research project schema became read-only");
		if (
			record.kind === "research_question_version" &&
			(current.manifest.currentStage === "topic_exploration" ||
				current.manifest.currentStage === "literature_review")
		) {
			await commitProjectTransaction(current.root, {
				expectedRevision: current.manifest.revision,
				writes: [],
				manifest: {
					...current.manifest,
					currentStage: "research_design",
					lastCommittedOperationId: operationId,
					updatedAt: new Date().toISOString(),
					revision: current.manifest.revision + 1,
				},
			});
			current = await openProject(current.root);
			if (current.compatibility !== "current") throw new TypeError("Research project schema became read-only");
		}
		return successResult(await readDesignRecord(current.root, record.kind, created.value.id), operationId);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"DESIGN_DRAFT_INVALID",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Design draft could not be committed",
			operationId,
		);
	}
}

export async function markDesignAwaitingConfirmation(
	projectRoot: string,
	kind: DesignRecordKind,
	id: string,
	expectedRecordRevision: number,
	operationId: string,
): Promise<ResearchResult<DesignRecord>> {
	try {
		const record = await readDesignRecord(projectRoot, kind, id);
		if (record.audit.revision !== expectedRecordRevision) {
			return failureResult(
				"DATA_CONFLICT",
				"DESIGN_REVISION_CONFLICT",
				"data_conflict",
				`Expected ${kind} ${id} revision ${expectedRecordRevision}, found ${record.audit.revision}`,
				operationId,
			);
		}
		if (record.status === "awaiting_confirmation") return successResult(record, operationId);
		if (record.status !== "draft") throw new TypeError(`${kind} ${id} is already ${record.status}`);
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const updated = await updateRecord(opened.root, kind, id, {
			expectedManifestRevision: opened.manifest.revision,
			expectedRecordRevision,
			operationId,
			changes: { status: "awaiting_confirmation" },
		});
		if (!updated.ok) return propagatedFailure(updated, operationId);
		return successResult(await readDesignRecord(opened.root, kind, id), operationId);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"DESIGN_CONFIRMATION_INVALID",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Design confirmation could not be requested",
			operationId,
		);
	}
}

export async function decideDesignRecord(
	projectRoot: string,
	kind: DesignRecordKind,
	id: string,
	expectedRecordRevision: number,
	decision: "confirmed" | "rejected",
	note: string | null,
	operationId: string,
): Promise<ResearchResult<DesignRecord>> {
	try {
		const record = await readDesignRecord(projectRoot, kind, id);
		if (record.audit.revision !== expectedRecordRevision) {
			return failureResult(
				"DATA_CONFLICT",
				"DESIGN_REVISION_CONFLICT",
				"data_conflict",
				`Expected ${kind} ${id} revision ${expectedRecordRevision}, found ${record.audit.revision}`,
				operationId,
			);
		}
		if (record.status !== "awaiting_confirmation") {
			throw new TypeError(`${kind} ${id} is ${record.status}, not awaiting confirmation`);
		}
		const candidate = {
			...record,
			status: decision,
			confirmation: {
				decision,
				decidedAt: new Date().toISOString(),
				decidedBy: "user" as const,
				note,
			},
		};
		if (decision === "confirmed") await validateDependencies(projectRoot, candidate, true);
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const updated = await updateRecord(opened.root, kind, id, {
			expectedManifestRevision: opened.manifest.revision,
			expectedRecordRevision,
			operationId,
			changes: { status: decision, confirmation: candidate.confirmation },
		});
		if (!updated.ok) return propagatedFailure(updated, operationId);
		return successResult(await readDesignRecord(opened.root, kind, id), operationId);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"DESIGN_DECISION_INVALID",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Design decision could not be recorded",
			operationId,
		);
	}
}
