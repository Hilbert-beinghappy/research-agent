// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { renderArtifact } from "../src/artifacts/render.ts";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";
import { RESEARCH_SCHEMA_VERSION, type ResearchProjectManifest, type SourceRecord } from "../src/contracts/schemas.ts";
import { projectStatus } from "../src/extension/commands.ts";
import { createOpaqueId } from "../src/kernel/identity.ts";
import { hashBytes } from "../src/kernel/integrity.ts";
import { deduplicateCandidates } from "../src/literature/deduplicate.ts";
import { normalizeMetadataCandidate } from "../src/literature/normalize.ts";
import { initializeProject } from "../src/project/init.ts";
import { openProject } from "../src/project/open.ts";
import { calculateRecordSetIndex, projectRecordPath } from "../src/project/record-index.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const timestamp = "2026-08-06T00:00:00.000Z";
const sourceCount = 1_000;
const literatureCount = 20;

function commandVersion(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { encoding: "utf8", cwd: repositoryRoot });
	if (result.status !== 0) return null;
	return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u)[0] ?? null;
}

function percentile95(samples: readonly number[]): number {
	const sorted = [...samples].sort((left, right) => left - right);
	const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
	const value = sorted[index];
	if (value === undefined) throw new Error("Benchmark produced no samples");
	return Number(value.toFixed(3));
}

async function sample(milliseconds: () => Promise<void>, count: number): Promise<number[]> {
	const values: number[] = [];
	for (let index = 0; index < count; index += 1) {
		const started = performance.now();
		await milliseconds();
		values.push(performance.now() - started);
	}
	return values;
}

function sourceRecord(index: number, operationId: string): SourceRecord {
	const sourceId = createOpaqueId("source");
	const number = index.toString().padStart(4, "0");
	const doi = `10.5555/benchmark.${number}`;
	return {
		kind: "source",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		sourceId,
		identifiers: [{ scheme: "doi", value: doi, normalizedValue: doi, verified: false, verificationId: null }],
		title: `Benchmark source ${number}`,
		titleNormalized: `benchmark source ${number}`,
		contributors: [{ family: `Author${number}`, given: "A", literal: null, orcid: null }],
		issuedDate: "2024",
		containerTitle: "Synthetic Research Fixtures",
		publisher: null,
		sourceType: "journal-article",
		language: "en",
		abstractText: null,
		abstractRights: "metadata_only",
		discovery: [],
		dedupKeys: {
			doi,
			strongIdentifier: `doi:${doi}`,
			normalizedTitleYearFirstAuthor: `benchmark source ${number}|2024|author${number}`,
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
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

async function seedSourceProject(projectRoot: string): Promise<{ records: SourceRecord[]; bytes: number }> {
	const initialized = await initializeProject(projectRoot, { title: "v0.1 performance fixture" });
	if (initialized.compatibility !== "current") throw new Error("Benchmark project is not writable");
	const operationId = createOpaqueId("operation");
	const records = Array.from({ length: sourceCount }, (_, index) => sourceRecord(index, operationId));
	const contents = records.map((record) => `${canonicalStringify(record)}\n`);
	await Promise.all(
		records.map(async (record, index) => {
			const content = contents[index];
			if (content === undefined) throw new Error("Benchmark source content is missing");
			const path = projectRecordPath(initialized.manifest, "source", record.sourceId);
			await writeFile(join(projectRoot, ...path.split("/")), content, { flag: "wx" });
		}),
	);
	const sourceIndex = await calculateRecordSetIndex(projectRoot, initialized.manifest, "source");
	const manifest: ResearchProjectManifest = {
		...initialized.manifest,
		recordSets: initialized.manifest.recordSets.map((recordSet) =>
			recordSet.kind === "source" ? { ...recordSet, ...sourceIndex } : recordSet,
		),
	};
	await writeFile(join(projectRoot, "research-project.json"), `${canonicalStringify(manifest)}\n`);
	return { records, bytes: contents.reduce((total, content) => total + Buffer.byteLength(content), 0) };
}

function normalizedCandidates(count: number) {
	return Array.from({ length: count }, (_, index) => {
		const pair = Math.floor(index / 2)
			.toString()
			.padStart(4, "0");
		const content = `candidate-${index}`;
		return normalizeMetadataCandidate({
			candidateId: content,
			adapterId: index % 2 === 0 ? "crossref" : "openalex",
			retrievedAt: timestamp,
			rawRecord: {
				path: `.research/runs/benchmark/raw-${index}.json`,
				hash: hashBytes(content),
				mediaType: "application/json",
				bytes: Buffer.byteLength(content),
			},
			metadata: {
				doi: `10.5555/dedup.${pair}`,
				title: `Deterministic duplicate pair ${pair}`,
				authors: [{ family: `Author${pair}`, given: "A" }],
				issuedDate: "2024",
				type: "journal-article",
			},
			documentContentHash: null,
			requiresBibliographicMatch: false,
		});
	});
}

async function run(): Promise<void> {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-research-agent-benchmark-"));
	const cpuStart = process.cpuUsage();
	try {
		const projectRoot = join(tempRoot, "source-project");
		const seeded = await seedSourceProject(projectRoot);
		const openStatusSamples = await sample(async () => {
			const opened = await openProject(projectRoot);
			if (opened.compatibility !== "current") throw new Error("Benchmark project became read-only");
			const status = await projectStatus(opened);
			if (
				status === null ||
				typeof status !== "object" ||
				Array.isArray(status) ||
				status.recordCounts === null ||
				typeof status.recordCounts !== "object" ||
				Array.isArray(status.recordCounts) ||
				status.recordCounts.source !== sourceCount
			) {
				throw new Error("Benchmark status did not observe 1,000 sources");
			}
		}, 20);

		const candidates = normalizedCandidates(sourceCount);
		const dedupSamples = await sample(async () => {
			const result = deduplicateCandidates(candidates);
			if (result.automaticMergeGroups.length !== sourceCount / 2) {
				throw new Error("Benchmark deduplication produced an unexpected group count");
			}
		}, 20);

		let artifactOutputBytes = 0;
		const offlineSamples = await sample(async () => {
			const normalized = normalizedCandidates(literatureCount);
			const deduplicated = deduplicateCandidates(normalized);
			if (deduplicated.automaticMergeGroups.length !== literatureCount / 2) {
				throw new Error("Offline literature flow did not preserve duplicate pairs");
			}
			const records = seeded.records.slice(0, literatureCount);
			const rendered = [
				renderArtifact("json", records, null),
				renderArtifact("ris", records, null),
				renderArtifact("bibtex", records, null),
				renderArtifact("evidence-matrix", records, null),
				renderArtifact("review", records, "# Synthetic review\n\nEvidence-bounded fixture output."),
			];
			artifactOutputBytes = rendered.reduce((total, artifact) => total + Buffer.byteLength(artifact.content), 0);
			const outputRoot = join(tempRoot, "offline-output");
			await mkdir(outputRoot, { recursive: true });
			await Promise.all(
				rendered.map(({ extension, content }, index) =>
					writeFile(join(outputRoot, `${index}.${extension}`), content),
				),
			);
		}, 5);

		const openStatusP95Ms = percentile95(openStatusSamples);
		const dedupP95Ms = percentile95(dedupSamples);
		const offline20P95Ms = percentile95(offlineSamples);
		const cpu = process.cpuUsage(cpuStart);
		const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
		const report = {
			benchmark: "pi-research-agent-v0.1",
			generatedAt: new Date().toISOString(),
			sourceRevision: git.status === 0 ? git.stdout.trim() : null,
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			platform: {
				os: process.platform,
				architecture: process.arch,
				release: release(),
				cpu: cpus()[0]?.model ?? "unknown",
				logicalCpuCount: cpus().length,
				memoryBytes: totalmem(),
				storage: "OS-managed temporary directory; medium not detected",
				node: process.version,
				python: commandVersion("python3", ["--version"]),
				r: commandVersion("R", ["--version"]),
			},
			fixture: {
				sourceRecordCount: sourceCount,
				sourceRecordBytes: seeded.bytes,
				rawPayloadBytes: 0,
				parsedTextBytes: 0,
				artifactOutputBytes,
				dedupCandidateCount: sourceCount,
				offlineLiteratureCount: literatureCount,
			},
			results: {
				projectOpenAndStatus: {
					samples: openStatusSamples.length,
					p95Ms: openStatusP95Ms,
					thresholdMs: 1_000,
					passed: openStatusP95Ms < 1_000,
				},
				deterministicDeduplication: {
					samples: dedupSamples.length,
					p95Ms: dedupP95Ms,
					thresholdMs: 3_000,
					passed: dedupP95Ms < 3_000,
				},
				offline20LiteratureFlow: {
					samples: offlineSamples.length,
					p95Ms: offline20P95Ms,
					thresholdMs: 30_000,
					passed: offline20P95Ms < 30_000,
				},
			},
			resources: {
				cpuUserMs: Number((cpu.user / 1_000).toFixed(3)),
				cpuSystemMs: Number((cpu.system / 1_000).toFixed(3)),
				maxRssKiB: process.resourceUsage().maxRSS,
				diskGrowthBytes: seeded.bytes + artifactOutputBytes,
			},
			usage: {
				modelCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheHits: 0,
				modelCostUsd: 0,
				apiRequests: 0,
				http429: 0,
				http5xx: 0,
				retries: 0,
				apiCostUsd: 0,
				recoveryAvoidedWork: 0,
			},
		};
		const passed = Object.values(report.results).every((result) => result.passed);
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
		await rm(tempRoot, { recursive: true, force: true });
	}
}

await run();
