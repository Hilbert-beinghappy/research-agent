// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { initializeProject } from "../src/project/init.ts";
import { openProject } from "../src/project/open.ts";
import { startOperation } from "../src/tools/operations.ts";
import {
	countManuscriptWords,
	createDisclosure,
	createManuscriptRevision,
	evaluateSubmissionGate,
} from "../src/tools/writing.ts";

function p95(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	if (value === undefined) throw new Error("Benchmark produced no measurements");
	return Number(value.toFixed(3));
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-v0.4-benchmark-"));
try {
	const projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "50k-word manuscript benchmark" });
	let opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Benchmark project is not writable");
	const operation = await startOperation(projectRoot, {
		operationKind: "tool",
		name: "research.manuscript.benchmark",
		implementationVersion: RESEARCH_SCHEMA_VERSION,
		session: null,
	});
	if (!operation.ok) throw new Error(operation.errors[0].message);
	opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Benchmark project became read-only");
	const content = Array.from({ length: 50_000 }, (_, index) => `word${index % 100}`).join(" ");
	if (countManuscriptWords(content) !== 50_000) throw new Error("50k-word fixture count changed");
	const manuscript = await createManuscriptRevision(projectRoot, {
		title: "Synthetic 50k-word integrity fixture",
		paperType: "conceptual",
		abstract: null,
		bibliography: [],
		methodRecords: [],
		sections: [{ sectionKey: "body", title: "Body", order: 0, content, occurrences: [] }],
		supersedesManuscriptId: null,
		authoring: { origin: "human", provider: null, modelId: null },
		expectedManifestRevision: opened.manifest.revision,
		operationId: operation.value.operationId,
	});
	if (!manuscript.ok) throw new Error(manuscript.errors[0].message);
	opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Benchmark project became read-only");
	const disclosure = await createDisclosure(projectRoot, {
		manuscriptId: manuscript.value.manuscript.manuscriptId,
		aiUse: "No AI-generated content; benchmark fixture only.",
		modelIds: [],
		humanResponsibilities: ["Synthetic benchmark ownership."],
		limitations: ["No substantive research content."],
		unautomatedDecisions: ["No submission decision."],
		expectedManifestRevision: opened.manifest.revision,
		operationId: operation.value.operationId,
	});
	if (!disclosure.ok) throw new Error(disclosure.errors[0].message);

	const measurementsMs: number[] = [];
	for (let sample = 0; sample < 5; sample += 1) {
		const started = performance.now();
		const result = await evaluateSubmissionGate(projectRoot, manuscript.value.manuscript.manuscriptId, null);
		measurementsMs.push(performance.now() - started);
		if (!result.ok) throw new Error(result.errors[0].message);
		if (result.value.checks.some(({ status }) => status === "failed")) {
			throw new Error("Valid benchmark manuscript failed an integrity gate");
		}
	}
	const thresholdMs = 10_000;
	const integrityP95Ms = p95(measurementsMs);
	const report = {
		benchmark: "pi-research-agent-v0.4",
		generatedAt: new Date().toISOString(),
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		fixture: { words: 50_000, sections: 1, claimOccurrences: 0 },
		results: {
			manuscriptIntegrity: {
				samples: measurementsMs.length,
				measurementsMs: measurementsMs.map((value) => Number(value.toFixed(3))),
				p95Ms: integrityP95Ms,
				thresholdMs,
				passed: integrityP95Ms < thresholdMs,
			},
		},
		usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	};
	const output = `${JSON.stringify({ ...report, status: report.results.manuscriptIntegrity.passed ? "passed" : "failed" }, null, 2)}\n`;
	const outputIndex = process.argv.indexOf("--output");
	if (outputIndex >= 0) {
		const outputPath = process.argv[outputIndex + 1];
		if (outputPath === undefined) throw new TypeError("--output requires a path");
		const absolutePath = resolve(process.cwd(), outputPath);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, output);
	}
	process.stdout.write(output);
	if (!report.results.manuscriptIntegrity.passed) process.exitCode = 1;
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
