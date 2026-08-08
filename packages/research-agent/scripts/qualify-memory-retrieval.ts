// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryItemV1 } from "@research-agent/contracts/memory";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../src/contracts/integrity.ts";
import {
	MEMORY_RETRIEVAL_INDEX_PATH,
	type MemoryRetrievalQuery,
	rankActiveMemoryItems,
	retrievePersonalMemory,
} from "../src/memory/retrieval.ts";
import { createMemoryProfile } from "../src/memory/store.ts";

const now = "2026-08-08T12:00:00.000Z";
const hash = `sha256:${"0".repeat(64)}` as const;
const sizes = [1_000, 10_000, 50_000] as const;
const iterations = 30;
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const preferenceVariants = [
	{ category: "output", key: "presentation_style", value: "table" },
	{ category: "output", key: "artifact_format", value: "markdown" },
	{ category: "output", key: "filename_template_id", value: "default" },
	{ category: "writing", key: "language", value: "zh-CN" },
	{ category: "writing", key: "target_length", value: 1_200 },
	{ category: "writing", key: "heading_level", value: 2 },
	{ category: "writing", key: "representation", value: "table" },
	{ category: "writing", key: "tone", value: "concise" },
] as const;

function item(index: number): MemoryItemV1 {
	const preference = preferenceVariants[index % preferenceVariants.length] as (typeof preferenceVariants)[number];
	return {
		format: "doro-memory-item",
		schemaVersion: "1.0.0",
		profileId: "profile-qualification",
		memoryId: `memory-${String(index).padStart(5, "0")}`,
		revision: 1,
		previousRevision: null,
		status: "active",
		category: preference.category,
		key: preference.key,
		value: preference.value,
		origin: "explicit",
		scope: { level: "global" },
		confidence: 1,
		supportCount: 3,
		independentSupportCount: 3,
		contradictionCount: 0,
		dataClass: "public",
		allowedEffects: ["formatting"],
		criticalDecisionPolicy: "format_only",
		sourceSignalRefs: [{ signalId: `signal-${index}`, contentHash: hash }],
		supersedes: [],
		generator: { type: "rule", version: "qualification-v1", schemaHash: hash },
		provenanceHash: hash,
		validFrom: now,
		validUntil: null,
		lastSupportedAt: now,
		lastUsedAt: null,
		decay: { halfLifeDays: 180 },
		createdAt: now,
		transactionId: `tx-${index}`,
	};
}

const query: MemoryRetrievalQuery = {
	taskCategories: ["output", "writing"],
	keywords: [],
	effect: "formatting",
	allowedDataClasses: ["public"],
	criticalDecision: false,
	availableContextTokens: 20_000,
	requestedMaxTokens: 800,
	now,
};

function percentile(samples: readonly number[], quantile: number): number {
	return samples[Math.ceil(samples.length * quantile) - 1] as number;
}

async function endToEndTenThousand(): Promise<{
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
	estimatedTokens: number;
	selectedItems: number;
}> {
	const root = await mkdtemp(join(tmpdir(), "doro-memory-retrieval-qualification-"));
	try {
		const created = await createMemoryProfile(root, { profileId: "profile-qualification" });
		if (created.mode !== "read-write") throw new Error("qualification profile is not writable");
		const items = Array.from({ length: 10_000 }, (_value, index) => item(index));
		const sortedItems = [...items].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
		const currentItemRootHash = `sha256:${hashCanonicalJson(sortedItems).value}`;
		const profile = {
			...created.profile,
			revision: 1,
			preferenceRefs: {
				output: sortedItems
					.filter(({ category }) => category === "output")
					.map(({ memoryId, revision }) => ({ memoryId, revision })),
				writing: sortedItems
					.filter(({ category }) => category === "writing")
					.map(({ memoryId, revision }) => ({ memoryId, revision })),
			},
			currentItemRootHash,
			lastTransactionId: "tx-qualification",
		};
		for (let start = 0; start < sortedItems.length; start += 250) {
			await Promise.all(
				sortedItems.slice(start, start + 250).map(async (memoryItem) => {
					const directory = join(root, "items", memoryItem.category, memoryItem.memoryId);
					await mkdir(directory, { recursive: true });
					await writeFile(join(directory, "1.json"), `${canonicalStringify(memoryItem)}\n`);
				}),
			);
		}
		await writeFile(join(root, "profile.json"), `${canonicalStringify(profile)}\n`);
		await writeFile(
			join(root, ...MEMORY_RETRIEVAL_INDEX_PATH.split("/")),
			`${canonicalStringify({
				format: "doro-memory-retrieval-index",
				version: 1,
				basedOnProfileRevision: profile.revision,
				currentItemRootHash,
				items: sortedItems,
			})}\n`,
		);
		const initialized = await retrievePersonalMemory(root, query);
		if (initialized.status !== "applied") {
			throw new Error(`end-to-end retrieval initialization failed: ${JSON.stringify(initialized)}`);
		}
		for (let index = 0; index < 5; index += 1) {
			const warmup = await retrievePersonalMemory(root, query);
			if (warmup.status !== "applied" || warmup.cacheStatus !== "valid") {
				throw new Error(`end-to-end retrieval warmup failed: ${JSON.stringify(warmup)}`);
			}
		}
		const samples: number[] = [];
		let estimatedTokens = 0;
		let selectedItems = 0;
		for (let index = 0; index < iterations; index += 1) {
			const started = performance.now();
			const result = await retrievePersonalMemory(root, query);
			samples.push(performance.now() - started);
			if (result.status !== "applied") throw new Error("end-to-end retrieval failed");
			estimatedTokens = result.estimatedTokens;
			selectedItems = result.items.length;
		}
		samples.sort((left, right) => left - right);
		return {
			p50Ms: Number(percentile(samples, 0.5).toFixed(6)),
			p95Ms: Number(percentile(samples, 0.95).toFixed(6)),
			maxMs: Number((samples.at(-1) as number).toFixed(6)),
			estimatedTokens,
			selectedItems,
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const benchmarks = sizes.map((size) => {
	const items = Array.from({ length: size }, (_value, index) => item(index));
	for (let index = 0; index < 5; index += 1) rankActiveMemoryItems(items, query);
	const samples: number[] = [];
	let topMemoryId = "";
	for (let index = 0; index < iterations; index += 1) {
		const started = performance.now();
		const ranked = rankActiveMemoryItems(items, query);
		samples.push(performance.now() - started);
		topMemoryId = ranked[0]?.item.memoryId ?? "";
	}
	samples.sort((left, right) => left - right);
	return {
		size,
		iterations,
		p50Ms: Number(percentile(samples, 0.5).toFixed(6)),
		p95Ms: Number(percentile(samples, 0.95).toFixed(6)),
		maxMs: Number((samples.at(-1) as number).toFixed(6)),
		topMemoryId,
	};
});

const tenThousand = benchmarks.find(({ size }) => size === 10_000);
const endToEnd = await endToEndTenThousand();
const checks = {
	tenThousandP95AtMost75Ms: tenThousand !== undefined && tenThousand.p95Ms <= 75,
	endToEndTenThousandP95AtMost75Ms: endToEnd.p95Ms <= 75,
	deterministicTopItem: benchmarks.every(({ topMemoryId }) => topMemoryId === "memory-00000"),
	maximumItemsAtMostEight: endToEnd.selectedItems === 8,
	contextAtMost800Tokens: endToEnd.estimatedTokens <= 800,
	contextAtMostFivePercent: endToEnd.estimatedTokens <= Math.floor(query.availableContextTokens * 0.05),
};
const scriptPath = fileURLToPath(import.meta.url);
const report = {
	qualification: "pi-research-agent-v3-memory-retrieval",
	generatedAt: new Date().toISOString(),
	platform: `${process.platform}-${process.arch}`,
	node: process.version,
	configuration: { sizes, iterations, warmupIterations: 5 },
	benchmarks,
	endToEndTenThousand: endToEnd,
	context: {
		estimatedTokens: endToEnd.estimatedTokens,
		maximumTokens: 800,
		availableContextTokens: query.availableContextTokens,
	},
	input: {
		retrievalSha256: hashBytes(await readFile(join(packageRoot, "src/memory/retrieval.ts"))).value,
		qualificationScriptSha256: hashBytes(await readFile(scriptPath)).value,
	},
	checks,
	usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	status: Object.values(checks).every(Boolean) ? "passed" : "failed",
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
if (report.status !== "passed") process.exitCode = 1;
