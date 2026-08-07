// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	detectAnalysisRuntime,
	executeAnalysis,
	type RuntimeExecutor,
	type RuntimeProcessResult,
} from "../../src/analysis/runtime.ts";
import type { AnalysisSpecification, FileRef, RecordRef, ResearchResult } from "../../src/contracts/schemas.ts";
import { hashFile } from "../../src/kernel/integrity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { projectRecordId, projectRecordRevision } from "../../src/project/record-index.ts";
import { readRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";
import {
	createAnalysisSpecification,
	decideAnalysisSpecification,
	importCsvDataset,
} from "../../src/tools/analysis.ts";
import { finishOperation, startOperation } from "../../src/tools/operations.ts";

let temporaryDirectory: string;
let projectRoot: string;
let executable: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-analysis-"));
	projectRoot = join(temporaryDirectory, "project");
	executable = join(temporaryDirectory, "mock-runtime");
	await writeFile(executable, "mock runtime");
	await chmod(executable, 0o755);
	await initializeProject(projectRoot, { title: "Synthetic public-management analysis" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function begin(name: string): Promise<string> {
	const started = await startOperation(projectRoot, {
		operationKind: "tool",
		name,
		implementationVersion: "0.3.0",
		session: null,
	});
	if (!started.ok) throw new Error(started.errors[0].message);
	return started.value.operationId;
}

async function finish(
	operationId: string,
	result: ResearchResult<unknown>,
	outputs: RecordRef[] = [],
	outputFiles: FileRef[] = [],
): Promise<void> {
	const finished = await finishOperation(projectRoot, operationId, result, outputs, outputFiles);
	if (!finished.ok) throw new Error(finished.errors[0].message);
}

async function currentRevision(): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	return opened.manifest.revision;
}

async function prepareSpecification(
	runtime: "python" | "r" | "stata" = "python",
	expectedOutputs: string[] = [],
	scriptSource = "# Synthetic runtime fixture\n",
	commandArguments: string[] = [],
): Promise<AnalysisSpecification> {
	const csvPath = join(temporaryDirectory, "trust.csv");
	await writeFile(csvPath, "id,transparency,trust\n1,1,4\n2,0,2\n3,1,5\n");
	const importOperationId = await begin("research.analysis.import_dataset");
	const imported = await importCsvDataset(projectRoot, {
		path: csvPath,
		title: "Synthetic transparency and trust data",
		sensitivity: "public",
		expectedManifestRevision: await currentRevision(),
		operationId: importOperationId,
		sessionId: null,
	});
	if (!imported.ok) throw new Error(imported.errors[0].message);
	await finish(
		importOperationId,
		imported,
		[imported.value.dataset, ...imported.value.variables].map((record) => ({
			kind: record.kind,
			id: projectRecordId(record),
			revision: projectRecordRevision(record),
		})),
		[imported.value.dataset.sourceFile],
	);

	const scriptPath = join(
		temporaryDirectory,
		runtime === "python" ? "analysis.py" : runtime === "r" ? "analysis.R" : "analysis.do",
	);
	const environmentPath = join(temporaryDirectory, runtime === "r" ? "renv.lock" : "requirements.txt");
	await writeFile(scriptPath, scriptSource);
	await writeFile(environmentPath, runtime === "r" ? '{"R":{"Version":"4.5.0"}}\n' : "# standard library only\n");
	const specificationOperationId = await begin("research.analysis.create_specification");
	const created = await createAnalysisSpecification(projectRoot, {
		title: `${runtime} transparency association analysis`,
		protocolId: null,
		datasetIds: [imported.value.dataset.datasetId],
		runtime,
		scriptPath,
		environmentPath,
		parameters: { outcome: "trust", exposure: "transparency" },
		randomSeed: 17,
		commandArguments,
		expectedOutputs,
		timeoutSeconds: 10,
		claimMode: "associational",
		expectedManifestRevision: await currentRevision(),
		operationId: specificationOperationId,
		sessionId: null,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	await finish(specificationOperationId, created, [
		{
			kind: "analysis_specification",
			id: created.value.specification.analysisSpecificationId,
			revision: 0,
		},
	]);

	const decisionOperationId = await begin("research.analysis.decide_specification");
	const decided = await decideAnalysisSpecification(
		projectRoot,
		created.value.specification.analysisSpecificationId,
		await currentRevision(),
		0,
		"confirmed",
		"Confirmed for a synthetic reproducibility fixture",
		decisionOperationId,
	);
	if (!decided.ok) throw new Error(decided.errors[0].message);
	await finish(decisionOperationId, decided, [decided.value]);
	const stored = await readRecord(
		projectRoot,
		"analysis_specification",
		created.value.specification.analysisSpecificationId,
	);
	if (!stored.ok || stored.value.kind !== "analysis_specification") throw new Error("Confirmed specification missing");
	return stored.value;
}

function processResult(overrides: Partial<RuntimeProcessResult> = {}): RuntimeProcessResult {
	return { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...overrides };
}

function successfulExecutor(): RuntimeExecutor {
	return async (request) => {
		if (request.args[0] === "--version") return processResult({ stdout: "Mock Runtime 1.0\n" });
		const outputDirectory = request.env.PI_RESEARCH_OUTPUT_DIR;
		if (outputDirectory === undefined) throw new Error("Missing output directory contract");
		await writeFile(
			join(outputDirectory, "result.json"),
			`${JSON.stringify({ parameters: request.env.PI_RESEARCH_PARAMETERS, seed: request.env.PI_RESEARCH_SEED })}\n`,
		);
		await writeFile(join(outputDirectory, "analysis-status.json"), '{"status":"succeeded"}\n');
		return processResult({ stdout: "analysis complete\n" });
	};
}

async function execute(
	specification: AnalysisSpecification,
	executor: RuntimeExecutor,
): Promise<Awaited<ReturnType<typeof executeAnalysis>>> {
	const operationId = await begin("research.analysis.run");
	const outcome = await executeAnalysis(projectRoot, specification, operationId, { executable, executor });
	await finish(
		operationId,
		outcome.result,
		outcome.task === null || outcome.run === null
			? []
			: [
					{ kind: "task", id: outcome.task.taskId, revision: 0 },
					{ kind: "analysis_run", id: outcome.run.analysisRunId, revision: 0 },
				],
		outcome.run === null ? [] : [...outcome.run.outputs, ...outcome.run.logs],
	);
	return outcome;
}

describe("reproducible analysis workbench", () => {
	it.skipIf(process.platform === "win32")(
		"does not execute an explicitly supplied runtime during detection",
		async () => {
			const sentinel = join(temporaryDirectory, "runtime-detection-sentinel");
			const explicitRuntime = join(temporaryDirectory, "untrusted-runtime");
			await writeFile(
				explicitRuntime,
				`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed");\n`,
			);
			await chmod(explicitRuntime, 0o755);

			await expect(detectAnalysisRuntime("python", explicitRuntime)).resolves.toMatchObject({
				available: true,
				executable: explicitRuntime,
				runtimeVersion: "installed (version not queried)",
			});
			await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("imports a data dictionary and produces identical seeded output hashes", async () => {
		const specification = await prepareSpecification("python", ["result.json"]);
		const first = await execute(specification, successfulExecutor());
		const second = await execute(specification, successfulExecutor());
		expect(first.result.ok).toBe(true);
		expect(second.result.ok).toBe(true);
		expect(first.run?.status).toBe("succeeded");
		expect(first.run?.deterministicClaim).toBe("seeded");
		expect(first.run?.outputs[0]?.hash?.value).toBe(second.run?.outputs[0]?.hash?.value);
		expect(first.run?.inputIntegrity).toEqual([
			expect.objectContaining({ unchanged: true, mutationDetected: false }),
		]);
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	});

	it.each([
		["missing package", processResult({ exitCode: 1, stderr: "ModuleNotFoundError: statsmodels\n" }), "failed"],
		["missing variable", processResult({ exitCode: 1, stderr: "KeyError: trust_score\n" }), "failed"],
		["runtime crash", processResult({ exitCode: 2, stderr: "fatal runtime error\n" }), "failed"],
		["timeout", processResult({ exitCode: null, timedOut: true }), "aborted"],
		["non-convergence", processResult({ exitCode: 75, stderr: "optimizer did not converge\n" }), "non_converged"],
	] as const)("persists %s as an explicit terminal failure", async (_label, failure, expectedStatus) => {
		const specification = await prepareSpecification();
		const outcome = await execute(specification, async (request) =>
			request.args[0] === "--version" ? processResult({ stdout: "Mock Runtime 1.0\n" }) : failure,
		);
		expect(outcome.result.ok).toBe(false);
		expect(outcome.run?.status).toBe(expectedStatus);
		expect(outcome.run?.failure).not.toBeNull();
		if (failure.stderr.length > 0 && outcome.run !== null) {
			expect(await readFile(join(projectRoot, ...outcome.run.logs[1].path.split("/")), "utf8")).toContain(
				failure.stderr.trim(),
			);
		}
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	});

	it("detects and restores an attempted raw-data mutation", async () => {
		const specification = await prepareSpecification();
		const rawPath = join(projectRoot, ...specification.inputFiles[0].path.split("/"));
		const before = await hashFile(rawPath);
		const outcome = await execute(specification, async (request) => {
			if (request.args[0] === "--version") return processResult({ stdout: "Mock Runtime 1.0\n" });
			await chmod(rawPath, 0o644);
			await writeFile(rawPath, "mutated\n");
			return processResult();
		});
		expect(outcome.result.ok).toBe(false);
		expect(outcome.run).toMatchObject({
			status: "failed",
			failure: { code: "ANALYSIS_RAW_INPUT_MUTATION" },
			inputIntegrity: [{ unchanged: true, mutationDetected: true }],
		});
		expect((await hashFile(rawPath)).value).toBe(before.value);
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	});

	it("exercises the Stata batch contract through a test executor without claiming runtime qualification", async () => {
		const specification = await prepareSpecification("stata");
		let observedArguments: string[] = [];
		const outcome = await execute(specification, async (request) => {
			observedArguments = request.args;
			return processResult();
		});
		expect(outcome.result.ok).toBe(true);
		expect(observedArguments.slice(0, 2)).toEqual(["-b", "do"]);
		expect(outcome.run?.runtime).toMatchObject({ kind: "stata", runtimeVersion: "installed (version not queried)" });
	});

	it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
		"denies home, SSH, network, parent, and symlink access under strong isolation",
		async () => {
			const detected = await detectAnalysisRuntime("python");
			if (!detected.available || detected.executable === null)
				throw new Error("Python is required for isolation test");
			const privateHome = join(temporaryDirectory, "private-home");
			const sshDirectory = join(privateHome, ".ssh");
			const parentSecret = join(temporaryDirectory, "parent-secret.txt");
			await mkdir(sshDirectory, { recursive: true });
			await writeFile(join(privateHome, "home-secret.txt"), "home-secret");
			await writeFile(join(sshDirectory, "id_ed25519"), "ssh-secret");
			await writeFile(parentSecret, "parent-secret");
			let acceptedConnections = 0;
			const server = createServer(() => {
				acceptedConnections += 1;
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("Isolation test server did not bind");
			const previousSecret = process.env.PI_RESEARCH_TEST_SECRET;
			process.env.PI_RESEARCH_TEST_SECRET = "must-not-leak";
			try {
				const scriptSource = `import json, os, sys, urllib.request
home, ssh_key, parent, url = sys.argv[1:5]
def readable(path):
    try:
        with open(path, "r", encoding="utf-8") as handle: handle.read()
        return True
    except Exception:
        return False
output = os.environ["PI_RESEARCH_OUTPUT_DIR"]
link = os.path.join(output, "escape-link")
try: os.symlink(parent, link)
except Exception: pass
network = False
try:
    urllib.request.urlopen(url, timeout=0.5).read()
    network = True
except Exception:
    pass
result = {
    "home": readable(home),
    "ssh": readable(ssh_key),
    "parent": readable(parent),
    "symlink": readable(link),
    "network": network,
    "secretEnvironment": "PI_RESEARCH_TEST_SECRET" in os.environ,
}
with open(os.path.join(output, "isolation.json"), "w", encoding="utf-8") as handle: json.dump(result, handle)
with open(os.path.join(output, "analysis-status.json"), "w", encoding="utf-8") as handle: json.dump({"status": "succeeded"}, handle)
`;
				const specification = await prepareSpecification("python", ["isolation.json"], scriptSource, [
					join(privateHome, "home-secret.txt"),
					join(sshDirectory, "id_ed25519"),
					parentSecret,
					`http://127.0.0.1:${address.port}`,
				]);
				const operationId = await begin("research.analysis.isolation");
				const outcome = await executeAnalysis(projectRoot, specification, operationId, {
					executable: detected.executable,
				});
				await finish(
					operationId,
					outcome.result,
					outcome.task === null || outcome.run === null
						? []
						: [
								{ kind: "task", id: outcome.task.taskId, revision: 0 },
								{ kind: "analysis_run", id: outcome.run.analysisRunId, revision: 0 },
							],
					outcome.run === null ? [] : [...outcome.run.outputs, ...outcome.run.logs],
				);
				if (!outcome.result.ok) {
					const stderr =
						outcome.run === null
							? ""
							: await readFile(join(projectRoot, ...outcome.run.logs[1].path.split("/")), "utf8");
					throw new Error(`${JSON.stringify(outcome.result.errors)}\n${stderr}`);
				}
				if (outcome.run === null) throw new Error("Isolation run was not persisted");
				const observed = JSON.parse(
					await readFile(join(projectRoot, ...outcome.run.outputs[0]!.path.split("/")), "utf8"),
				) as Record<string, boolean>;
				expect(observed).toEqual({
					home: false,
					network: false,
					parent: false,
					secretEnvironment: false,
					ssh: false,
					symlink: false,
				});
				expect(acceptedConnections).toBe(0);
				expect(outcome.run.runtime.adapterId).toBe("local-python-strong_isolation");
			} finally {
				if (previousSecret === undefined) delete process.env.PI_RESEARCH_TEST_SECRET;
				else process.env.PI_RESEARCH_TEST_SECRET = previousSecret;
				server.close();
			}
		},
	);
});
