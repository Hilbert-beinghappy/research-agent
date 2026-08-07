// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Compile } from "typebox/compile";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type CollaborationChangeSet,
	CollaborationChangeSetSchema,
	type CollaborationMergeRecord,
	type HashValue,
	RESEARCH_SCHEMA_VERSION,
	type RecordKind,
	type RecordRef,
	type ResearchResult,
} from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashBytes, hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath, resolveProjectPathWithoutSymlinks, validatePortablePathSet } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import {
	calculateRecordSetIndex,
	projectRecordId,
	projectRecordPath,
	projectRecordRevision,
} from "../project/record-index.ts";
import { createRecord, readRecord } from "../project/records.ts";
import { commitProjectTransaction } from "../project/transactions.ts";
import { finishOperation, startOperation } from "../tools/operations.ts";

const ChangeSetValidator = Compile(CollaborationChangeSetSchema);
const GOVERNANCE_RECORDS = new Set<RecordKind>([
	"approval",
	"adapter_registration",
	"exchange_record",
	"collaboration_merge",
]);

export interface CollaborationRecordSelection {
	kind: RecordKind;
	id: string;
	baseHash: HashValue | null;
}

export interface CreateCollaborationChangeSetInput {
	baseManifestRevision: number;
	authorOperationId: string;
	records: CollaborationRecordSelection[];
}

interface ProposedRecord {
	change: CollaborationChangeSet["changes"][number];
	content: string;
}

async function selectedRecord(
	projectRoot: string,
	kind: RecordKind,
	id: string,
	baseHash: HashValue | null,
): Promise<{ change: CollaborationChangeSet["changes"][number]; content: string }> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Collaboration requires a current project");
	const path = projectRecordPath(opened.manifest, kind, id);
	const content = await readFile(await resolveProjectPath(opened.root, path), "utf8");
	const validation = validatePersistedRecord(canonicalizeJson(JSON.parse(content)));
	if (!validation.ok || validation.value.kind === "research_project_manifest") {
		throw new TypeError(`Collaboration record is invalid: ${kind}:${id}`);
	}
	if (projectRecordId(validation.value) !== id || validation.value.kind !== kind) {
		throw new TypeError(`Collaboration record identity mismatch: ${kind}:${id}`);
	}
	return {
		change: {
			kind,
			id,
			path,
			baseHash,
			proposedHash: await hashFile(await resolveProjectPath(opened.root, path)),
			proposedRevision: projectRecordRevision(validation.value),
		},
		content,
	};
}

export async function createCollaborationChangeSet(
	projectRoot: string,
	changeSetRoot: string,
	input: CreateCollaborationChangeSetInput,
): Promise<CollaborationChangeSet> {
	if (input.records.length === 0) throw new TypeError("Collaboration change sets require at least one record");
	if (!Number.isSafeInteger(input.baseManifestRevision) || input.baseManifestRevision < 0) {
		throw new TypeError("Collaboration base revision must be a non-negative safe integer");
	}
	if (input.records.some(({ kind }) => kind === "operation" || GOVERNANCE_RECORDS.has(kind))) {
		throw new TypeError("Governance and operation records cannot be selected directly");
	}
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Collaboration requires a current project");
	const author = await readRecord(opened.root, "operation", input.authorOperationId);
	if (
		!author.ok ||
		author.value.kind !== "operation" ||
		!["succeeded", "partially_succeeded"].includes(author.value.status)
	) {
		throw new TypeError("Collaboration author operation must be terminal and successful");
	}
	const selections = [{ kind: "operation" as const, id: input.authorOperationId, baseHash: null }, ...input.records];
	const identities = selections.map(({ kind, id }) => `${kind}:${id}`);
	if (new Set(identities).size !== identities.length)
		throw new TypeError("Collaboration record selection is duplicated");
	const selected = await Promise.all(
		selections.map(({ kind, id, baseHash }) => selectedRecord(opened.root, kind, id, baseHash)),
	);
	validatePortablePathSet(selected.map(({ change }) => change.path));
	const changeSet: CollaborationChangeSet = {
		format: "pi-research-collaboration-change-set",
		version: 1,
		changeSetId: createOpaqueId("change_set"),
		projectId: opened.manifest.projectId,
		baseManifestRevision: input.baseManifestRevision,
		authorOperationId: input.authorOperationId,
		createdAt: new Date().toISOString(),
		changes: selected.map(({ change }) => change),
		rootHash: hashCanonicalJson(selected.map(({ change }) => change)),
	};
	const target = resolve(changeSetRoot);
	try {
		await lstat(target);
		throw new TypeError("Change-set destination must not already exist");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const staging = `${target}.staging-${changeSet.changeSetId}`;
	await mkdir(staging, { recursive: false });
	try {
		for (const { change, content } of selected) {
			const path = resolve(staging, "files", ...change.path.split("/"));
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
		}
		await writeFile(resolve(staging, "changeset.json"), `${canonicalStringify(changeSet)}\n`);
		await rename(staging, target);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return changeSet;
}

export async function readCollaborationChangeSet(changeSetRoot: string): Promise<CollaborationChangeSet> {
	const value = canonicalizeJson(
		JSON.parse(await readFile(await resolveProjectPathWithoutSymlinks(changeSetRoot, "changeset.json"), "utf8")),
	);
	if (!ChangeSetValidator.Check(value)) throw new TypeError("Collaboration change set is invalid");
	validatePortablePathSet(value.changes.map(({ path }) => path));
	if (hashCanonicalJson(value.changes).value !== value.rootHash.value) {
		throw new TypeError("Collaboration change-set root hash mismatch");
	}
	for (const change of value.changes) {
		if (
			(await hashFile(await resolveProjectPathWithoutSymlinks(changeSetRoot, `files/${change.path}`))).value !==
			change.proposedHash.value
		) {
			throw new TypeError(`Collaboration record hash mismatch: ${change.kind}:${change.id}`);
		}
	}
	return value;
}

async function currentHash(projectRoot: string, path: string): Promise<HashValue | null> {
	try {
		return await hashFile(await resolveProjectPath(projectRoot, path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function proposedRecords(changeSetRoot: string, changeSet: CollaborationChangeSet): Promise<ProposedRecord[]> {
	const records: ProposedRecord[] = [];
	for (const change of changeSet.changes) {
		const content = await readFile(
			await resolveProjectPathWithoutSymlinks(changeSetRoot, `files/${change.path}`),
			"utf8",
		);
		const validation = validatePersistedRecord(canonicalizeJson(JSON.parse(content)));
		if (!validation.ok || validation.value.kind === "research_project_manifest") {
			throw new TypeError(`Proposed collaboration record is invalid: ${change.kind}:${change.id}`);
		}
		if (
			validation.value.kind !== change.kind ||
			projectRecordId(validation.value) !== change.id ||
			projectRecordRevision(validation.value) !== change.proposedRevision
		) {
			throw new TypeError(`Proposed collaboration record identity changed: ${change.kind}:${change.id}`);
		}
		records.push({ change, content });
	}
	return records;
}

function mergeRecord(
	operationId: string,
	changeSet: CollaborationChangeSet,
	applied: RecordRef[],
	skipped: RecordRef[],
	conflicts: CollaborationMergeRecord["conflicts"],
): CollaborationMergeRecord {
	const now = new Date().toISOString();
	return {
		kind: "collaboration_merge",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		collaborationMergeId: createOpaqueId("collaboration_merge"),
		changeSetId: changeSet.changeSetId,
		changeSetHash: hashCanonicalJson(changeSet),
		baseManifestRevision: changeSet.baseManifestRevision,
		applied,
		skipped,
		conflicts,
		status: conflicts.length === 0 ? "merged" : "conflict",
		mergedAt: now,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

export async function mergeCollaborationChangeSet(
	projectRoot: string,
	changeSetRoot: string,
): Promise<ResearchResult<CollaborationMergeRecord>> {
	const changeSet = await readCollaborationChangeSet(changeSetRoot);
	const openedBefore = await openProject(projectRoot);
	if (openedBefore.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"COLLABORATION_PROJECT_READ_ONLY",
			"migration",
			"Project is read-only",
			null,
		);
	}
	if (openedBefore.manifest.projectId !== changeSet.projectId) {
		return failureResult(
			"DATA_CONFLICT",
			"COLLABORATION_PROJECT_MISMATCH",
			"data_conflict",
			"Change set belongs to another project",
			null,
		);
	}
	const started = await startOperation(openedBefore.root, {
		operationKind: "tool",
		name: "research.collaboration.merge",
		implementationVersion: RESEARCH_SCHEMA_VERSION,
		session: null,
	});
	if (!started.ok) return started as ResearchResult<CollaborationMergeRecord>;
	const operationId = started.value.operationId;
	try {
		const opened = await openProject(openedBefore.root);
		if (opened.compatibility !== "current") throw new TypeError("Project became read-only");
		const proposed = await proposedRecords(changeSetRoot, changeSet);
		const applied: ProposedRecord[] = [];
		const skipped: RecordRef[] = [];
		const conflicts: CollaborationMergeRecord["conflicts"] = [];
		for (const candidate of proposed) {
			if (candidate.change.path !== projectRecordPath(opened.manifest, candidate.change.kind, candidate.change.id)) {
				throw new TypeError(`Collaboration record path mismatch: ${candidate.change.kind}:${candidate.change.id}`);
			}
			const actualHash = await currentHash(opened.root, candidate.change.path);
			const ref = {
				kind: candidate.change.kind,
				id: candidate.change.id,
				revision: candidate.change.proposedRevision,
			};
			if (actualHash?.value === candidate.change.proposedHash.value) {
				skipped.push(ref);
				continue;
			}
			if (actualHash?.value !== candidate.change.baseHash?.value) {
				conflicts.push({
					kind: candidate.change.kind,
					id: candidate.change.id,
					expectedHash: candidate.change.baseHash,
					actualHash,
					proposedHash: candidate.change.proposedHash,
				});
				continue;
			}
			if (candidate.change.baseHash !== null) {
				const current = await readRecord(opened.root, candidate.change.kind, candidate.change.id);
				if (!current.ok) {
					throw new TypeError(`Collaboration base record is invalid: ${candidate.change.id}`);
				}
				if (candidate.change.proposedRevision !== projectRecordRevision(current.value) + 1) {
					throw new TypeError(`Collaboration revision is not consecutive: ${candidate.change.id}`);
				}
			}
			applied.push(candidate);
		}
		const appliedRefs = applied.map(({ change }) => ({
			kind: change.kind,
			id: change.id,
			revision: change.proposedRevision,
		}));
		const merge = mergeRecord(operationId, changeSet, conflicts.length === 0 ? appliedRefs : [], skipped, conflicts);
		if (conflicts.length > 0) {
			const created = await createRecord(opened.root, merge, {
				expectedManifestRevision: opened.manifest.revision,
				operationId,
			});
			if (!created.ok) throw new Error(created.errors[0].message);
			const failure = failureResult<CollaborationMergeRecord>(
				"DATA_CONFLICT",
				"COLLABORATION_CONFLICT",
				"data_conflict",
				"Change set requires manual conflict resolution",
				operationId,
				{ collaborationMergeId: merge.collaborationMergeId, conflicts },
			);
			await finishOperation(opened.root, operationId, failure);
			return failure;
		}
		const mergeContent = `${canonicalStringify(merge)}\n`;
		const writes = [
			...applied.map(({ change, content }) => ({ path: change.path, content, expectedHash: change.baseHash })),
			{
				path: projectRecordPath(opened.manifest, "collaboration_merge", merge.collaborationMergeId),
				content: mergeContent,
			},
		];
		const changesByKind = new Map<RecordKind, { id: string; hash: HashValue }[]>();
		for (const candidate of applied) {
			const values = changesByKind.get(candidate.change.kind) ?? [];
			values.push({ id: candidate.change.id, hash: candidate.change.proposedHash });
			changesByKind.set(candidate.change.kind, values);
		}
		changesByKind.set("collaboration_merge", [{ id: merge.collaborationMergeId, hash: hashBytes(mergeContent) }]);
		const indexes = new Map<RecordKind, { count: number; contentHash: HashValue | null }>();
		for (const [kind, changes] of changesByKind) {
			indexes.set(kind, await calculateRecordSetIndex(opened.root, opened.manifest, kind, changes));
		}
		await commitProjectTransaction(opened.root, {
			expectedRevision: opened.manifest.revision,
			writes,
			manifest: {
				...opened.manifest,
				recordSets: opened.manifest.recordSets.map((recordSet) => ({
					...recordSet,
					...(indexes.get(recordSet.kind) ?? {}),
				})),
				lastCommittedOperationId: operationId,
				updatedAt: new Date().toISOString(),
				revision: opened.manifest.revision + 1,
			},
		});
		const success = successResult(merge, operationId);
		await finishOperation(opened.root, operationId, success, [
			...appliedRefs,
			{ kind: "collaboration_merge", id: merge.collaborationMergeId, revision: 0 },
		]);
		return success;
	} catch (error) {
		const failure = failureResult<CollaborationMergeRecord>(
			"PERMANENT_FAILURE",
			"COLLABORATION_MERGE_FAILED",
			"runtime",
			error instanceof Error ? error.message : String(error),
			operationId,
		);
		await finishOperation(openedBefore.root, operationId, failure);
		return failure;
	}
}
