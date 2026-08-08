// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryCandidateDraftV1, PreferenceSignalV1 } from "@research-agent/contracts/memory";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../src/contracts/integrity.ts";
import { memoryMonthPath } from "../src/memory/layout.ts";
import { appendMemoryRecord, createMemoryProfile, openMemoryProfile } from "../src/memory/store.ts";
import { listPendingMemoryTransactions } from "../src/memory/transactions.ts";

interface RecordDigest {
	path: string;
	hash: string;
}

function integerArgument(name: string, fallback: number, maximum: number): number {
	const index = process.argv.indexOf(name);
	if (index < 0) return fallback;
	const value = Number(process.argv[index + 1]);
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
	}
	return value;
}

function hash(value: unknown): `sha256:${string}` {
	return `sha256:${hashCanonicalJson(value).value}`;
}

function signal(profileId: string, index: number, createdAt: string): PreferenceSignalV1 {
	const signalId = `stress-signal-${index.toString().padStart(5, "0")}`;
	return {
		format: "doro-preference-signal",
		schemaVersion: "1.0.0",
		signalId,
		profileId,
		signalType: "explicit_statement",
		actor: "user",
		observedAt: createdAt,
		category: "writing",
		normalizedKey: "language",
		normalizedValue: "zh-CN",
		scopeCandidate: { level: "global" },
		baseWeight: 1,
		dedupeKey: hash({ signalId }),
		dataClass: "public",
		sourceRefs: [{ kind: "session", locator: `session:${signalId}`, dataClass: "public" }],
		sourceContentHash: hash({ source: signalId }),
		captureMethod: { type: "deterministic", ruleVersion: "stress-v1" },
		trustState: "accepted",
		rejectionCode: null,
		createdAt,
	};
}

function candidate(profileId: string, index: number, createdAt: string): MemoryCandidateDraftV1 {
	const candidateId = `stress-candidate-${index.toString().padStart(5, "0")}`;
	return {
		format: "doro-memory-candidate-draft",
		schemaVersion: "1.0.0",
		candidateId,
		profileId,
		category: "writing",
		key: "language",
		value: "zh-CN",
		proposedScope: { level: "global" },
		sourceSignalRefs: [{ signalId: "stress-source", contentHash: hash({ source: candidateId }) }],
		proposedEffects: ["formatting"],
		rationaleCodes: ["stress-randomized-candidate"],
		generatedBy: { type: "rule", version: "stress-v1", outputSchemaHash: hash("candidate-schema") },
		createdAt,
	};
}

async function canonicalRecordPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(join(root, ...directory.split("/")), { withFileTypes: true })) {
			if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
			const path = `${directory}/${entry.name}`;
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".json")) paths.push(path);
			else throw new TypeError(`Unexpected qualification record entry: ${path}`);
		}
	};
	await Promise.all([walk("signals"), walk("candidates")]);
	return paths.sort();
}

async function digestRecords(root: string, paths: readonly string[]): Promise<RecordDigest[]> {
	return Promise.all(
		paths.map(async (path) => ({
			path,
			hash: hashBytes(await readFile(join(root, ...path.split("/")))).value,
		})),
	);
}

const transactionCount = integerArgument("--transactions", 10_000, 100_000);
const seed = integerArgument("--seed", 0x5eed2026, 0xffffffff);
const epoch = "2026-08-08T00:00:00.000Z";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "doro-memory-qualification-"));
const started = performance.now();
let randomState = seed >>> 0;
const nextRandom = (): number => {
	randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
	return randomState;
};

try {
	const created = await createMemoryProfile(root, { profileId: "profile-stress" });
	if (created.mode !== "read-write") throw new Error("Memory qualification profile is not writable");
	const expected: RecordDigest[] = [];
	let signalCount = 0;
	let candidateCount = 0;
	const epochMilliseconds = Date.parse(epoch);
	for (let index = 0; index < transactionCount; index += 1) {
		const createdAt = new Date(epochMilliseconds + index).toISOString();
		const record =
			nextRandom() % 5 === 0
				? candidate(created.profile.profileId, candidateCount++, createdAt)
				: signal(created.profile.profileId, signalCount++, createdAt);
		const path =
			record.format === "doro-preference-signal"
				? `signals/${memoryMonthPath(record.createdAt)}/${record.signalId}.json`
				: `candidates/${record.candidateId}.json`;
		expected.push({ path, hash: hashBytes(`${canonicalStringify(record)}\n`).value });
		await appendMemoryRecord(root, record, { expectedProfileRevision: index });
		if ((index + 1) % 1_000 === 0) {
			process.stderr.write(`memory qualification progress: ${index + 1}/${transactionCount}\n`);
		}
	}

	const opened = await openMemoryProfile(root, { rebuildCache: false });
	const actual = await digestRecords(root, await canonicalRecordPaths(root));
	const pending = await listPendingMemoryTransactions(root);
	const committed = (await readdir(join(root, "transactions", "committed"), { withFileTypes: true })).filter(
		(entry) => entry.isDirectory() && !entry.name.startsWith("._"),
	).length;
	const expectedRoot = hashCanonicalJson(expected.sort((left, right) => left.path.localeCompare(right.path))).value;
	const actualRoot = hashCanonicalJson(actual).value;
	const checks = {
		profileOpenedReadWrite: opened.mode === "read-write",
		profileRevisionExact: opened.mode === "read-write" && opened.profile.revision === transactionCount,
		recordCountsExact:
			opened.mode === "read-write" &&
			opened.counts.signals === signalCount &&
			opened.counts.candidates === candidateCount,
		committedJournalsExact: committed === transactionCount,
		noPendingTransactions: pending.length === 0,
		recordRootExact: actualRoot === expectedRoot,
	};
	const passed = Object.values(checks).every(Boolean);
	const report = {
		qualification: "pi-research-agent-v3-memory-store",
		generatedAt: new Date().toISOString(),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		configuration: { transactions: transactionCount, seed, epoch },
		counts: { signals: signalCount, candidates: candidateCount, committed },
		recordRootHash: `sha256:${actualRoot}`,
		input: {
			storeSha256: hashBytes(await readFile(join(packageRoot, "src/memory/store.ts"))).value,
			transactionsSha256: hashBytes(await readFile(join(packageRoot, "src/memory/transactions.ts"))).value,
			qualificationScriptSha256: hashBytes(await readFile(fileURLToPath(import.meta.url))).value,
		},
		checks,
		elapsedMs: Math.round(performance.now() - started),
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
	await rm(root, { recursive: true, force: true });
}
