// SPDX-License-Identifier: Apache-2.0

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OperationRecord, ResearchTask } from "../../src/contracts/schemas.ts";
import {
	createCollaborationChangeSet,
	mergeCollaborationChangeSet,
	readCollaborationChangeSet,
} from "../../src/exchange/collaboration.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashFile } from "../../src/kernel/integrity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { projectRecordPath } from "../../src/project/record-index.ts";
import { createRecord, createRecords, readRecord, updateRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";

const timestamp = "2026-08-07T00:00:00.000Z";
let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-research-collaboration-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function operation(operationId: string, taskId: string | null, name: string): OperationRecord {
	return {
		kind: "operation",
		schemaVersion: "1.5.0",
		operationId,
		taskId,
		operationKind: "tool",
		name,
		implementationVersion: "1.5.0",
		status: "succeeded",
		session: null,
		actor: { type: "tool", id: name },
		modelExecution: null,
		adapterExecution: null,
		inputs: [],
		inputFiles: [],
		outputs: [],
		outputFiles: [],
		rawRequest: null,
		rawResponse: null,
		approvalIds: [],
		usage: {
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			networkRequests: 0,
			cost: { amount: 0, currency: "USD" },
		},
		error: null,
		startedAt: timestamp,
		finishedAt: timestamp,
		audit: {
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

function task(taskId: string, operationId: string, title: string): ResearchTask {
	return {
		kind: "task",
		schemaVersion: "1.5.0",
		taskId,
		taskType: "collaboration.fixture",
		title,
		inputs: [],
		inputFiles: [],
		expectedOutputs: [],
		outputs: [],
		outputFiles: [],
		dependencyTaskIds: [],
		status: "succeeded",
		attemptCount: 1,
		maxAttempts: 1,
		idempotencyKey: taskId,
		operationIds: [operationId],
		errors: [],
		resumeCursor: null,
		budget: { estimated: null, actual: { amount: 0, currency: "USD" } },
		createdAt: timestamp,
		startedAt: timestamp,
		finishedAt: timestamp,
		updatedAt: timestamp,
		revision: 0,
	};
}

async function revision(project: string): Promise<number> {
	const opened = await openProject(project);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	return opened.manifest.revision;
}

async function createTask(project: string, title: string) {
	const operationId = createOpaqueId("operation");
	const taskId = createOpaqueId("task");
	const created = await createRecords(
		project,
		[operation(operationId, taskId, "fixture.create"), task(taskId, operationId, title)],
		{
			expectedManifestRevision: await revision(project),
			operationId,
		},
	);
	if (!created.ok) throw new Error(created.errors[0].message);
	return { operationId, taskId };
}

async function updateTask(project: string, taskId: string, title: string) {
	const operationId = createOpaqueId("operation");
	const created = await createRecord(project, operation(operationId, taskId, "fixture.update"), {
		expectedManifestRevision: await revision(project),
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	const updated = await updateRecord(project, "task", taskId, {
		expectedManifestRevision: await revision(project),
		expectedRecordRevision: 0,
		operationId,
		changes: { title },
	});
	if (!updated.ok) throw new Error(updated.errors[0].message);
	return operationId;
}

describe("file collaboration change sets", () => {
	it("merges new opaque records atomically and treats a replay as same-hash skips", async () => {
		const target = join(root, "target");
		const contributor = join(root, "contributor");
		const changeSetRoot = join(root, "changeset");
		await initializeProject(target, { title: "Collaboration project" });
		await cp(target, contributor, { recursive: true });
		const created = await createTask(contributor, "Contributor task");
		const changeSet = await createCollaborationChangeSet(contributor, changeSetRoot, {
			baseManifestRevision: 0,
			authorOperationId: created.operationId,
			records: [{ kind: "task", id: created.taskId, baseHash: null }],
		});

		const merged = await mergeCollaborationChangeSet(target, changeSetRoot);
		expect(merged).toMatchObject({ ok: true, value: { changeSetId: changeSet.changeSetId, status: "merged" } });
		if (!merged.ok) throw new Error(merged.errors[0].message);
		expect(merged.value.applied.map(({ kind }) => kind).sort()).toEqual(["operation", "task"]);
		await expect(readRecord(target, "task", created.taskId)).resolves.toMatchObject({
			ok: true,
			value: { title: "Contributor task" },
		});
		expect((await validateProject(target)).issues).toEqual([]);

		const replay = await mergeCollaborationChangeSet(target, changeSetRoot);
		expect(replay).toMatchObject({
			ok: true,
			value: {
				applied: [],
				skipped: expect.arrayContaining([
					{ kind: "operation", id: created.operationId, revision: 0 },
					{ kind: "task", id: created.taskId, revision: 0 },
				]),
			},
		});
		expect((await validateProject(target)).issues).toEqual([]);
	});

	it("records a divergent revision conflict without applying any proposed record", async () => {
		const target = join(root, "target");
		const contributor = join(root, "contributor");
		const changeSetRoot = join(root, "conflict-changeset");
		await initializeProject(target, { title: "Conflict project" });
		const base = await createTask(target, "Base task");
		const opened = await openProject(target);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const path = projectRecordPath(opened.manifest, "task", base.taskId);
		const baseHash = await hashFile(join(target, ...path.split("/")));
		await cp(target, contributor, { recursive: true });
		const contributorOperationId = await updateTask(contributor, base.taskId, "Contributor edit");
		await updateTask(target, base.taskId, "Target edit");
		await createCollaborationChangeSet(contributor, changeSetRoot, {
			baseManifestRevision: opened.manifest.revision,
			authorOperationId: contributorOperationId,
			records: [{ kind: "task", id: base.taskId, baseHash }],
		});

		const merged = await mergeCollaborationChangeSet(target, changeSetRoot);
		expect(merged).toMatchObject({
			ok: false,
			status: "DATA_CONFLICT",
			errors: [{ code: "COLLABORATION_CONFLICT" }],
		});
		await expect(readRecord(target, "task", base.taskId)).resolves.toMatchObject({
			ok: true,
			value: { title: "Target edit", revision: 1 },
		});
		await expect(readRecord(target, "operation", contributorOperationId)).resolves.toMatchObject({ ok: false });
		expect((await validateProject(target)).issues).toEqual([]);
	});

	it("rejects a tampered record before merge", async () => {
		const target = join(root, "target");
		const contributor = join(root, "contributor");
		const changeSetRoot = join(root, "tampered-changeset");
		await initializeProject(target, { title: "Tamper project" });
		await cp(target, contributor, { recursive: true });
		const created = await createTask(contributor, "Original task");
		const changeSet = await createCollaborationChangeSet(contributor, changeSetRoot, {
			baseManifestRevision: 0,
			authorOperationId: created.operationId,
			records: [{ kind: "task", id: created.taskId, baseHash: null }],
		});
		const taskChange = changeSet.changes.find(({ kind }) => kind === "task");
		if (taskChange === undefined) throw new Error("Task change is missing");
		const file = join(changeSetRoot, "files", ...taskChange.path.split("/"));
		await writeFile(file, `${(await readFile(file, "utf8")).replace("Original", "Tampered")}\n`);
		await expect(readCollaborationChangeSet(changeSetRoot)).rejects.toThrow("hash mismatch");
	});
});
