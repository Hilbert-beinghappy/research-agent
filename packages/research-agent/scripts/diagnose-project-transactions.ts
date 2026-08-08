// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { OperationRecord } from "../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { createOpaqueId } from "../src/kernel/identity.ts";
import { initializeProject } from "../src/project/init.ts";
import { openProject } from "../src/project/open.ts";
import { createRecordWithWriterLeaseHeld } from "../src/project/records.ts";
import {
	emitProjectTransactionTrace,
	type ProjectTransactionTracePhase,
	type ProjectTransactionTraceRecord,
} from "../src/project/transaction-trace.ts";
import { listPendingProjectTransactions } from "../src/project/transactions.ts";
import { validateProject } from "../src/project/validate.ts";
import { withProjectWriterLease } from "../src/project/writer-lock.ts";

interface WorkerResult {
	count: number;
	conflicts: number;
}

interface DiagnosticCaseResult {
	processes: number;
	writesPerProcess: number;
	repetition: number;
	elapsedMs: number;
	conflicts: number;
	conflictRate: number | null;
	finalRevision: number | null;
	operationCount: number | null;
	pendingTransactions: number | null;
	projectValid: boolean;
	fileHashCount: number;
	performanceBudgetMs: number | null;
	performanceBudgetPassed: boolean | null;
	conflictRateBudget: number | null;
	conflictRateBudgetPassed: boolean | null;
	phaseTimings: Partial<
		Record<ProjectTransactionTracePhase, { samples: number; totalMs: number; p50Ms: number; p95Ms: number }>
	>;
	status: "passed" | "failed";
	errorCode: string | null;
}

interface GrowthCheck {
	processes: number;
	repetition: number;
	fromTotalWrites: number;
	toTotalWrites: number;
	ratio: number;
	budget: number;
	passed: boolean;
}

function operationRecord(operationId: string, name: string): OperationRecord {
	const now = new Date().toISOString();
	return {
		kind: "operation",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		operationId,
		taskId: null,
		operationKind: "tool",
		name,
		implementationVersion: "transaction-diagnostic-v1",
		status: "planned",
		session: null,
		actor: { type: "tool", id: "transaction-diagnostic" },
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

function diagnosticErrorCode(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	for (const prefix of ["DATA_CONFLICT", "WORKER_TIMEOUT", "WORKER_FAILED", "PROJECT_INVALID"] as const) {
		if (message.startsWith(prefix)) return prefix;
	}
	return error instanceof TypeError ? "TYPE_ERROR" : "DIAGNOSTIC_FAILED";
}

function isTraceRecord(value: unknown): value is ProjectTransactionTraceRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.format === "doro-project-transaction-trace" &&
		record.version === 1 &&
		typeof record.timestamp === "string" &&
		typeof record.processIdHash === "string" &&
		typeof record.phase === "string" &&
		typeof record.state === "string"
	);
}

function parseTraceLine(line: string): ProjectTransactionTraceRecord | null {
	try {
		const value: unknown = JSON.parse(line);
		return isTraceRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function openFileCount(pid: number | undefined): number | undefined {
	if (pid === undefined) return undefined;
	try {
		if (process.platform === "linux") return readdirSync(`/proc/${pid}/fd`).length;
		if (process.platform === "darwin") {
			const result = spawnSync("lsof", ["-a", "-p", String(pid), "-Ff"], {
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
			});
			if (result.status !== 0) return undefined;
			return result.stdout.split("\n").filter((line) => /^f\d+$/.test(line)).length;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function percentile(values: readonly number[], quantile: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
	return value === undefined ? 0 : Number(value.toFixed(3));
}

function phaseTimings(records: readonly ProjectTransactionTraceRecord[]): DiagnosticCaseResult["phaseTimings"] {
	const grouped = new Map<ProjectTransactionTracePhase, number[]>();
	for (const record of records) {
		if (record.state !== "completed" || record.elapsedMs === undefined) continue;
		const values = grouped.get(record.phase) ?? [];
		values.push(record.elapsedMs);
		grouped.set(record.phase, values);
	}
	return Object.fromEntries(
		[...grouped].map(([phase, values]) => [
			phase,
			{
				samples: values.length,
				totalMs: Number(values.reduce((total, value) => total + value, 0).toFixed(3)),
				p50Ms: percentile(values, 0.5),
				p95Ms: percentile(values, 0.95),
			},
		]),
	);
}

function argumentValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
	return parsed;
}

function positiveIntegerList(value: string, name: string): number[] {
	const values = [...new Set(value.split(",").map((part) => positiveInteger(part.trim(), name)))];
	if (values.length === 0) throw new TypeError(`${name} must contain at least one value`);
	return values;
}

function positiveNumber(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive number`);
	return parsed;
}

async function runWorkerMode(projectRoot: string, workerId: string, count: number): Promise<void> {
	const traceContext = { workerId, requestedWrites: count };
	const started = performance.now();
	const conflicts = 0;
	emitProjectTransactionTrace("worker_batch", "started", traceContext);
	try {
		for (let index = 0; index < count; index += 1) {
			const operationId = createOpaqueId("operation");
			const record = operationRecord(operationId, `diagnostic-${workerId}-${index}`);
			const result = await withProjectWriterLease(
				projectRoot,
				async () => {
					const opened = await openProject(projectRoot);
					if (opened.compatibility !== "current") throw new Error("PROJECT_INVALID: expected current project");
					return createRecordWithWriterLeaseHeld(projectRoot, record, {
						expectedManifestRevision: opened.manifest.revision,
						operationId,
					});
				},
				traceContext,
			);
			if (!result.ok) throw new Error("WORKER_FAILED: record creation failed");
			const completedWrites = index + 1;
			if (completedWrites % 25 === 0 || completedWrites === count) {
				emitProjectTransactionTrace("worker_batch", "progress", {
					...traceContext,
					operationId,
					completedWrites,
					conflictCount: conflicts,
				});
			}
		}
		emitProjectTransactionTrace(
			"worker_batch",
			"completed",
			{ ...traceContext, completedWrites: count, conflictCount: conflicts },
			performance.now() - started,
		);
		process.stdout.write(`${JSON.stringify({ count, conflicts } satisfies WorkerResult)}\n`);
	} catch (error) {
		emitProjectTransactionTrace(
			"worker_batch",
			"failed",
			{ ...traceContext, conflictCount: conflicts },
			performance.now() - started,
			error,
		);
		throw error;
	}
}

async function runWorker(
	projectRoot: string,
	workerId: string,
	count: number,
	watchdogMs: number,
	timeoutMs: number,
	traceRecords: ProjectTransactionTraceRecord[],
): Promise<WorkerResult> {
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", import.meta.filename, "--worker", projectRoot, workerId, String(count)],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, RESEARCH_TX_TRACE: "1" },
		},
	);
	let stdout = "";
	let stderrBuffer = "";
	let lastTrace: ProjectTransactionTraceRecord | null = null;
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderrBuffer += chunk;
		for (;;) {
			const newline = stderrBuffer.indexOf("\n");
			if (newline < 0) break;
			const record = parseTraceLine(stderrBuffer.slice(0, newline));
			stderrBuffer = stderrBuffer.slice(newline + 1);
			if (record === null) continue;
			lastTrace = record;
			traceRecords.push(record);
		}
	});
	const watchdog = setTimeout(() => {
		const files = openFileCount(child.pid);
		const record = {
			format: "doro-project-transaction-trace",
			version: 1,
			timestamp: new Date().toISOString(),
			processIdHash: lastTrace?.processIdHash ?? "unavailable",
			phase: "watchdog",
			state: "progress",
			...(lastTrace?.workerIdHash === undefined ? {} : { workerIdHash: lastTrace.workerIdHash }),
			...(lastTrace?.completedWrites === undefined ? {} : { completedWrites: lastTrace.completedWrites }),
			...(lastTrace?.requestedWrites === undefined ? {} : { requestedWrites: lastTrace.requestedWrites }),
			...(lastTrace?.conflictCount === undefined ? {} : { conflictCount: lastTrace.conflictCount }),
			...(files === undefined ? {} : { openFileCount: files }),
		} as const satisfies ProjectTransactionTraceRecord;
		traceRecords.push(record);
		process.stderr.write(`${JSON.stringify(record)}\n`);
	}, watchdogMs);
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	const [code] = (await once(child, "exit")) as [number | null];
	clearTimeout(watchdog);
	clearTimeout(timeout);
	const trailing = parseTraceLine(stderrBuffer.trim());
	if (trailing !== null) traceRecords.push(trailing);
	if (timedOut) throw new Error("WORKER_TIMEOUT: diagnostic worker exceeded its hard limit");
	if (code !== 0) throw new Error(`WORKER_FAILED: diagnostic worker exited with code ${code ?? "signal"}`);
	const result = JSON.parse(stdout) as WorkerResult;
	if (result.count !== count || !Number.isInteger(result.conflicts) || result.conflicts < 0) {
		throw new TypeError("Invalid diagnostic worker result");
	}
	return result;
}

async function runDiagnosticCase(
	parentDirectory: string,
	processes: number,
	writesPerProcess: number,
	repetition: number,
	watchdogMs: number,
	timeoutMs: number,
	maxElapsedMs: number | null,
	maxConflictRate: number | null,
	allTraceRecords: ProjectTransactionTraceRecord[],
): Promise<DiagnosticCaseResult> {
	const projectRoot = join(parentDirectory, `p${processes}-n${writesPerProcess}-r${repetition}`);
	await initializeProject(projectRoot, { title: "Transaction scaling diagnostic" });
	const caseTraceRecords: ProjectTransactionTraceRecord[] = [];
	const started = performance.now();
	try {
		const workerOutcomes = await Promise.allSettled(
			Array.from({ length: processes }, (_, index) =>
				runWorker(projectRoot, `worker-${index}`, writesPerProcess, watchdogMs, timeoutMs, caseTraceRecords),
			),
		);
		const workers: WorkerResult[] = [];
		for (const outcome of workerOutcomes) {
			if (outcome.status === "rejected") throw outcome.reason;
			workers.push(outcome.value);
		}
		const expectedCount = processes * writesPerProcess;
		const opened = await openProject(projectRoot, expectedCount);
		if (opened.compatibility !== "current") throw new Error("PROJECT_INVALID: expected current project");
		const operationCount = opened.manifest.recordSets.find(({ kind }) => kind === "operation")?.count ?? null;
		const pendingTransactions = (await listPendingProjectTransactions(projectRoot)).length;
		const validation = await validateProject(projectRoot);
		const projectValid = validation.valid && operationCount === expectedCount && pendingTransactions === 0;
		if (!projectValid) throw new Error("PROJECT_INVALID: transaction diagnostic lost consistency");
		const elapsedMs = Number((performance.now() - started).toFixed(3));
		const performanceBudgetPassed = maxElapsedMs === null ? null : elapsedMs <= maxElapsedMs;
		const conflicts = workers.reduce((total, worker) => total + worker.conflicts, 0);
		const conflictRate = conflicts / expectedCount;
		const conflictRateBudgetPassed = maxConflictRate === null ? null : conflictRate < maxConflictRate;
		const errorCode =
			performanceBudgetPassed === false
				? "PERFORMANCE_BUDGET_EXCEEDED"
				: conflictRateBudgetPassed === false
					? "CONFLICT_RATE_EXCEEDED"
					: null;
		allTraceRecords.push(...caseTraceRecords);
		return {
			processes,
			writesPerProcess,
			repetition,
			elapsedMs,
			conflicts,
			conflictRate,
			finalRevision: opened.manifest.revision,
			operationCount,
			pendingTransactions,
			projectValid,
			fileHashCount: caseTraceRecords.reduce((total, record) => total + (record.fileHashCount ?? 0), 0),
			performanceBudgetMs: maxElapsedMs,
			performanceBudgetPassed,
			conflictRateBudget: maxConflictRate,
			conflictRateBudgetPassed,
			phaseTimings: phaseTimings(caseTraceRecords),
			status: errorCode === null ? "passed" : "failed",
			errorCode,
		};
	} catch (error) {
		allTraceRecords.push(...caseTraceRecords);
		return {
			processes,
			writesPerProcess,
			repetition,
			elapsedMs: Number((performance.now() - started).toFixed(3)),
			conflicts: 0,
			conflictRate: null,
			finalRevision: null,
			operationCount: null,
			pendingTransactions: null,
			projectValid: false,
			fileHashCount: caseTraceRecords.reduce((total, record) => total + (record.fileHashCount ?? 0), 0),
			performanceBudgetMs: maxElapsedMs,
			performanceBudgetPassed: null,
			conflictRateBudget: maxConflictRate,
			conflictRateBudgetPassed: null,
			phaseTimings: phaseTimings(caseTraceRecords),
			status: "failed",
			errorCode: diagnosticErrorCode(error),
		};
	}
}

function calculateGrowthChecks(results: readonly DiagnosticCaseResult[], maxGrowthRatio: number | null): GrowthCheck[] {
	if (maxGrowthRatio === null) return [];
	const checks: GrowthCheck[] = [];
	const cells = new Map<string, DiagnosticCaseResult[]>();
	for (const result of results) {
		if (result.status !== "passed") continue;
		const key = `${result.processes}:${result.repetition}`;
		const values = cells.get(key) ?? [];
		values.push(result);
		cells.set(key, values);
	}
	for (const values of cells.values()) {
		values.sort((left, right) => left.writesPerProcess - right.writesPerProcess);
		for (let index = 1; index < values.length; index += 1) {
			const previous = values[index - 1];
			const current = values[index];
			if (previous === undefined || current === undefined) continue;
			const ratio = Number((current.elapsedMs / previous.elapsedMs).toFixed(3));
			checks.push({
				processes: current.processes,
				repetition: current.repetition,
				fromTotalWrites: previous.processes * previous.writesPerProcess,
				toTotalWrites: current.processes * current.writesPerProcess,
				ratio,
				budget: maxGrowthRatio,
				passed: ratio <= maxGrowthRatio,
			});
		}
	}
	return checks;
}

async function runCoordinator(): Promise<void> {
	const counts = positiveIntegerList(argumentValue("--counts") ?? "100,250,500", "--counts");
	const processCounts = positiveIntegerList(argumentValue("--processes") ?? "1,2", "--processes");
	if (processCounts.some((value) => value > 2)) throw new TypeError("--processes supports only 1 or 2");
	const repetitions = positiveInteger(argumentValue("--repetitions") ?? "1", "--repetitions");
	const watchdogMs = positiveInteger(argumentValue("--watchdog-ms") ?? "240000", "--watchdog-ms");
	const timeoutMs = positiveInteger(argumentValue("--timeout-ms") ?? "600000", "--timeout-ms");
	const maxElapsedArgument = argumentValue("--max-elapsed-ms");
	const maxElapsedMs =
		maxElapsedArgument === undefined ? null : positiveInteger(maxElapsedArgument, "--max-elapsed-ms");
	const maxConflictRateArgument = argumentValue("--max-conflict-rate");
	const maxConflictRate =
		maxConflictRateArgument === undefined ? null : positiveNumber(maxConflictRateArgument, "--max-conflict-rate");
	const maxGrowthRatioArgument = argumentValue("--max-growth-ratio");
	const maxGrowthRatio =
		maxGrowthRatioArgument === undefined ? null : positiveNumber(maxGrowthRatioArgument, "--max-growth-ratio");
	if (watchdogMs >= timeoutMs) throw new TypeError("--watchdog-ms must be less than --timeout-ms");
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-transaction-diagnostic-"));
	const traceRecords: ProjectTransactionTraceRecord[] = [];
	try {
		const results: DiagnosticCaseResult[] = [];
		for (const processes of processCounts) {
			for (const writesPerProcess of counts) {
				for (let repetition = 1; repetition <= repetitions; repetition += 1) {
					results.push(
						await runDiagnosticCase(
							temporaryDirectory,
							processes,
							writesPerProcess,
							repetition,
							watchdogMs,
							timeoutMs,
							maxElapsedMs,
							maxConflictRate,
							traceRecords,
						),
					);
				}
			}
		}
		const growthChecks = calculateGrowthChecks(results, maxGrowthRatio);
		const passed = results.every(({ status }) => status === "passed") && growthChecks.every(({ passed }) => passed);
		const report = {
			benchmark: "doro-project-transaction-diagnostic-v1",
			generatedAt: new Date().toISOString(),
			platform: `${process.platform}-${process.arch}`,
			node: process.version,
			configuration: {
				counts,
				processCounts,
				repetitions,
				watchdogMs,
				timeoutMs,
				maxElapsedMs,
				maxConflictRate,
				maxGrowthRatio,
			},
			results,
			growthChecks,
			usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
			status: passed ? "passed" : "failed",
		};
		const output = `${JSON.stringify(report, null, 2)}\n`;
		const outputPath = argumentValue("--output");
		if (outputPath !== undefined) {
			const absolutePath = resolve(process.cwd(), outputPath);
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, output);
		}
		const traceOutputPath = argumentValue("--trace-output");
		if (traceOutputPath !== undefined) {
			const absolutePath = resolve(process.cwd(), traceOutputPath);
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, `${traceRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
		}
		process.stdout.write(output);
		if (!passed) process.exitCode = 1;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

const workerIndex = process.argv.indexOf("--worker");
if (workerIndex >= 0) {
	const projectRoot = process.argv[workerIndex + 1];
	const workerId = process.argv[workerIndex + 2];
	const count = process.argv[workerIndex + 3];
	if (projectRoot === undefined || workerId === undefined || count === undefined) {
		throw new TypeError("--worker requires project root, worker ID, and count");
	}
	await runWorkerMode(projectRoot, workerId, positiveInteger(count, "worker count"));
} else {
	await runCoordinator();
}
