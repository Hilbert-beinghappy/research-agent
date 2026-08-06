// SPDX-License-Identifier: Apache-2.0

import type {
	JsonValue,
	Money,
	MonitorQuery,
	MonitorRun,
	MonitorSubscription,
	RecordRef,
	ResearchError,
	ResearchResult,
	ResearchTask,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { createRecord, createRecords, readRecord } from "../project/records.ts";

function audit(operationId: string, at: string) {
	return {
		createdAt: at,
		updatedAt: at,
		revision: 0,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

function queryHash(adapterId: string, adapterVersion: string, query: MonitorQuery) {
	return hashCanonicalJson({ adapterId, adapterVersion, query });
}

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

export interface CreateMonitorSubscriptionInput {
	name: string;
	adapterId: MonitorSubscription["adapterId"];
	adapterVersion: string;
	query: MonitorQuery;
	budget: MonitorSubscription["budget"];
	expectedManifestRevision: number;
	operationId: string;
}

export async function createMonitorSubscription(
	projectRoot: string,
	input: CreateMonitorSubscriptionInput,
): Promise<ResearchResult<MonitorSubscription>> {
	const at = new Date().toISOString();
	const subscription: MonitorSubscription = {
		kind: "monitor_subscription",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		monitorSubscriptionId: createOpaqueId("monitor_subscription"),
		monitorSubscriptionSeriesId: createOpaqueId("monitor_subscription"),
		version: 1,
		name: input.name,
		adapterId: input.adapterId,
		adapterVersion: input.adapterVersion,
		query: input.query,
		queryHash: queryHash(input.adapterId, input.adapterVersion, input.query),
		cursor: null,
		budget: input.budget,
		status: "active",
		supersedesMonitorSubscriptionId: null,
		lastSuccessfulRunId: null,
		createdAt: at,
		audit: audit(input.operationId, at),
	};
	const created = await createRecord(projectRoot, subscription, {
		expectedManifestRevision: input.expectedManifestRevision,
		operationId: input.operationId,
	});
	return created.ok ? successResult(subscription, input.operationId) : propagatedFailure(created, input.operationId);
}

export async function loadMonitorSubscription(projectRoot: string, id: string): Promise<MonitorSubscription> {
	const result = await readRecord(projectRoot, "monitor_subscription", id);
	if (!result.ok || result.value.kind !== "monitor_subscription") {
		throw new TypeError(`Invalid monitor subscription: ${id}`);
	}
	return result.value;
}

async function latestSubscription(projectRoot: string, seriesId: string): Promise<MonitorSubscription> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const matches: MonitorSubscription[] = [];
	for (const id of await listProjectRecordIds(opened.root, opened.manifest, "monitor_subscription")) {
		const result = await readRecord(opened.root, "monitor_subscription", id);
		if (!result.ok || result.value.kind !== "monitor_subscription") throw new TypeError(`Invalid monitor: ${id}`);
		if (result.value.monitorSubscriptionSeriesId === seriesId) matches.push(result.value);
	}
	const latest = matches.sort((left, right) => right.version - left.version)[0];
	if (latest === undefined) throw new TypeError(`Monitor series is missing: ${seriesId}`);
	return latest;
}

export async function reviseMonitorSubscription(
	projectRoot: string,
	current: MonitorSubscription,
	input: {
		name: string;
		query: MonitorQuery;
		budget: MonitorSubscription["budget"];
		status: MonitorSubscription["status"];
		expectedManifestRevision: number;
		operationId: string;
	},
): Promise<ResearchResult<MonitorSubscription>> {
	try {
		if (
			(await latestSubscription(projectRoot, current.monitorSubscriptionSeriesId)).monitorSubscriptionId !==
			current.monitorSubscriptionId
		) {
			return failureResult(
				"DATA_CONFLICT",
				"MONITOR_REVISION_STALE",
				"data_conflict",
				"Only the latest monitor subscription revision can be changed",
				input.operationId,
			);
		}
		const at = new Date().toISOString();
		const nextHash = queryHash(current.adapterId, current.adapterVersion, input.query);
		const subscription: MonitorSubscription = {
			...current,
			monitorSubscriptionId: createOpaqueId("monitor_subscription"),
			version: current.version + 1,
			name: input.name,
			query: input.query,
			queryHash: nextHash,
			cursor: nextHash.value === current.queryHash.value ? current.cursor : null,
			budget: input.budget,
			status: input.status,
			supersedesMonitorSubscriptionId: current.monitorSubscriptionId,
			lastSuccessfulRunId: nextHash.value === current.queryHash.value ? current.lastSuccessfulRunId : null,
			createdAt: at,
			audit: audit(input.operationId, at),
		};
		const created = await createRecord(projectRoot, subscription, {
			expectedManifestRevision: input.expectedManifestRevision,
			operationId: input.operationId,
		});
		return created.ok
			? successResult(subscription, input.operationId)
			: propagatedFailure(created, input.operationId);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"MONITOR_REVISION_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Monitor revision failed",
			input.operationId,
		);
	}
}

export interface MonitorBatchInput {
	createdSourceIds: string[];
	reusedSourceIds: string[];
	cursorAfter: JsonValue;
	requestCount: number;
	cost: Money;
	errors: ResearchError[];
	confirmedAt: string;
	startedAt: string;
	finishedAt: string;
	expectedManifestRevision: number;
	operationId: string;
}

export interface RecordMonitorBatchValue {
	run: MonitorRun;
	nextSubscription: MonitorSubscription | null;
	retryTask: ResearchTask | null;
	recordRefs: RecordRef[];
}

export async function recordMonitorBatch(
	projectRoot: string,
	subscription: MonitorSubscription,
	input: MonitorBatchInput,
): Promise<ResearchResult<RecordMonitorBatchValue>> {
	try {
		if (subscription.status !== "active") throw new TypeError("Monitor subscription is not active");
		if (
			(await latestSubscription(projectRoot, subscription.monitorSubscriptionSeriesId)).monitorSubscriptionId !==
			subscription.monitorSubscriptionId
		) {
			return failureResult(
				"DATA_CONFLICT",
				"MONITOR_CHECKPOINT_STALE",
				"data_conflict",
				"Only the latest monitor subscription revision can advance its cursor",
				input.operationId,
			);
		}
		if (
			new Set([...input.createdSourceIds, ...input.reusedSourceIds]).size !==
			input.createdSourceIds.length + input.reusedSourceIds.length
		) {
			throw new TypeError("Monitor created and reused source IDs must be disjoint and unique");
		}
		const hasOutput = input.createdSourceIds.length + input.reusedSourceIds.length > 0;
		const failed = input.errors.length > 0 && !hasOutput;
		const status: MonitorRun["status"] = failed
			? "failed_retryable"
			: input.errors.length > 0
				? "partially_succeeded"
				: "succeeded";
		const runId = createOpaqueId("monitor_run");
		const retryTaskId = failed ? createOpaqueId("task") : null;
		const nextSubscriptionId = failed ? null : createOpaqueId("monitor_subscription");
		const at = input.finishedAt;
		const normalizedErrors = input.errors.map((error) => ({
			...error,
			operationId: input.operationId,
			taskId: retryTaskId,
			retryable: failed ? true : error.retryable,
		}));
		const run: MonitorRun = {
			kind: "monitor_run",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			monitorRunId: runId,
			monitorSubscriptionId: subscription.monitorSubscriptionId,
			queryHash: subscription.queryHash,
			cursorBefore: subscription.cursor,
			cursorAfter: failed ? subscription.cursor : input.cursorAfter,
			createdSourceIds: input.createdSourceIds,
			reusedSourceIds: input.reusedSourceIds,
			requestCount: input.requestCount,
			cost: input.cost,
			status,
			errors: normalizedErrors,
			operationId: input.operationId,
			retryTaskId,
			nextMonitorSubscriptionId: nextSubscriptionId,
			confirmedAt: input.confirmedAt,
			startedAt: input.startedAt,
			finishedAt: input.finishedAt,
			audit: audit(input.operationId, at),
		};
		const nextSubscription: MonitorSubscription | null =
			nextSubscriptionId === null
				? null
				: {
						...subscription,
						monitorSubscriptionId: nextSubscriptionId,
						version: subscription.version + 1,
						cursor: input.cursorAfter,
						supersedesMonitorSubscriptionId: subscription.monitorSubscriptionId,
						lastSuccessfulRunId: runId,
						createdAt: at,
						audit: audit(input.operationId, at),
					};
		const retryTask: ResearchTask | null =
			retryTaskId === null
				? null
				: {
						kind: "task",
						schemaVersion: RESEARCH_SCHEMA_VERSION,
						taskId: retryTaskId,
						taskType: "literature_monitor_retry",
						title: `Retry monitor ${subscription.name}`,
						inputs: [{ kind: "monitor_subscription", id: subscription.monitorSubscriptionId, revision: 0 }],
						inputFiles: [],
						expectedOutputs: ["monitor run", "next monitor subscription revision"],
						outputs: [],
						outputFiles: [],
						dependencyTaskIds: [],
						status: "failed_retryable",
						attemptCount: 1,
						maxAttempts: 3,
						idempotencyKey: `monitor:${subscription.monitorSubscriptionId}:${subscription.queryHash.value}`,
						operationIds: [input.operationId],
						errors: normalizedErrors,
						resumeCursor: subscription.cursor,
						budget: { estimated: subscription.budget.maxCost, actual: input.cost },
						createdAt: at,
						startedAt: input.startedAt,
						finishedAt: input.finishedAt,
						updatedAt: at,
						revision: 0,
					};
		const records = [
			run,
			...(nextSubscription === null ? [] : [nextSubscription]),
			...(retryTask === null ? [] : [retryTask]),
		];
		const created = await createRecords(projectRoot, records, {
			expectedManifestRevision: input.expectedManifestRevision,
			operationId: input.operationId,
		});
		if (!created.ok) return propagatedFailure(created, input.operationId);
		return successResult({ run, nextSubscription, retryTask, recordRefs: created.value }, input.operationId);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"MONITOR_BATCH_COMMIT_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Monitor batch could not be committed",
			input.operationId,
		);
	}
}
