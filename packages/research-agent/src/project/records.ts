// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import type {
	HashValue,
	JsonValue,
	RecordKind,
	RecordRef,
	ResearchProjectManifest,
	ResearchResult,
} from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { isOpaqueId } from "../kernel/identity.ts";
import { hashBytes } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "./open.ts";
import {
	calculateRecordSetIndex,
	type ProjectRecord,
	projectRecordId,
	projectRecordIdField,
	projectRecordPath,
	projectRecordRevision,
} from "./record-index.ts";
import { commitProjectTransaction } from "./transactions.ts";

export interface RecordMutationInput {
	expectedManifestRevision: number;
	operationId: string;
}

export interface UpdateRecordInput extends RecordMutationInput {
	expectedRecordRevision: number;
	changes: Record<string, JsonValue>;
}

export interface DeleteRecordInput extends RecordMutationInput {
	expectedRecordRevision: number;
}

export interface AtomicRecordUpdate {
	kind: RecordKind;
	id: string;
	expectedRecordRevision: number;
	changes: Record<string, JsonValue>;
}

interface LoadedRecord {
	record: ProjectRecord;
	hash: HashValue;
}

interface PreparedRecordChange {
	record: ProjectRecord | null;
	kind: RecordKind;
	id: string;
	content: string | null;
	expectedHash: HashValue | null;
}

function failureFromError<Value>(error: unknown, operationId: string | null): ResearchResult<Value> {
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith("DATA_CONFLICT:") || message.startsWith("Transaction target hash mismatch")) {
		return failureResult("DATA_CONFLICT", "RECORD_DATA_CONFLICT", "data_conflict", message, operationId);
	}
	if (message.startsWith("NOT_FOUND:")) {
		return failureResult("PERMANENT_FAILURE", "RECORD_NOT_FOUND", "not_found", message, operationId);
	}
	if (error instanceof TypeError || message.startsWith("VALIDATION:")) {
		return failureResult("PERMANENT_FAILURE", "RECORD_VALIDATION_FAILED", "validation", message, operationId);
	}
	return failureResult("PERMANENT_FAILURE", "RECORD_REPOSITORY_FAILED", "runtime", message, operationId);
}

async function currentManifest(projectRoot: string, expectedRevision?: number): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot, expectedRevision);
	if (opened.compatibility !== "current") throw new TypeError("Project schema is read-only");
	return opened.manifest;
}

async function loadRecord(
	projectRoot: string,
	manifest: ResearchProjectManifest,
	kind: RecordKind,
	id: string,
): Promise<LoadedRecord> {
	const path = projectRecordPath(manifest, kind, id);
	let text: string;
	try {
		text = await readFile(await resolveProjectPath(projectRoot, path), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`NOT_FOUND: ${kind} ${id}`);
		throw error;
	}
	let raw: unknown;
	try {
		raw = canonicalizeJson(JSON.parse(text));
	} catch (error) {
		throw new TypeError(`VALIDATION: cannot parse ${path}`, { cause: error });
	}
	const validation = validatePersistedRecord(raw);
	if (
		!validation.ok ||
		validation.value.kind === "research_project_manifest" ||
		validation.value.kind !== kind ||
		projectRecordId(validation.value) !== id
	) {
		throw new TypeError(`VALIDATION: invalid ${kind} record ${id}`);
	}
	return { record: validation.value, hash: hashBytes(text) };
}

function updatedRecord(
	loaded: ProjectRecord,
	kind: RecordKind,
	id: string,
	changes: Record<string, JsonValue>,
	operationId: string,
): ProjectRecord {
	const candidate =
		loaded.kind === "task"
			? {
					...loaded,
					...changes,
					kind,
					schemaVersion: loaded.schemaVersion,
					[projectRecordIdField(kind)]: id,
					updatedAt: new Date().toISOString(),
					revision: loaded.revision + 1,
					operationIds: [...new Set([...loaded.operationIds, operationId])],
				}
			: {
					...loaded,
					...changes,
					kind,
					schemaVersion: loaded.schemaVersion,
					[projectRecordIdField(kind)]: id,
					audit: {
						...loaded.audit,
						updatedAt: new Date().toISOString(),
						revision: loaded.audit.revision + 1,
						updatedByOperationId: operationId,
					},
				};
	const validation = validatePersistedRecord(candidate);
	if (
		!validation.ok ||
		validation.value.kind === "research_project_manifest" ||
		validation.value.kind !== kind ||
		projectRecordId(validation.value) !== id
	) {
		throw new TypeError("Updated record does not satisfy the persisted contract");
	}
	return validation.value;
}

function validatedNewRecord(record: ProjectRecord, operationId: string): ProjectRecord {
	const validation = validatePersistedRecord(record);
	if (!validation.ok || validation.value.kind === "research_project_manifest") {
		throw new TypeError("Record does not satisfy the persisted contract");
	}
	const created = validation.value;
	if (projectRecordRevision(created) !== 0) throw new TypeError("New record must start at revision 0");
	if (
		created.kind !== "task" &&
		(created.audit.createdByOperationId !== operationId || created.audit.updatedByOperationId !== operationId)
	) {
		throw new TypeError("New record audit must reference the creating operation");
	}
	if (created.kind === "task" && !created.operationIds.includes(operationId)) {
		throw new TypeError("New task must reference the creating operation");
	}
	return created;
}

async function commitRecordChanges(
	projectRoot: string,
	manifest: ResearchProjectManifest,
	changes: readonly PreparedRecordChange[],
	operationId: string,
): Promise<void> {
	const paths = changes.map(({ kind, id }) => projectRecordPath(manifest, kind, id));
	if (new Set(paths).size !== paths.length) throw new TypeError("Record transaction contains a duplicate target");
	const changesByKind = new Map<RecordKind, { id: string; hash: HashValue | null }[]>();
	for (const change of changes) {
		const entries = changesByKind.get(change.kind) ?? [];
		entries.push({ id: change.id, hash: change.content === null ? null : hashBytes(change.content) });
		changesByKind.set(change.kind, entries);
	}
	const indexes = new Map(
		await Promise.all(
			[...changesByKind].map(
				async ([kind, kindChanges]) =>
					[kind, await calculateRecordSetIndex(projectRoot, manifest, kind, kindChanges)] as const,
			),
		),
	);
	let activeTaskIds = manifest.activeTaskIds;
	for (const change of changes) {
		if (change.kind !== "task") continue;
		activeTaskIds =
			change.record?.kind === "task" &&
			!["succeeded", "partially_succeeded", "failed_permanent", "cancelled"].includes(change.record.status)
				? [...new Set([...activeTaskIds, change.id])]
				: activeTaskIds.filter((taskId) => taskId !== change.id);
	}
	const nextManifest: ResearchProjectManifest = {
		...manifest,
		activeTaskIds,
		recordSets: manifest.recordSets.map((recordSet) =>
			indexes.has(recordSet.kind) ? { ...recordSet, ...indexes.get(recordSet.kind) } : recordSet,
		),
		lastCommittedOperationId: operationId,
		updatedAt: new Date().toISOString(),
		revision: manifest.revision + 1,
	};
	await commitProjectTransaction(projectRoot, {
		expectedRevision: manifest.revision,
		writes: changes.map(({ kind, id, content, expectedHash }) => ({
			path: projectRecordPath(manifest, kind, id),
			content,
			expectedHash,
		})),
		manifest: nextManifest,
	});
}

export async function createRecord(
	projectRoot: string,
	record: ProjectRecord,
	input: RecordMutationInput,
): Promise<ResearchResult<RecordRef>> {
	try {
		if (!isOpaqueId(input.operationId, "operation"))
			throw new TypeError(`Invalid operation ID: ${input.operationId}`);
		const manifest = await currentManifest(projectRoot, input.expectedManifestRevision);
		const validatedRecord = validatedNewRecord(record, input.operationId);
		const id = projectRecordId(validatedRecord);
		projectRecordPath(manifest, validatedRecord.kind, id);
		const content = `${canonicalStringify(validatedRecord)}\n`;
		await commitRecordChanges(
			projectRoot,
			manifest,
			[
				{
					record: validatedRecord,
					kind: validatedRecord.kind,
					id,
					content,
					expectedHash: null,
				},
			],
			input.operationId,
		);
		return successResult({ kind: validatedRecord.kind, id, revision: 0 }, input.operationId);
	} catch (error) {
		return failureFromError(error, input.operationId);
	}
}

export async function createRecords(
	projectRoot: string,
	records: readonly ProjectRecord[],
	input: RecordMutationInput,
): Promise<ResearchResult<RecordRef[]>> {
	try {
		if (!isOpaqueId(input.operationId, "operation"))
			throw new TypeError(`Invalid operation ID: ${input.operationId}`);
		if (records.length === 0) throw new TypeError("Record transaction cannot be empty");
		const manifest = await currentManifest(projectRoot, input.expectedManifestRevision);
		const created = records.map((record) => validatedNewRecord(record, input.operationId));
		const changes = created.map((record) => {
			const id = projectRecordId(record);
			projectRecordPath(manifest, record.kind, id);
			return {
				record,
				kind: record.kind,
				id,
				content: `${canonicalStringify(record)}\n`,
				expectedHash: null,
			};
		});
		await commitRecordChanges(projectRoot, manifest, changes, input.operationId);
		return successResult(
			created.map((record) => ({ kind: record.kind, id: projectRecordId(record), revision: 0 })),
			input.operationId,
		);
	} catch (error) {
		return failureFromError(error, input.operationId);
	}
}

export async function readRecord(
	projectRoot: string,
	kind: RecordKind,
	id: string,
): Promise<ResearchResult<ProjectRecord>> {
	try {
		const loaded = await loadRecord(projectRoot, await currentManifest(projectRoot), kind, id);
		return successResult(loaded.record, null);
	} catch (error) {
		return failureFromError(error, null);
	}
}

export async function updateRecord(
	projectRoot: string,
	kind: RecordKind,
	id: string,
	input: UpdateRecordInput,
): Promise<ResearchResult<RecordRef>> {
	try {
		if (!isOpaqueId(input.operationId, "operation"))
			throw new TypeError(`Invalid operation ID: ${input.operationId}`);
		const manifest = await currentManifest(projectRoot, input.expectedManifestRevision);
		const loaded = await loadRecord(projectRoot, manifest, kind, id);
		const currentRevision = projectRecordRevision(loaded.record);
		if (currentRevision !== input.expectedRecordRevision) {
			return failureResult(
				"DATA_CONFLICT",
				"RECORD_REVISION_CONFLICT",
				"data_conflict",
				`Expected ${kind} ${id} revision ${input.expectedRecordRevision}, found ${currentRevision}`,
				input.operationId,
				{ expectedRevision: input.expectedRecordRevision, actualRevision: currentRevision },
			);
		}
		const candidate = updatedRecord(loaded.record, kind, id, input.changes, input.operationId);
		const content = `${canonicalStringify(candidate)}\n`;
		await commitRecordChanges(
			projectRoot,
			manifest,
			[{ record: candidate, kind, id, content, expectedHash: loaded.hash }],
			input.operationId,
		);
		return successResult({ kind, id, revision: projectRecordRevision(candidate) }, input.operationId);
	} catch (error) {
		return failureFromError(error, input.operationId);
	}
}

export async function deleteRecord(
	projectRoot: string,
	kind: RecordKind,
	id: string,
	input: DeleteRecordInput,
): Promise<ResearchResult<RecordRef>> {
	try {
		if (!isOpaqueId(input.operationId, "operation"))
			throw new TypeError(`Invalid operation ID: ${input.operationId}`);
		const manifest = await currentManifest(projectRoot, input.expectedManifestRevision);
		const loaded = await loadRecord(projectRoot, manifest, kind, id);
		const currentRevision = projectRecordRevision(loaded.record);
		if (currentRevision !== input.expectedRecordRevision) {
			return failureResult(
				"DATA_CONFLICT",
				"RECORD_REVISION_CONFLICT",
				"data_conflict",
				`Expected ${kind} ${id} revision ${input.expectedRecordRevision}, found ${currentRevision}`,
				input.operationId,
			);
		}
		await commitRecordChanges(
			projectRoot,
			manifest,
			[{ record: null, kind, id, content: null, expectedHash: loaded.hash }],
			input.operationId,
		);
		return successResult({ kind, id, revision: currentRevision }, input.operationId);
	} catch (error) {
		return failureFromError(error, input.operationId);
	}
}

export async function createRecordWithUpdate(
	projectRoot: string,
	record: ProjectRecord,
	update: AtomicRecordUpdate,
	input: RecordMutationInput,
): Promise<ResearchResult<RecordRef[]>> {
	try {
		if (!isOpaqueId(input.operationId, "operation"))
			throw new TypeError(`Invalid operation ID: ${input.operationId}`);
		const manifest = await currentManifest(projectRoot, input.expectedManifestRevision);
		const created = validatedNewRecord(record, input.operationId);
		const createdId = projectRecordId(created);
		const loaded = await loadRecord(projectRoot, manifest, update.kind, update.id);
		const currentRevision = projectRecordRevision(loaded.record);
		if (currentRevision !== update.expectedRecordRevision) {
			return failureResult(
				"DATA_CONFLICT",
				"RECORD_REVISION_CONFLICT",
				"data_conflict",
				`Expected ${update.kind} ${update.id} revision ${update.expectedRecordRevision}, found ${currentRevision}`,
				input.operationId,
			);
		}
		const updated = updatedRecord(loaded.record, update.kind, update.id, update.changes, input.operationId);
		const createdContent = `${canonicalStringify(created)}\n`;
		const updatedContent = `${canonicalStringify(updated)}\n`;
		await commitRecordChanges(
			projectRoot,
			manifest,
			[
				{
					record: created,
					kind: created.kind,
					id: createdId,
					content: createdContent,
					expectedHash: null,
				},
				{
					record: updated,
					kind: update.kind,
					id: update.id,
					content: updatedContent,
					expectedHash: loaded.hash,
				},
			],
			input.operationId,
		);
		return successResult(
			[
				{ kind: created.kind, id: createdId, revision: 0 },
				{ kind: update.kind, id: update.id, revision: projectRecordRevision(updated) },
			],
			input.operationId,
		);
	} catch (error) {
		return failureFromError(error, input.operationId);
	}
}
