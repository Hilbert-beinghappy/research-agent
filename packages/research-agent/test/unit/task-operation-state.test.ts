import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OperationRecord, ResearchError, ResearchTask } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { operationTransitionPatch, withPersistedRunningOperation } from "../../src/kernel/operations.ts";
import { taskCheckpointPatch, taskTransitionPatch } from "../../src/kernel/tasks.ts";
import { initializeProject } from "../../src/project/init.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-state-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Task and operation state" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function operationRecord(operationId: string): OperationRecord {
	const now = new Date().toISOString();
	return {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId,
		taskId: null,
		operationKind: "tool",
		name: "test.operation",
		implementationVersion: "0.1.0",
		status: "planned",
		session: null,
		actor: { type: "tool", id: "test" },
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
		startedAt: null,
		finishedAt: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

function taskRecord(taskId: string, operationId: string): ResearchTask {
	const now = new Date().toISOString();
	return {
		kind: "task",
		schemaVersion: "0.1.0",
		taskId,
		taskType: "literature_search",
		title: "Search literature",
		inputs: [],
		inputFiles: [],
		expectedOutputs: ["source records"],
		outputs: [],
		outputFiles: [],
		dependencyTaskIds: [],
		status: "planned",
		attemptCount: 0,
		maxAttempts: 2,
		idempotencyKey: "search:test",
		operationIds: [operationId],
		errors: [],
		resumeCursor: null,
		budget: { estimated: null, actual: { amount: 0, currency: "USD" } },
		createdAt: now,
		startedAt: null,
		finishedAt: null,
		updatedAt: now,
		revision: 0,
	};
}

function researchError(operationId: string): ResearchError {
	return {
		code: "TEMPORARY_FAILURE",
		category: "external_service",
		message: "temporary failure",
		retryable: true,
		source: "task-operation-state.test",
		operationId,
		taskId: null,
		details: null,
		occurredAt: new Date().toISOString(),
		causeCode: null,
	};
}

async function loadTask(taskId: string): Promise<ResearchTask> {
	const result = await readRecord(projectRoot, "task", taskId);
	if (!result.ok || result.value.kind !== "task") throw new Error("expected task record");
	return result.value;
}

async function loadOperation(operationId: string): Promise<OperationRecord> {
	const result = await readRecord(projectRoot, "operation", operationId);
	if (!result.ok || result.value.kind !== "operation") throw new Error("expected operation record");
	return result.value;
}

describe("task and operation state", () => {
	it("persists retry attempts, resume cursor, and cumulative cost without reopening terminal tasks", async () => {
		const operationId = createOpaqueId("operation");
		await createRecord(projectRoot, operationRecord(operationId), { expectedManifestRevision: 0, operationId });
		const taskId = createOpaqueId("task");
		await createRecord(projectRoot, taskRecord(taskId, operationId), { expectedManifestRevision: 1, operationId });

		let task = await loadTask(taskId);
		await updateRecord(projectRoot, "task", taskId, {
			expectedManifestRevision: 2,
			expectedRecordRevision: 0,
			operationId,
			changes: taskTransitionPatch(task, "ready"),
		});
		task = await loadTask(taskId);
		await updateRecord(projectRoot, "task", taskId, {
			expectedManifestRevision: 3,
			expectedRecordRevision: 1,
			operationId,
			changes: taskTransitionPatch(task, "running"),
		});
		task = await loadTask(taskId);
		expect(task.attemptCount).toBe(1);
		await updateRecord(projectRoot, "task", taskId, {
			expectedManifestRevision: 4,
			expectedRecordRevision: 2,
			operationId,
			changes: taskCheckpointPatch(
				task,
				{ adapter: "crossref", cursor: "page-2" },
				{ amount: 0.1, currency: "USD" },
			),
		});
		task = await loadTask(taskId);
		await updateRecord(projectRoot, "task", taskId, {
			expectedManifestRevision: 5,
			expectedRecordRevision: 3,
			operationId,
			changes: taskTransitionPatch(task, "failed_retryable", { error: researchError(operationId) }),
		});
		task = await loadTask(taskId);
		await updateRecord(projectRoot, "task", taskId, {
			expectedManifestRevision: 6,
			expectedRecordRevision: 4,
			operationId,
			changes: taskTransitionPatch(task, "ready"),
		});

		const recovered = await loadTask(taskId);
		expect(recovered).toMatchObject({
			status: "ready",
			attemptCount: 2,
			resumeCursor: { adapter: "crossref", cursor: "page-2" },
			budget: { actual: { amount: 0.1, currency: "USD" } },
			revision: 5,
		});
		expect(() => taskTransitionPatch({ ...recovered, status: "succeeded" }, "running")).toThrow(
			"Invalid task transition",
		);
		expect(() => taskTransitionPatch({ ...recovered, status: "failed_retryable", attemptCount: 2 }, "ready")).toThrow(
			"max attempts",
		);
	});

	it("runs an effect only after a running OperationRecord is persisted", async () => {
		const operationId = createOpaqueId("operation");
		await createRecord(projectRoot, operationRecord(operationId), { expectedManifestRevision: 0, operationId });
		let called = false;
		await expect(
			withPersistedRunningOperation(projectRoot, operationId, async () => {
				called = true;
			}),
		).rejects.toThrow("not persisted as running");
		expect(called).toBe(false);

		let operation = await loadOperation(operationId);
		await updateRecord(projectRoot, "operation", operationId, {
			expectedManifestRevision: 1,
			expectedRecordRevision: 0,
			operationId,
			changes: operationTransitionPatch(operation, "awaiting_approval"),
		});
		operation = await loadOperation(operationId);
		expect(operation).toMatchObject({ status: "awaiting_approval", startedAt: expect.any(String) });
		await updateRecord(projectRoot, "operation", operationId, {
			expectedManifestRevision: 2,
			expectedRecordRevision: 1,
			operationId,
			changes: operationTransitionPatch(operation, "running"),
		});
		await expect(
			withPersistedRunningOperation(projectRoot, operationId, async (persisted) => {
				called = true;
				return persisted.status;
			}),
		).resolves.toBe("running");
		expect(called).toBe(true);

		operation = await loadOperation(operationId);
		await updateRecord(projectRoot, "operation", operationId, {
			expectedManifestRevision: 3,
			expectedRecordRevision: 2,
			operationId,
			changes: operationTransitionPatch(operation, "succeeded"),
		});
		operation = await loadOperation(operationId);
		expect(operation).toMatchObject({ status: "succeeded", audit: { revision: 3 } });
		expect(() => operationTransitionPatch(operation, "running")).toThrow("Invalid operation transition");
	});
});
