// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { CrossProjectSourceRef, ProjectCatalog } from "../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { hashCanonicalJson } from "../src/kernel/integrity.ts";
import { parseProjectCatalog, queryProjectCatalog, serializeProjectCatalog } from "../src/knowledge/catalog.ts";

function p95(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	if (value === undefined) throw new Error("Benchmark produced no measurements");
	return Number(value.toFixed(3));
}

const sourceCount = 10_000;
const targetIdentifier = "doi:10.5555/catalog.9999";
const sources: CrossProjectSourceRef[] = Array.from({ length: sourceCount }, (_, index) => ({
	strongIdentifier: `doi:10.5555/catalog.${String(index).padStart(4, "0")}`,
	projectId: `project-${index % 10}`,
	projectLocator: `projects/${index % 10}`,
	sourceId: `source-${index}`,
	title: `Synthetic source ${index}`,
	publicationYear: 2025,
}));
const catalog: ProjectCatalog = {
	format: "pi-research-project-catalog",
	version: 1,
	generatedAt: new Date().toISOString(),
	projectCount: 10,
	sourceCount,
	sources,
	duplicates: [],
	catalogHash: hashCanonicalJson({ sources, duplicates: [] }),
};
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-v0.5-benchmark-"));
try {
	const catalogPath = join(temporaryDirectory, "project-catalog.json");
	await writeFile(catalogPath, serializeProjectCatalog(catalog));
	const measurementsMs: number[] = [];
	for (let sample = 0; sample < 20; sample += 1) {
		const started = performance.now();
		const loaded = parseProjectCatalog(await readFile(catalogPath, "utf8"));
		const matches = queryProjectCatalog(loaded, targetIdentifier);
		measurementsMs.push(performance.now() - started);
		if (matches.length !== 1 || matches[0]?.strongIdentifier !== targetIdentifier) {
			throw new Error("Catalog query missed its target");
		}
	}
	const thresholdMs = 2_000;
	const queryP95Ms = p95(measurementsMs);
	const report = {
		benchmark: "pi-research-agent-v0.5",
		generatedAt: new Date().toISOString(),
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		fixture: { projects: 10, sources: sourceCount, matches: 1 },
		results: {
			catalogLoadAndQuery: {
				samples: measurementsMs.length,
				measurementsMs: measurementsMs.map((value) => Number(value.toFixed(3))),
				p95Ms: queryP95Ms,
				thresholdMs,
				passed: queryP95Ms < thresholdMs,
			},
		},
		usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	};
	const output = `${JSON.stringify({ ...report, status: report.results.catalogLoadAndQuery.passed ? "passed" : "failed" }, null, 2)}\n`;
	const outputIndex = process.argv.indexOf("--output");
	if (outputIndex >= 0) {
		const outputPath = process.argv[outputIndex + 1];
		if (outputPath === undefined) throw new TypeError("--output requires a path");
		const absolutePath = resolve(process.cwd(), outputPath);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, output);
	}
	process.stdout.write(output);
	if (!report.results.catalogLoadAndQuery.passed) process.exitCode = 1;
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
