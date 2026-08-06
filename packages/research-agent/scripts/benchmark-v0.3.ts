// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { FileRef, RecordRef, ResearchResult } from "../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { initializeProject } from "../src/project/init.ts";
import { openProject } from "../src/project/open.ts";
import { projectRecordId, projectRecordRevision } from "../src/project/record-index.ts";
import { validateProject } from "../src/project/validate.ts";
import { importCsvDataset } from "../src/tools/analysis.ts";
import { finishOperation, startOperation } from "../src/tools/operations.ts";
import { importQualitativeMaterial, segmentQualitativeMaterial } from "../src/tools/qualitative.ts";

const samples = 5;

function percentile95(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	if (value === undefined) throw new Error("Benchmark produced no samples");
	return Number(value.toFixed(3));
}

async function revision(projectRoot: string): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Benchmark project is not writable");
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
	const finished = await finishOperation(projectRoot, operationId, result, outputs, files);
	if (!finished.ok) throw new Error(finished.errors[0].message);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-v0.3-benchmark-"));
try {
	const csvPath = join(temporaryDirectory, "thousand-rows.csv");
	const rows = ["case_id,explanation_visible,trust_score,wait_minutes,office,month,channel,resolved"];
	for (let index = 1; index <= 1_000; index += 1) {
		rows.push(
			`${index},${index % 2},${(index % 5) + 1},${(index % 20) + 1},office-${index % 10},${(index % 12) + 1},${index % 3},${index % 2 === 0}`,
		);
	}
	await writeFile(csvPath, `${rows.join("\n")}\n`);

	const materialPath = join(temporaryDirectory, "thousand-segments.txt");
	await writeFile(
		materialPath,
		`${Array.from(
			{ length: 1_000 },
			(_, index) => `Synthetic segment ${index + 1}: explanation visibility and trust response ${index % 7}.`,
		).join("\n\n")}\n`,
	);

	const importSamples: number[] = [];
	const segmentSamples: number[] = [];
	for (let sample = 0; sample < samples; sample += 1) {
		const projectRoot = join(temporaryDirectory, `dataset-${sample}`);
		await initializeProject(projectRoot, { title: `Dataset benchmark ${sample}` });
		const operationId = await begin(projectRoot, "research.analysis.import_dataset");
		const started = performance.now();
		const result = await importCsvDataset(projectRoot, {
			path: csvPath,
			title: "Synthetic 1,000-row benchmark",
			sensitivity: "public",
			expectedManifestRevision: await revision(projectRoot),
			operationId,
			sessionId: null,
		});
		importSamples.push(performance.now() - started);
		if (!result.ok) throw new Error(result.errors[0].message);
		if (result.value.dataset.rowCount !== 1_000 || result.value.variables.length !== 8) {
			throw new Error("Dataset benchmark dictionary is incomplete");
		}
		await finish(
			projectRoot,
			operationId,
			result,
			[result.value.dataset, ...result.value.variables].map((record) => ({
				kind: record.kind,
				id: projectRecordId(record),
				revision: projectRecordRevision(record),
			})),
			[result.value.dataset.sourceFile],
		);
		if (!(await validateProject(projectRoot)).valid) throw new Error("Dataset benchmark project is invalid");
	}

	for (let sample = 0; sample < samples; sample += 1) {
		const projectRoot = join(temporaryDirectory, `qualitative-${sample}`);
		await initializeProject(projectRoot, { title: `Qualitative benchmark ${sample}` });
		const importOperationId = await begin(projectRoot, "research.qualitative.import_material");
		const imported = await importQualitativeMaterial(projectRoot, {
			path: materialPath,
			title: "Synthetic 1,000-segment benchmark",
			sensitivity: "public",
			deidentified: true,
			expectedManifestRevision: await revision(projectRoot),
			operationId: importOperationId,
			sessionId: null,
		});
		if (!imported.ok) throw new Error(imported.errors[0].message);
		await finish(
			projectRoot,
			importOperationId,
			imported,
			[{ kind: imported.value.kind, id: imported.value.qualitativeMaterialId, revision: 0 }],
			[imported.value.sourceFile],
		);
		const segmentOperationId = await begin(projectRoot, "research.qualitative.segment_material");
		const started = performance.now();
		const segmented = await segmentQualitativeMaterial(
			projectRoot,
			imported.value.qualitativeMaterialId,
			await revision(projectRoot),
			segmentOperationId,
		);
		segmentSamples.push(performance.now() - started);
		if (!segmented.ok) throw new Error(segmented.errors[0].message);
		if (segmented.value.length !== 1_000) throw new Error("Qualitative benchmark lost segments");
		await finish(
			projectRoot,
			segmentOperationId,
			segmented,
			segmented.value.map((record) => ({ kind: record.kind, id: record.qualitativeSegmentId, revision: 0 })),
		);
		if (!(await validateProject(projectRoot)).valid) throw new Error("Qualitative benchmark project is invalid");
	}

	const dataImportP95Ms = percentile95(importSamples);
	const segmentIndexP95Ms = percentile95(segmentSamples);
	const thresholdMs = 5_000;
	const report = {
		benchmark: "pi-research-agent-v0.3",
		generatedAt: new Date().toISOString(),
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		fixture: { rows: 1_000, variables: 8, segments: 1_000 },
		results: {
			dataImportAndDictionary: {
				samples: importSamples.length,
				measurementsMs: importSamples.map((value) => Number(value.toFixed(3))),
				p95Ms: dataImportP95Ms,
				thresholdMs,
				passed: dataImportP95Ms < thresholdMs,
			},
			qualitativeSegmentIndex: {
				samples: segmentSamples.length,
				measurementsMs: segmentSamples.map((value) => Number(value.toFixed(3))),
				p95Ms: segmentIndexP95Ms,
				thresholdMs,
				passed: segmentIndexP95Ms < thresholdMs,
			},
		},
		usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	};
	const passed = Object.values(report.results).every(({ passed: result }) => result);
	const output = `${JSON.stringify({ ...report, status: passed ? "passed" : "failed" }, null, 2)}\n`;
	const outputIndex = process.argv.indexOf("--output");
	if (outputIndex >= 0) {
		const outputPath = process.argv[outputIndex + 1];
		if (outputPath === undefined) throw new TypeError("--output requires a path");
		await writeFile(resolve(process.cwd(), outputPath), output);
	}
	process.stdout.write(output);
	if (!passed) process.exitCode = 1;
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
