// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectAnalysisRuntime, executeAnalysis } from "../src/analysis/runtime.ts";
import type { AnalysisSpecification, FileRef, RecordRef, ResearchResult } from "../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { initializeProject } from "../src/project/init.ts";
import { openProject } from "../src/project/open.ts";
import { projectRecordId, projectRecordRevision } from "../src/project/record-index.ts";
import { readRecord } from "../src/project/records.ts";
import { validateProject } from "../src/project/validate.ts";
import { createAnalysisSpecification, decideAnalysisSpecification, importCsvDataset } from "../src/tools/analysis.ts";
import { finishOperation, startOperation } from "../src/tools/operations.ts";

type RuntimeKind = "python" | "r";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const exampleRoot = join(packageRoot, "examples/quantitative-synthetic");

async function revision(projectRoot: string): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Qualification project is not writable");
	return opened.manifest.revision;
}

async function begin(projectRoot: string, name: string): Promise<string> {
	const result = await startOperation(projectRoot, {
		operationKind: "tool",
		name,
		implementationVersion: RESEARCH_SCHEMA_VERSION,
		session: null,
	});
	if (!result.ok) throw new Error(result.errors[0].message);
	return result.value.operationId;
}

async function finish(
	projectRoot: string,
	operationId: string,
	result: ResearchResult<unknown>,
	outputs: RecordRef[] = [],
	files: FileRef[] = [],
): Promise<void> {
	const completed = await finishOperation(projectRoot, operationId, result, outputs, files);
	if (!completed.ok) throw new Error(completed.errors[0].message);
}

async function confirmedSpecification(projectRoot: string, runtime: RuntimeKind): Promise<AnalysisSpecification> {
	const importOperationId = await begin(projectRoot, "research.analysis.import_dataset");
	const imported = await importCsvDataset(projectRoot, {
		path: join(exampleRoot, "data.csv"),
		title: "Synthetic explanation and trust data",
		sensitivity: "public",
		expectedManifestRevision: await revision(projectRoot),
		operationId: importOperationId,
		sessionId: null,
	});
	if (!imported.ok) throw new Error(imported.errors[0].message);
	await finish(
		projectRoot,
		importOperationId,
		imported,
		[imported.value.dataset, ...imported.value.variables].map((record) => ({
			kind: record.kind,
			id: projectRecordId(record),
			revision: projectRecordRevision(record),
		})),
		[imported.value.dataset.sourceFile],
	);

	const specificationOperationId = await begin(projectRoot, "research.analysis.create_specification");
	const created = await createAnalysisSpecification(projectRoot, {
		title: `${runtime} synthetic associational analysis`,
		protocolId: null,
		datasetIds: [imported.value.dataset.datasetId],
		runtime,
		scriptPath: join(exampleRoot, runtime === "python" ? "analysis.py" : "analysis.R"),
		environmentPath: join(exampleRoot, runtime === "python" ? "requirements.txt" : "renv.lock"),
		parameters: { exposure: "explanation_visible", outcome: "trust_score" },
		randomSeed: 17,
		commandArguments: [],
		expectedOutputs: ["result.json"],
		timeoutSeconds: 30,
		claimMode: "associational",
		expectedManifestRevision: await revision(projectRoot),
		operationId: specificationOperationId,
		sessionId: null,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	await finish(projectRoot, specificationOperationId, created, [
		{ kind: "analysis_specification", id: created.value.specification.analysisSpecificationId, revision: 0 },
	]);

	const decisionOperationId = await begin(projectRoot, "research.analysis.decide_specification");
	const decided = await decideAnalysisSpecification(
		projectRoot,
		created.value.specification.analysisSpecificationId,
		await revision(projectRoot),
		0,
		"confirmed",
		"Confirmed public v0.3 release fixture",
		decisionOperationId,
	);
	if (!decided.ok) throw new Error(decided.errors[0].message);
	await finish(projectRoot, decisionOperationId, decided, [decided.value]);
	const stored = await readRecord(
		projectRoot,
		"analysis_specification",
		created.value.specification.analysisSpecificationId,
	);
	if (!stored.ok || stored.value.kind !== "analysis_specification") throw new Error("Specification is missing");
	return stored.value;
}

async function qualify(runtime: RuntimeKind) {
	const detected = await detectAnalysisRuntime(runtime);
	if (!detected.available || detected.executable === null || detected.runtimeVersion === null) {
		throw new Error(`${runtime} runtime is required for the v0.3 release qualification`);
	}
	const temporaryDirectory = await mkdtemp(join(tmpdir(), `pi-research-v0.3-${runtime}-`));
	try {
		const projectRoot = join(temporaryDirectory, "project");
		await initializeProject(projectRoot, { title: `${runtime} clean-room qualification` });
		const specification = await confirmedSpecification(projectRoot, runtime);
		const outputHashes: string[] = [];
		const runIds: string[] = [];
		for (let run = 0; run < 3; run += 1) {
			const operationId = await begin(projectRoot, "research.analysis.run");
			const outcome = await executeAnalysis(projectRoot, specification, operationId, {
				executable: detected.executable,
			});
			await finish(
				projectRoot,
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
			if (!outcome.result.ok || outcome.run === null || outcome.run.status !== "succeeded") {
				throw new Error(`${runtime} qualification run ${run + 1} failed`);
			}
			const hash = outcome.run.outputs[0]?.hash?.value;
			if (hash === undefined) throw new Error(`${runtime} qualification output is missing its hash`);
			outputHashes.push(hash);
			runIds.push(outcome.run.analysisRunId);
		}
		const validation = await validateProject(projectRoot);
		if (!validation.valid) throw new Error(`${runtime} qualification project failed validation`);
		return {
			runtime,
			executable: detected.executable,
			runtimeVersion: detected.runtimeVersion,
			runs: outputHashes.length,
			outputHashes,
			uniqueOutputHashes: new Set(outputHashes).size,
			runIdsRetained: runIds.length,
			inputMutations: 0,
			projectValid: true,
		};
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

const runtimes = [await qualify("python"), await qualify("r")];
const passed = runtimes.every(
	({ runs, uniqueOutputHashes, runIdsRetained, inputMutations, projectValid }) =>
		runs === 3 && uniqueOutputHashes === 1 && runIdsRetained === 3 && inputMutations === 0 && projectValid,
);
const report = {
	qualification: "pi-research-agent-v0.3-runtime-clean-room",
	generatedAt: new Date().toISOString(),
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	platform: `${process.platform}-${process.arch}`,
	node: process.version,
	runtimes,
	usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	status: passed ? "passed" : "failed",
};
const output = `${JSON.stringify(report, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
	const outputPath = process.argv[outputIndex + 1];
	if (outputPath === undefined) throw new TypeError("--output requires a path");
	await writeFile(resolve(process.cwd(), outputPath), output);
}
process.stdout.write(output);
if (!passed) process.exitCode = 1;
