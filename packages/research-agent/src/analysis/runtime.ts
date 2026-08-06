// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import type {
	AnalysisRun,
	AnalysisSpecification,
	FileRef,
	HashValue,
	JsonValue,
	RecordRef,
	ResearchError,
	ResearchResult,
	ResearchTask,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { createRecords } from "../project/records.ts";

export interface RuntimeDetection {
	kind: AnalysisRun["runtime"]["kind"];
	available: boolean;
	executable: string | null;
	runtimeVersion: string | null;
	reason: string | null;
}

export interface RuntimeProcessRequest {
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface RuntimeProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
}

export type RuntimeExecutor = (request: RuntimeProcessRequest) => Promise<RuntimeProcessResult>;

export interface AnalysisExecutionValue {
	task: ResearchTask;
	run: AnalysisRun;
}

export interface AnalysisExecutionOutcome {
	result: ResearchResult<AnalysisExecutionValue>;
	task: ResearchTask | null;
	run: AnalysisRun | null;
}

export interface ExecuteAnalysisOptions {
	executable?: string;
	executor?: RuntimeExecutor;
	signal?: AbortSignal;
	analysisRunId?: string;
	taskId?: string;
}

const EXPORTED_ENVIRONMENT = [
	"PATH",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"R_LIBS",
	"R_LIBS_USER",
	"VIRTUAL_ENV",
	"PYTHONPATH",
] as const;

function processError(
	code: string,
	category: ResearchError["category"],
	message: string,
	operationId: string,
	details: JsonValue = null,
): ResearchError {
	return {
		code,
		category,
		message,
		retryable: false,
		source: "analysis-runtime",
		operationId,
		taskId: null,
		details,
		occurredAt: new Date().toISOString(),
		causeCode: null,
	};
}

export async function executeRuntimeProcess(request: RuntimeProcessRequest): Promise<RuntimeProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(request.executable, request.args, {
			cwd: request.cwd,
			env: request.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		const finish = (result: RuntimeProcessResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const abort = () => {
			aborted = true;
			child.kill("SIGTERM");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, request.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				request.signal?.removeEventListener("abort", abort);
				reject(error);
			}
		});
		child.once("close", (exitCode) => finish({ exitCode, stdout, stderr, timedOut, aborted }));
		if (request.signal?.aborted) abort();
		else request.signal?.addEventListener("abort", abort, { once: true });
	});
}

async function executablePath(name: string): Promise<string | null> {
	try {
		if (name.includes("/")) {
			await access(name);
			return name;
		}
		const result = await executeRuntimeProcess({
			executable: "/usr/bin/which",
			args: [name],
			cwd: process.cwd(),
			env: { PATH: process.env.PATH },
			timeoutMs: 5_000,
		});
		return result.exitCode === 0 ? result.stdout.trim() || null : null;
	} catch {
		return null;
	}
}

export async function detectAnalysisRuntime(
	kind: RuntimeDetection["kind"],
	executable?: string,
	executor: RuntimeExecutor = executeRuntimeProcess,
): Promise<RuntimeDetection> {
	const candidates =
		executable === undefined
			? kind === "python"
				? ["python3"]
				: kind === "r"
					? ["Rscript"]
					: ["stata-mp", "stata-se", "stata"]
			: [executable];
	for (const candidate of candidates) {
		const path = await executablePath(candidate);
		if (path === null) continue;
		if (kind === "stata") {
			return {
				kind,
				available: true,
				executable: path,
				runtimeVersion: "installed (version not queried)",
				reason: null,
			};
		}
		try {
			const version = await executor({
				executable: path,
				args: ["--version"],
				cwd: process.cwd(),
				env: Object.fromEntries(EXPORTED_ENVIRONMENT.map((key) => [key, process.env[key]])),
				timeoutMs: 5_000,
			});
			if (version.exitCode === 0) {
				return {
					kind,
					available: true,
					executable: path,
					runtimeVersion: `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/u)[0] ?? "unknown",
					reason: null,
				};
			}
		} catch {
			// Try the next executable candidate.
		}
	}
	return {
		kind,
		available: false,
		executable: null,
		runtimeVersion: null,
		reason: `${kind} runtime is not installed or not executable`,
	};
}

function mediaType(path: string): string {
	if (path.endsWith(".json")) return "application/json";
	if (path.endsWith(".csv")) return "text/csv";
	if (path.endsWith(".md")) return "text/markdown";
	if (path.endsWith(".txt") || path.endsWith(".log")) return "text/plain";
	return "application/octet-stream";
}

async function fileRef(projectRoot: string, path: string): Promise<FileRef> {
	const absolutePath = await resolveProjectPath(projectRoot, path);
	const metadata = await stat(absolutePath);
	if (!metadata.isFile()) throw new TypeError(`Analysis output is not a file: ${path}`);
	return { path, hash: await hashFile(absolutePath), mediaType: mediaType(path), bytes: metadata.size };
}

async function analysisStatus(outputDirectory: string): Promise<"succeeded" | "non_converged" | null> {
	try {
		const value = JSON.parse(await readFile(join(outputDirectory, "analysis-status.json"), "utf8")) as unknown;
		if (
			value !== null &&
			typeof value === "object" &&
			"status" in value &&
			((value as { status: unknown }).status === "succeeded" ||
				(value as { status: unknown }).status === "non_converged")
		) {
			return (value as { status: "succeeded" | "non_converged" }).status;
		}
		throw new TypeError("analysis-status.json has an invalid status");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function failedOutcome(
	status: ResearchResult<AnalysisExecutionValue>["status"],
	error: ResearchError,
	operationId: string,
	taskId: string,
	runId: string,
): ResearchResult<AnalysisExecutionValue> {
	if (status === "SUCCESS" || status === "PARTIAL_SUCCESS")
		throw new TypeError("Failure outcome requires failure status");
	return {
		ok: false,
		status,
		value: null,
		errors: [error],
		meta: { operationId, taskId, warnings: [`Analysis run ${runId} ended with ${error.code}`] },
	};
}

export async function executeAnalysis(
	projectRoot: string,
	specification: AnalysisSpecification,
	operationId: string,
	options: ExecuteAnalysisOptions = {},
): Promise<AnalysisExecutionOutcome> {
	if (specification.status !== "confirmed") {
		return {
			result: failureResult(
				"PERMISSION_BLOCKED",
				"ANALYSIS_SPECIFICATION_UNCONFIRMED",
				"permission",
				"Analysis specification must be confirmed before execution",
				operationId,
			),
			task: null,
			run: null,
		};
	}
	const executor = options.executor ?? executeRuntimeProcess;
	const detected = await detectAnalysisRuntime(specification.runtime, options.executable, executor);
	if (!detected.available || detected.executable === null || detected.runtimeVersion === null) {
		return {
			result: failureResult(
				"PERMANENT_FAILURE",
				"ANALYSIS_RUNTIME_UNAVAILABLE",
				"runtime",
				detected.reason ?? "Analysis runtime is unavailable",
				operationId,
				{ runtime: specification.runtime },
			),
			task: null,
			run: null,
		};
	}
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") {
		return {
			result: failureResult(
				"PERMANENT_FAILURE",
				"ANALYSIS_PROJECT_READ_ONLY",
				"migration",
				"Research project schema is read-only",
				operationId,
			),
			task: null,
			run: null,
		};
	}
	const runId = options.analysisRunId ?? createOpaqueId("analysis_run");
	const taskId = options.taskId ?? createOpaqueId("task");
	const runPath = `.research/runs/${runId}`;
	const runDirectory = await resolveProjectPath(opened.root, runPath);
	const inputDirectory = join(runDirectory, "inputs");
	const outputDirectory = join(runDirectory, "outputs");
	const backupDirectory = await mkdtemp(join(tmpdir(), `pi-research-${randomUUID()}-`));
	const inputIntegrity: AnalysisRun["inputIntegrity"] = [];
	let processResult: RuntimeProcessResult = {
		exitCode: null,
		stdout: "",
		stderr: "",
		timedOut: false,
		aborted: false,
	};
	let runtimeError: ResearchError | null = null;
	const startedAt = new Date().toISOString();
	try {
		await mkdir(inputDirectory, { recursive: true });
		await mkdir(outputDirectory, { recursive: true });
		const scriptAbsolute = await resolveProjectPath(opened.root, specification.script.path);
		if (
			specification.script.hash === null ||
			(await hashFile(scriptAbsolute)).value !== specification.script.hash.value
		) {
			throw new TypeError("Analysis script no longer matches its specification");
		}
		const scriptCopy = join(runDirectory, basename(specification.script.path));
		await copyFile(scriptAbsolute, scriptCopy);
		await chmod(scriptCopy, 0o444);
		const inputCopies: string[] = [];
		for (const [index, input] of specification.inputFiles.entries()) {
			if (input.hash === null) throw new TypeError(`Analysis input ${input.path} has no hash`);
			const source = await resolveProjectPath(opened.root, input.path);
			const before = await hashFile(source);
			if (before.value !== input.hash.value)
				throw new TypeError(`Analysis input changed before execution: ${input.path}`);
			const copy = join(inputDirectory, `${index}-${basename(input.path)}`);
			await copyFile(source, copy);
			await chmod(copy, 0o444);
			await copyFile(source, join(backupDirectory, String(index)));
			inputCopies.push(copy);
		}
		const environment = Object.fromEntries(EXPORTED_ENVIRONMENT.map((key) => [key, process.env[key]]));
		for (const [index, input] of inputCopies.entries()) environment[`PI_RESEARCH_INPUT_${index}`] = input;
		environment.PI_RESEARCH_INPUTS = JSON.stringify(inputCopies);
		environment.PI_RESEARCH_OUTPUT_DIR = outputDirectory;
		environment.PI_RESEARCH_PARAMETERS = canonicalStringify(specification.parameters);
		environment.PI_RESEARCH_SEED = specification.randomSeed === null ? "" : String(specification.randomSeed);
		environment.NO_COLOR = "1";
		const args =
			specification.runtime === "stata"
				? ["-b", "do", scriptCopy, ...specification.commandArguments]
				: [scriptCopy, ...specification.commandArguments];
		try {
			processResult = await executor({
				executable: detected.executable,
				args,
				cwd: runDirectory,
				env: environment,
				timeoutMs: specification.timeoutSeconds * 1_000,
				signal: options.signal,
			});
		} catch (error) {
			processResult.stderr = error instanceof Error ? error.message : "Runtime process failed to start";
		}
		for (const [index, input] of specification.inputFiles.entries()) {
			if (input.hash === null) continue;
			const source = await resolveProjectPath(opened.root, input.path);
			const observed = await hashFile(source);
			const mutationDetected = observed.value !== input.hash.value;
			if (mutationDetected) {
				await chmod(source, 0o644);
				await copyFile(join(backupDirectory, String(index)), source);
				await chmod(source, 0o444);
			}
			const after = await hashFile(source);
			inputIntegrity.push({
				path: input.path,
				before: input.hash,
				after,
				unchanged: after.value === input.hash.value,
				mutationDetected,
			});
		}
		if (inputIntegrity.some(({ mutationDetected }) => mutationDetected)) {
			runtimeError = processError(
				"ANALYSIS_RAW_INPUT_MUTATION",
				"integrity",
				"Analysis attempted to modify a raw input; the original was restored",
				operationId,
			);
		}
	} catch (error) {
		runtimeError = processError(
			"ANALYSIS_EXECUTION_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Analysis execution failed",
			operationId,
		);
	} finally {
		await rm(backupDirectory, { recursive: true, force: true });
	}
	for (const input of specification.inputFiles) {
		if (inputIntegrity.some(({ path }) => path === input.path) || input.hash === null) continue;
		try {
			const after = await hashFile(await resolveProjectPath(opened.root, input.path));
			inputIntegrity.push({
				path: input.path,
				before: input.hash,
				after,
				unchanged: after.value === input.hash.value,
				mutationDetected: after.value !== input.hash.value,
			});
		} catch {
			inputIntegrity.push({
				path: input.path,
				before: input.hash,
				after: input.hash,
				unchanged: false,
				mutationDetected: true,
			});
		}
	}
	await mkdir(runDirectory, { recursive: true });
	await writeFile(join(runDirectory, "stdout.log"), processResult.stdout);
	await writeFile(join(runDirectory, "stderr.log"), processResult.stderr);
	let status: AnalysisRun["status"] = "failed";
	if (runtimeError === null) {
		if (processResult.timedOut || processResult.aborted) {
			status = "aborted";
			runtimeError = processError(
				processResult.timedOut ? "ANALYSIS_TIMEOUT" : "ANALYSIS_ABORTED",
				processResult.timedOut ? "runtime" : "cancelled",
				processResult.timedOut ? "Analysis exceeded its configured timeout" : "Analysis was cancelled",
				operationId,
			);
		} else {
			try {
				const reportedStatus = await analysisStatus(outputDirectory);
				if (processResult.exitCode === 75 || reportedStatus === "non_converged") {
					status = "non_converged";
					runtimeError = processError(
						"ANALYSIS_NON_CONVERGED",
						"runtime",
						"Analysis explicitly reported non-convergence",
						operationId,
					);
				} else if (processResult.exitCode !== 0) {
					runtimeError = processError(
						"ANALYSIS_PROCESS_FAILED",
						"runtime",
						`Analysis process exited with code ${processResult.exitCode ?? "unknown"}`,
						operationId,
					);
				} else status = "succeeded";
			} catch (error) {
				runtimeError = processError(
					"ANALYSIS_STATUS_INVALID",
					"validation",
					error instanceof Error ? error.message : "Analysis status is invalid",
					operationId,
				);
			}
		}
	}
	const outputs: FileRef[] = [];
	if (status === "succeeded") {
		try {
			for (const output of specification.expectedOutputs) {
				outputs.push(await fileRef(opened.root, `${runPath}/outputs/${output}`));
			}
		} catch (error) {
			status = "failed";
			runtimeError = processError(
				"ANALYSIS_OUTPUT_MISSING",
				"not_found",
				error instanceof Error ? error.message : "Expected analysis output is missing",
				operationId,
			);
		}
	}
	const logs = await Promise.all([
		fileRef(opened.root, `${runPath}/stdout.log`),
		fileRef(opened.root, `${runPath}/stderr.log`),
	]);
	const finishedAt = new Date().toISOString();
	const inputRecordRefs: RecordRef[] = [
		{
			kind: "analysis_specification",
			id: specification.analysisSpecificationId,
			revision: specification.audit.revision,
		},
		...specification.inputDatasetIds.map((id) => ({ kind: "dataset" as const, id, revision: null })),
	];
	const environmentValues = Object.fromEntries(EXPORTED_ENVIRONMENT.map((key) => [key, process.env[key] ?? null]));
	const environmentHash: HashValue = hashCanonicalJson({
		runtime: detected,
		environment: environmentValues,
		lockFile: specification.environmentFile?.hash ?? null,
	});
	const run: AnalysisRun = {
		kind: "analysis_run",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		analysisRunId: runId,
		analysisSpecificationId: specification.analysisSpecificationId,
		taskId,
		runtime: {
			kind: specification.runtime,
			adapterId: `local-${specification.runtime}`,
			adapterVersion: RESEARCH_SCHEMA_VERSION,
			executable: detected.executable,
			runtimeVersion: detected.runtimeVersion,
			platform: `${process.platform}-${process.arch}`,
		},
		script: specification.script,
		environment: {
			lockFile: specification.environmentFile,
			packageSnapshot: specification.environmentFile,
			containerImage: null,
			environmentHash,
		},
		inputs: [...specification.inputFiles],
		inputRecordRefs,
		parameters: specification.parameters,
		randomSeed: specification.randomSeed,
		commandArguments: [...specification.commandArguments],
		workingDirectory: runPath,
		inputIntegrity,
		outputs,
		logs,
		status,
		exitCode: processResult.exitCode,
		deterministicClaim: specification.randomSeed === null ? "not_claimed" : "seeded",
		startedAt,
		finishedAt,
		failure: runtimeError,
		audit: {
			createdAt: finishedAt,
			updatedAt: finishedAt,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const task: ResearchTask = {
		kind: "task",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		taskId,
		taskType: "analysis_run",
		title: specification.title,
		inputs: inputRecordRefs,
		inputFiles: [...specification.inputFiles, specification.script],
		expectedOutputs: [...specification.expectedOutputs],
		outputs: [{ kind: "analysis_run", id: runId, revision: 0 }],
		outputFiles: [...outputs, ...logs],
		dependencyTaskIds: [],
		status: status === "succeeded" ? "succeeded" : "failed_permanent",
		attemptCount: 1,
		maxAttempts: 1,
		idempotencyKey: hashCanonicalJson({
			specificationId: specification.analysisSpecificationId,
			specificationRevision: specification.audit.revision,
			inputs: specification.inputFiles.map(({ hash }) => hash),
			randomSeed: specification.randomSeed,
		}).value,
		operationIds: [operationId],
		errors: runtimeError === null ? [] : [runtimeError],
		resumeCursor: null,
		budget: { estimated: null, actual: { amount: 0, currency: "USD" } },
		createdAt: startedAt,
		startedAt,
		finishedAt,
		updatedAt: finishedAt,
		revision: 0,
	};
	const current = await openProject(opened.root);
	if (current.compatibility !== "current") {
		return {
			result: failureResult(
				"PERMANENT_FAILURE",
				"ANALYSIS_PROJECT_READ_ONLY",
				"migration",
				"Research project schema is read-only",
				operationId,
			),
			task: null,
			run: null,
		};
	}
	const committed = await createRecords(current.root, [task, run], {
		expectedManifestRevision: current.manifest.revision,
		operationId,
	});
	if (!committed.ok) return { result: committed, task: null, run: null };
	if (runtimeError !== null) {
		return {
			result: failedOutcome("PERMANENT_FAILURE", runtimeError, operationId, taskId, runId),
			task,
			run,
		};
	}
	return { result: successResult({ task, run }, operationId), task, run };
}
