// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { SourceRecord } from "../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { packProjectExchange, unpackProjectExchange } from "../src/exchange/bundle.ts";
import { initializeProject } from "../src/project/init.ts";
import { openProject } from "../src/project/open.ts";
import { createRecords } from "../src/project/records.ts";
import { validateProject } from "../src/project/validate.ts";
import { startOperation } from "../src/tools/operations.ts";

function p95(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	if (value === undefined) throw new Error("Benchmark produced no measurements");
	return Number(value.toFixed(3));
}

function sourceId(index: number): string {
	return `src_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-v1.5-benchmark-"));
try {
	const projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "10k record exchange benchmark" });
	const operation = await startOperation(projectRoot, {
		operationKind: "tool",
		name: "benchmark.v1.5.fixture",
		implementationVersion: "1.5.0",
		session: null,
	});
	if (!operation.ok) throw new Error(operation.errors[0].message);
	const timestamp = "2026-08-07T00:00:00.000Z";
	const recordCount = 10_000;
	const records: SourceRecord[] = Array.from({ length: recordCount }, (_, index) => {
		const id = sourceId(index);
		const title = `Portable source ${index}`;
		return {
			kind: "source",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			sourceId: id,
			identifiers: [],
			title,
			titleNormalized: title.toLowerCase(),
			contributors: [],
			issuedDate: "2026",
			containerTitle: null,
			publisher: null,
			sourceType: "benchmark-fixture",
			language: "en",
			abstractText: null,
			abstractRights: "metadata_only",
			discovery: [],
			dedupKeys: {
				doi: null,
				strongIdentifier: id,
				normalizedTitleYearFirstAuthor: `${title.toLowerCase()}|2026|`,
				contentHash: null,
			},
			duplicateStatus: "canonical",
			canonicalSourceId: null,
			metadataConflicts: [],
			publicationStatus: "normal",
			audit: {
				createdAt: timestamp,
				updatedAt: timestamp,
				revision: 0,
				createdByOperationId: operation.value.operationId,
				updatedByOperationId: operation.value.operationId,
			},
		};
	});
	const beforeCreate = await openProject(projectRoot);
	if (beforeCreate.compatibility !== "current") throw new Error("Benchmark project is not writable");
	const created = await createRecords(projectRoot, records, {
		expectedManifestRevision: beforeCreate.manifest.revision,
		operationId: operation.value.operationId,
	});
	if (!created.ok || created.value.length !== recordCount) throw new Error("Benchmark records were not created");
	const createdProject = await openProject(projectRoot);
	if (createdProject.compatibility !== "current") throw new Error("Benchmark project became read-only");
	const sourceSet = createdProject.manifest.recordSets.find(({ kind }) => kind === "source");
	if (sourceSet?.count !== recordCount || sourceSet.contentHash === null) {
		throw new Error("Benchmark source index is incomplete");
	}

	const packMeasurementsMs: number[] = [];
	const unpackMeasurementsMs: number[] = [];
	for (let sample = 0; sample < 3; sample += 1) {
		const bundle = join(temporaryDirectory, `bundle-${sample}`);
		let started = performance.now();
		const packed = await packProjectExchange(projectRoot, bundle);
		packMeasurementsMs.push(performance.now() - started);
		const imported = join(temporaryDirectory, `imported-${sample}`);
		started = performance.now();
		const unpacked = await unpackProjectExchange(bundle, imported);
		const validation = await validateProject(imported);
		unpackMeasurementsMs.push(performance.now() - started);
		const importedProject = await openProject(imported);
		if (importedProject.compatibility !== "current") throw new Error("Imported project is read-only");
		const importedSourceSet = importedProject.manifest.recordSets.find(({ kind }) => kind === "source");
		if (
			!validation.valid ||
			packed.rootHash.value !== unpacked.rootHash.value ||
			importedSourceSet?.count !== recordCount ||
			importedSourceSet.contentHash?.value !== sourceSet.contentHash.value
		) {
			throw new Error("Exchange round trip changed project semantics");
		}
	}

	const thresholdMs = 60_000;
	const exportP95Ms = p95(packMeasurementsMs);
	const importP95Ms = p95(unpackMeasurementsMs);
	const passed = exportP95Ms < thresholdMs && importP95Ms < thresholdMs;
	const report = {
		benchmark: "pi-research-agent-v1.5",
		generatedAt: new Date().toISOString(),
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		fixture: { records: recordCount, samples: packMeasurementsMs.length },
		results: {
			exchangeExport: {
				measurementsMs: packMeasurementsMs.map((value) => Number(value.toFixed(3))),
				p95Ms: exportP95Ms,
				thresholdMs,
				passed: exportP95Ms < thresholdMs,
			},
			exchangeImportAndValidate: {
				measurementsMs: unpackMeasurementsMs.map((value) => Number(value.toFixed(3))),
				p95Ms: importP95Ms,
				thresholdMs,
				passed: importP95Ms < thresholdMs,
			},
		},
		usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
		status: passed ? "passed" : "failed",
	};
	const output = `${JSON.stringify(report, null, 2)}\n`;
	const outputIndex = process.argv.indexOf("--output");
	if (outputIndex >= 0) {
		const outputPath = process.argv[outputIndex + 1];
		if (outputPath === undefined) throw new TypeError("--output requires a path");
		const absolutePath = resolve(process.cwd(), outputPath);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, output);
	}
	process.stdout.write(output);
	if (!passed) process.exitCode = 1;
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
