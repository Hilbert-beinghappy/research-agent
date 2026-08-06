// SPDX-License-Identifier: Apache-2.0

import type { JsonValue, Money, ResearchError, ResearchTask, TaskStatus } from "../contracts/schemas.ts";

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
	planned: ["ready"],
	ready: ["running"],
	running: [
		"awaiting_approval",
		"blocked",
		"succeeded",
		"partially_succeeded",
		"failed_retryable",
		"failed_permanent",
		"cancelled",
	],
	awaiting_approval: ["running", "blocked", "cancelled"],
	failed_retryable: ["ready"],
	blocked: [],
	succeeded: [],
	partially_succeeded: [],
	failed_permanent: [],
	cancelled: [],
};

export function taskTransitionPatch(
	task: ResearchTask,
	nextStatus: TaskStatus,
	options: { error?: ResearchError } = {},
): Record<string, JsonValue> {
	if (!TASK_TRANSITIONS[task.status].includes(nextStatus)) {
		throw new Error(`Invalid task transition: ${task.status} -> ${nextStatus}`);
	}
	const now = new Date().toISOString();
	const patch: Record<string, JsonValue> = { status: nextStatus };

	if (task.status === "ready" && nextStatus === "running" && task.attemptCount === 0) {
		patch.attemptCount = 1;
	}
	if (task.status === "failed_retryable" && nextStatus === "ready") {
		const attemptCount = task.attemptCount + 1;
		if (attemptCount > task.maxAttempts) throw new Error(`Task ${task.taskId} exceeded max attempts`);
		patch.attemptCount = attemptCount;
		patch.finishedAt = null;
	}
	if (nextStatus === "running") {
		patch.startedAt = task.startedAt ?? now;
		patch.finishedAt = null;
	}
	if (
		["blocked", "succeeded", "partially_succeeded", "failed_retryable", "failed_permanent", "cancelled"].includes(
			nextStatus,
		)
	) {
		patch.finishedAt = now;
	}
	if (["partially_succeeded", "failed_retryable", "failed_permanent"].includes(nextStatus)) {
		if (options.error === undefined) throw new Error(`Task transition to ${nextStatus} requires an error`);
		patch.errors = [...task.errors, options.error];
	}
	if (nextStatus === "succeeded") patch.errors = [];
	return patch;
}

export function taskCheckpointPatch(
	task: ResearchTask,
	resumeCursor: JsonValue,
	actualCost: Money,
): Record<string, JsonValue> {
	if (task.status !== "running" && task.status !== "awaiting_approval") {
		throw new Error(`Cannot checkpoint task in ${task.status}`);
	}
	if (actualCost.currency !== task.budget.actual.currency || actualCost.amount < task.budget.actual.amount) {
		throw new Error("Task actual cost must be cumulative in the existing currency");
	}
	return { resumeCursor, budget: { ...task.budget, actual: actualCost } };
}
