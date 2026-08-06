// SPDX-License-Identifier: Apache-2.0

import type { JsonValue, OperationRecord, OperationStatus, ResearchError } from "../contracts/schemas.ts";
import { readRecord } from "../project/records.ts";

const OPERATION_TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
	planned: ["running", "awaiting_approval", "cancelled"],
	running: [
		"awaiting_approval",
		"succeeded",
		"partially_succeeded",
		"failed_retryable",
		"failed_permanent",
		"blocked",
		"cancelled",
	],
	awaiting_approval: ["running", "blocked", "cancelled"],
	succeeded: [],
	partially_succeeded: [],
	failed_retryable: [],
	failed_permanent: [],
	blocked: [],
	cancelled: [],
};

export function operationTransitionPatch(
	operation: OperationRecord,
	nextStatus: OperationStatus,
	error?: ResearchError,
): Record<string, JsonValue> {
	if (!OPERATION_TRANSITIONS[operation.status].includes(nextStatus)) {
		throw new Error(`Invalid operation transition: ${operation.status} -> ${nextStatus}`);
	}
	const now = new Date().toISOString();
	const patch: Record<string, JsonValue> = { status: nextStatus };
	if (nextStatus === "running" || nextStatus === "awaiting_approval") {
		patch.startedAt = operation.startedAt ?? now;
		patch.finishedAt = null;
	}
	if (
		["succeeded", "partially_succeeded", "failed_retryable", "failed_permanent", "blocked", "cancelled"].includes(
			nextStatus,
		)
	) {
		patch.finishedAt = now;
	}
	if (nextStatus === "failed_retryable" || nextStatus === "failed_permanent") {
		if (error === undefined) throw new Error(`Operation transition to ${nextStatus} requires an error`);
		patch.error = error;
	}
	if (nextStatus === "succeeded") patch.error = null;
	return patch;
}

export async function withPersistedRunningOperation<Value>(
	projectRoot: string,
	operationId: string,
	effect: (operation: OperationRecord) => Promise<Value>,
): Promise<Value> {
	const result = await readRecord(projectRoot, "operation", operationId);
	if (!result.ok) throw new Error(result.errors[0].message);
	if (result.value.kind !== "operation" || result.value.status !== "running") {
		throw new Error(`Operation ${operationId} is not persisted as running`);
	}
	return effect(result.value);
}
