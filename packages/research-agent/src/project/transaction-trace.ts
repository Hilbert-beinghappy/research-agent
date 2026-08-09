// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RecordKind } from "../contracts/schemas.ts";

export type ProjectTransactionTracePhase =
	| "writer_lease_wait"
	| "writer_lease_renew"
	| "writer_lease_release"
	| "pending_transaction_scan"
	| "project_open"
	| "record_index_hash"
	| "transaction_preflight"
	| "journal_prepare"
	| "staged_verify"
	| "data_commit"
	| "manifest_commit"
	| "post_commit_verify"
	| "journal_archive"
	| "transaction_rollback"
	| "worker_batch"
	| "watchdog";

export type ProjectTransactionTraceState = "started" | "progress" | "completed" | "failed";

export interface ProjectTransactionTraceContext {
	operationId?: string;
	transactionId?: string;
	workerId?: string;
	manifestRevision?: number;
	recordKind?: RecordKind;
	recordCount?: number;
	writeCount?: number;
	completedWrites?: number;
	requestedWrites?: number;
	conflictCount?: number;
	fileHashCount?: number;
	renewalCount?: number;
	openFileCount?: number;
}

export interface ProjectTransactionTraceRecord {
	format: "doro-project-transaction-trace";
	version: 1;
	timestamp: string;
	processIdHash: string;
	phase: ProjectTransactionTracePhase;
	state: ProjectTransactionTraceState;
	operationIdHash?: string;
	transactionIdHash?: string;
	workerIdHash?: string;
	manifestRevision?: number;
	recordKind?: RecordKind;
	recordCount?: number;
	writeCount?: number;
	completedWrites?: number;
	requestedWrites?: number;
	conflictCount?: number;
	fileHashCount?: number;
	renewalCount?: number;
	openFileCount?: number;
	elapsedMs?: number;
	errorCode?: string;
}

const TRACE_ENABLED = process.env.RESEARCH_TX_TRACE === "1";

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const PROCESS_ID_HASH = shortHash(`pid:${process.pid}`);

function errorCode(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	for (const prefix of [
		"DATA_CONFLICT",
		"PROJECT_RECOVERY_REQUIRED",
		"PROJECT_WRITER_LOCKED",
		"PROJECT_WRITER_LOCK_REENTRANT",
		"PROJECT_WRITER_LEASE_LOST",
	] as const) {
		if (message.startsWith(prefix)) return prefix;
	}
	return error instanceof TypeError ? "TYPE_ERROR" : "UNCLASSIFIED_ERROR";
}

function finiteNonNegative(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.max(0, Number(value.toFixed(3)));
}

export function emitProjectTransactionTrace(
	phase: ProjectTransactionTracePhase,
	state: ProjectTransactionTraceState,
	context: ProjectTransactionTraceContext = {},
	elapsedMs?: number,
	error?: unknown,
): void {
	if (!TRACE_ENABLED) return;
	const record: ProjectTransactionTraceRecord = {
		format: "doro-project-transaction-trace",
		version: 1,
		timestamp: new Date().toISOString(),
		processIdHash: PROCESS_ID_HASH,
		phase,
		state,
		...(context.operationId === undefined ? {} : { operationIdHash: shortHash(context.operationId) }),
		...(context.transactionId === undefined ? {} : { transactionIdHash: shortHash(context.transactionId) }),
		...(context.workerId === undefined ? {} : { workerIdHash: shortHash(context.workerId) }),
		...(context.manifestRevision === undefined ? {} : { manifestRevision: context.manifestRevision }),
		...(context.recordKind === undefined ? {} : { recordKind: context.recordKind }),
		...(context.recordCount === undefined ? {} : { recordCount: context.recordCount }),
		...(context.writeCount === undefined ? {} : { writeCount: context.writeCount }),
		...(context.completedWrites === undefined ? {} : { completedWrites: context.completedWrites }),
		...(context.requestedWrites === undefined ? {} : { requestedWrites: context.requestedWrites }),
		...(context.conflictCount === undefined ? {} : { conflictCount: context.conflictCount }),
		...(context.fileHashCount === undefined ? {} : { fileHashCount: context.fileHashCount }),
		...(context.renewalCount === undefined ? {} : { renewalCount: context.renewalCount }),
		...(context.openFileCount === undefined ? {} : { openFileCount: context.openFileCount }),
		...(elapsedMs === undefined ? {} : { elapsedMs: finiteNonNegative(elapsedMs) }),
		...(error === undefined ? {} : { errorCode: errorCode(error) }),
	};
	try {
		process.stderr.write(`${JSON.stringify(record)}\n`);
	} catch {
		// Diagnostics must never change project behavior.
	}
}

export async function traceProjectTransactionPhase<Value>(
	phase: ProjectTransactionTracePhase,
	context: ProjectTransactionTraceContext,
	action: () => Promise<Value>,
): Promise<Value> {
	if (!TRACE_ENABLED) return action();
	emitProjectTransactionTrace(phase, "started", context);
	const started = performance.now();
	try {
		const value = await action();
		emitProjectTransactionTrace(phase, "completed", context, performance.now() - started);
		return value;
	} catch (error) {
		emitProjectTransactionTrace(phase, "failed", context, performance.now() - started, error);
		throw error;
	}
}
