// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";
import { RESEARCH_SCHEMA_VERSION, type ResearchProjectManifest } from "../src/contracts/schemas.ts";
import { queryCorpusRecords } from "../src/evidence/query.ts";
import { projectStatus } from "../src/extension/commands.ts";
import { createOpaqueId } from "../src/kernel/identity.ts";
import { hashCanonicalJson } from "../src/kernel/integrity.ts";
import { initializeProject } from "../src/project/init.ts";
import { PROJECT_MANIFEST_PATH } from "../src/project/layout.ts";
import { migrateProject } from "../src/project/migrate.ts";
import { openProject } from "../src/project/open.ts";

function p95(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	if (value === undefined) throw new Error("Benchmark produced no measurements");
	return Number(value.toFixed(3));
}

function identifier(prefix: "ev" | "src", index: number): string {
	return `${prefix}_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-v1.0-benchmark-"));
try {
	const projectRoot = join(temporaryDirectory, "large-project");
	await initializeProject(projectRoot, { title: "10k source / 50k evidence benchmark" });
	let opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Benchmark project is not writable");
	const sourceCount = 10_000;
	const evidenceCount = 50_000;
	const sourceHash = hashCanonicalJson({ fixture: "synthetic-sources", count: sourceCount });
	const evidenceHash = hashCanonicalJson({ fixture: "synthetic-evidence", count: evidenceCount });
	const manifest: ResearchProjectManifest = {
		...opened.manifest,
		recordSets: opened.manifest.recordSets.map((recordSet) => {
			if (recordSet.kind === "source") return { ...recordSet, count: sourceCount, contentHash: sourceHash };
			if (recordSet.kind === "evidence") return { ...recordSet, count: evidenceCount, contentHash: evidenceHash };
			return recordSet;
		}),
	};
	await writeFile(join(projectRoot, PROJECT_MANIFEST_PATH), `${canonicalStringify(manifest)}\n`);
	const fingerprint = hashCanonicalJson([{ kind: "evidence", count: evidenceCount, contentHash: evidenceHash }]).value;
	const candidates = Array.from({ length: evidenceCount }, (_, index) => {
		const target = index % 5_000 === 0;
		const text = target
			? `Needle evidence ${index} about transparent public algorithms`
			: `Synthetic evidence ${index} about public administration`;
		return {
			hitKind: "evidence",
			record: { kind: "evidence", id: identifier("ev", index), revision: 0 },
			sourceId: identifier("src", index % sourceCount),
			documentId: null,
			evidenceLevel: "abstract",
			validity: "active",
			locator: null,
			text,
			truncated: false,
			warnings: [],
			sortKey: `3:${identifier("ev", index)}`,
			searchText: text.toLowerCase(),
		};
	});
	const payload = { version: 1, kind: "evidence", fingerprint, candidates };
	await writeFile(
		join(projectRoot, ".research/cache/corpus-evidence-v1.json"),
		`${canonicalStringify({ ...payload, contentHash: hashCanonicalJson(payload) })}\n`,
	);

	const statusMeasurementsMs: number[] = [];
	for (let sample = 0; sample < 30; sample += 1) {
		const started = performance.now();
		opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("Benchmark project became read-only");
		const status = await projectStatus(opened);
		statusMeasurementsMs.push(performance.now() - started);
		if (
			status === null ||
			typeof status !== "object" ||
			Array.isArray(status) ||
			status.format !== "pi-research-status"
		) {
			throw new Error("Status result is invalid");
		}
	}

	const queryMeasurementsMs: number[] = [];
	for (let sample = 0; sample < 20; sample += 1) {
		const started = performance.now();
		const result = await queryCorpusRecords(
			projectRoot,
			{
				query: "needle",
				scope: "evidence",
				filters: { evidenceLevel: "abstract", validity: "active" },
				limit: 20,
				maxCharsPerHit: 200,
				cursor: null,
			},
			createOpaqueId("operation"),
		);
		queryMeasurementsMs.push(performance.now() - started);
		if (!result.ok || result.value.hits.length !== 10) throw new Error("Filtered corpus query missed targets");
	}

	const migrationRoot = join(temporaryDirectory, "migration-project");
	await initializeProject(migrationRoot, { title: "Migration performance fixture" });
	const migrationManifest = JSON.parse(
		await readFile(join(migrationRoot, PROJECT_MANIFEST_PATH), "utf8"),
	) as ResearchProjectManifest;
	await writeFile(
		join(migrationRoot, PROJECT_MANIFEST_PATH),
		`${canonicalStringify({ ...migrationManifest, schemaVersion: "0.5.0" })}\n`,
	);
	const migrationStarted = performance.now();
	const migration = await migrateProject(migrationRoot);
	const migrationMs = Number((performance.now() - migrationStarted).toFixed(3));
	if (migration.toVersion !== RESEARCH_SCHEMA_VERSION) throw new Error("Migration benchmark did not reach v1.0");

	const thresholdMs = 2_000;
	const statusP95Ms = p95(statusMeasurementsMs);
	const queryP95Ms = p95(queryMeasurementsMs);
	const passed = statusP95Ms < thresholdMs && queryP95Ms < thresholdMs;
	const report = {
		benchmark: "pi-research-agent-v1.0",
		generatedAt: new Date().toISOString(),
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		fixture: { sources: sourceCount, evidence: evidenceCount, filteredMatches: 10 },
		results: {
			manifestStatus: {
				samples: statusMeasurementsMs.length,
				measurementsMs: statusMeasurementsMs.map((value) => Number(value.toFixed(3))),
				p95Ms: statusP95Ms,
				thresholdMs,
				passed: statusP95Ms < thresholdMs,
			},
			filteredCorpusQuery: {
				samples: queryMeasurementsMs.length,
				measurementsMs: queryMeasurementsMs.map((value) => Number(value.toFixed(3))),
				p95Ms: queryP95Ms,
				thresholdMs,
				passed: queryP95Ms < thresholdMs,
			},
			migrationWithBackup: { samples: 1, elapsedMs: migrationMs, recovered: migration.recovered },
		},
		usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	};
	const output = `${JSON.stringify({ ...report, status: passed ? "passed" : "failed" }, null, 2)}\n`;
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
