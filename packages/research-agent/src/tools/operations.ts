// SPDX-License-Identifier: Apache-2.0

import type {
	FileRef,
	HashValue,
	OperationRecord,
	RecordRef,
	ResearchResult,
	SessionLink,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { operationTransitionPatch } from "../kernel/operations.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { createRecord, readRecord, updateRecord } from "../project/records.ts";

export interface StartOperationInput {
	operationKind: "tool" | "adapter" | "human";
	name: string;
	implementationVersion: string;
	session: SessionLink | null;
	inputs?: RecordRef[];
	inputFiles?: FileRef[];
	adapter?: {
		adapterId: string;
		adapterVersion: string;
		capabilitySnapshotHash: HashValue;
	};
}

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

export async function startOperation(
	projectRoot: string,
	input: StartOperationInput,
): Promise<ResearchResult<OperationRecord>> {
	const operationId = createOpaqueId("operation");
	try {
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") {
			return failureResult(
				"PERMANENT_FAILURE",
				"OPERATION_PROJECT_READ_ONLY",
				"migration",
				"Research project schema is read-only",
				operationId,
			);
		}
		if (input.operationKind === "adapter" && input.adapter === undefined) {
			throw new TypeError("Adapter operation metadata is required");
		}
		if (input.operationKind !== "adapter" && input.adapter !== undefined) {
			throw new TypeError("Only adapter operations can declare adapter metadata");
		}
		const now = new Date().toISOString();
		const operation: OperationRecord = {
			kind: "operation",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			operationId,
			taskId: null,
			operationKind: input.operationKind,
			name: input.name,
			implementationVersion: input.implementationVersion,
			status: "planned",
			session: input.session,
			actor: {
				type: input.operationKind,
				id: input.adapter?.adapterId ?? input.name,
			},
			modelExecution: null,
			adapterExecution:
				input.adapter === undefined
					? null
					: {
							adapterId: input.adapter.adapterId,
							adapterVersion: input.adapter.adapterVersion,
							capabilitySnapshotHash: input.adapter.capabilitySnapshotHash,
						},
			inputs: [...(input.inputs ?? [])],
			inputFiles: [...(input.inputFiles ?? [])],
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
		const created = await createRecord(opened.root, operation, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		if (!created.ok) return propagatedFailure(created, operationId);
		const current = await readRecord(opened.root, "operation", operationId);
		if (!current.ok) return propagatedFailure(current, operationId);
		if (current.value.kind !== "operation") throw new TypeError("Created operation is invalid");
		const afterCreate = await openProject(opened.root);
		if (afterCreate.compatibility !== "current") throw new TypeError("Research project schema became read-only");
		const started = await updateRecord(opened.root, "operation", operationId, {
			expectedManifestRevision: afterCreate.manifest.revision,
			expectedRecordRevision: current.value.audit.revision,
			operationId,
			changes: operationTransitionPatch(current.value, "running"),
		});
		if (!started.ok) return propagatedFailure(started, operationId);
		const running = await readRecord(opened.root, "operation", operationId);
		if (!running.ok) return propagatedFailure(running, operationId);
		return running.value.kind === "operation"
			? successResult(running.value, operationId)
			: failureResult(
					"PERMANENT_FAILURE",
					"OPERATION_READBACK_INVALID",
					"integrity",
					"Started operation could not be read back",
					operationId,
				);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"OPERATION_START_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Operation could not be started",
			operationId,
		);
	}
}

export async function finishOperation(
	projectRoot: string,
	operationId: string,
	result: ResearchResult<unknown>,
	outputs: readonly RecordRef[] = [],
	outputFiles: readonly FileRef[] = [],
): Promise<ResearchResult<OperationRecord>> {
	try {
		const current = await readRecord(projectRoot, "operation", operationId);
		if (!current.ok) return propagatedFailure(current, operationId);
		if (current.value.kind !== "operation" || current.value.status !== "running") {
			return failureResult(
				"PERMANENT_FAILURE",
				"OPERATION_NOT_RUNNING",
				"validation",
				`Operation ${operationId} is not running`,
				operationId,
			);
		}
		const nextStatus = result.ok
			? result.status === "PARTIAL_SUCCESS"
				? "partially_succeeded"
				: "succeeded"
			: result.status === "RETRYABLE_FAILURE" || result.status === "EXTERNAL_SERVICE_FAILURE"
				? "failed_retryable"
				: result.status === "PERMISSION_BLOCKED"
					? "blocked"
					: "failed_permanent";
		const error = result.errors[0];
		const transition =
			nextStatus === "failed_retryable" || nextStatus === "failed_permanent"
				? operationTransitionPatch(current.value, nextStatus, error)
				: operationTransitionPatch(current.value, nextStatus);
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const updated = await updateRecord(projectRoot, "operation", operationId, {
			expectedManifestRevision: opened.manifest.revision,
			expectedRecordRevision: current.value.audit.revision,
			operationId,
			changes: {
				...transition,
				outputs: [...outputs],
				outputFiles: [...outputFiles],
				error: result.ok ? (result.status === "PARTIAL_SUCCESS" ? (error ?? null) : null) : error,
			},
		});
		if (!updated.ok) return propagatedFailure(updated, operationId);
		const finished = await readRecord(projectRoot, "operation", operationId);
		if (!finished.ok) return propagatedFailure(finished, operationId);
		return finished.value.kind === "operation"
			? successResult(finished.value, operationId)
			: failureResult(
					"PERMANENT_FAILURE",
					"OPERATION_READBACK_INVALID",
					"integrity",
					"Finished operation could not be read back",
					operationId,
				);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"OPERATION_FINISH_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Operation could not be finished",
			operationId,
		);
	}
}
