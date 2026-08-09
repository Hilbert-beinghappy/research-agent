// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { hashBytes, hashFile } from "../src/kernel/integrity.ts";

const FILE_COUNT = 1_001;
const REPETITIONS = 3;
const CONCURRENCIES = [1, 4, 8, 16, 32, 64, 256, 512] as const;
const ORDER_OFFSETS = [0, 3, 6] as const;
const VERIFY_CONCURRENCY = 64;

interface FileSpec {
	content: string;
	expectedHash: string;
	sourceName: string;
	targetName: string;
}

interface Measurement {
	concurrency: number;
	repetition: number;
	stagedWriteAndSyncMs: number;
	stagedHashesValid: boolean;
	hashOnlyMs: number;
	renameOnlyMs: number;
	sourceCount: number;
	targetCount: number;
	finalHashesValid: boolean;
}

async function mapWithConcurrency<Input, Value>(
	values: readonly Input[],
	concurrency: number,
	transform: (value: Input, index: number) => Promise<Value>,
): Promise<Value[]> {
	const transformed = new Array<Value>(values.length);
	const queue = values.entries();
	let stopped = false;
	const failures: { error: unknown; index: number }[] = [];
	const worker = async (): Promise<void> => {
		while (!stopped) {
			const next = queue.next();
			if (next.done) return;
			const [index, value] = next.value;
			try {
				transformed[index] = await transform(value, index);
			} catch (error) {
				failures.push({ error, index });
				stopped = true;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(values.length, concurrency) }, () => worker()));
	const failure = failures.sort((left, right) => left.index - right.index)[0];
	if (failure !== undefined) throw failure.error;
	return transformed;
}

async function writeFsynced(path: string, content: string): Promise<void> {
	const file = await open(path, "wx");
	try {
		await file.writeFile(content);
		await file.sync();
	} finally {
		await file.close();
	}
}

function argumentValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (value === undefined) throw new TypeError(`${name} requires a value`);
	return value;
}

function distribution(values: readonly number[]): { maximumMs: number; medianMs: number; minimumMs: number } {
	const sorted = [...values].sort((left, right) => left - right);
	const minimum = sorted[0];
	const median = sorted[Math.floor(sorted.length / 2)];
	const maximum = sorted.at(-1);
	if (minimum === undefined || median === undefined || maximum === undefined) {
		throw new Error("Diagnostic distribution requires measurements");
	}
	return {
		minimumMs: Number(minimum.toFixed(3)),
		medianMs: Number(median.toFixed(3)),
		maximumMs: Number(maximum.toFixed(3)),
	};
}

async function run(): Promise<void> {
	const candidateCommit = process.env.GITHUB_SHA;
	if (candidateCommit === undefined || !/^[0-9a-f]{40}$/.test(candidateCommit)) {
		throw new TypeError("GITHUB_SHA must identify the exact diagnostic commit");
	}
	const files: FileSpec[] = Array.from({ length: FILE_COUNT }, (_, index) => {
		const suffix = String(index).padStart(4, "0");
		const content = `synthetic staged record ${suffix}\n`;
		return {
			content,
			expectedHash: hashBytes(content).value,
			sourceName: `${suffix}.bin`,
			targetName: `${suffix}.json`,
		};
	});
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-windows-file-publish-"));
	try {
		const measurements: Measurement[] = [];
		for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
			const offset = ORDER_OFFSETS[repetition - 1] ?? 0;
			const orderedConcurrencies = [...CONCURRENCIES.slice(offset), ...CONCURRENCIES.slice(0, offset)];
			for (const concurrency of orderedConcurrencies) {
				const caseDirectory = join(temporaryDirectory, `c${concurrency}-r${repetition}`);
				const sourceDirectory = join(caseDirectory, "staged");
				const targetDirectory = join(caseDirectory, "records");
				await Promise.all([
					mkdir(sourceDirectory, { recursive: true }),
					mkdir(targetDirectory, { recursive: true }),
				]);
				const stagedWriteStarted = performance.now();
				await mapWithConcurrency(files, concurrency, (file) =>
					writeFsynced(join(sourceDirectory, file.sourceName), file.content),
				);
				const stagedWriteAndSyncMs = performance.now() - stagedWriteStarted;

				const hashStarted = performance.now();
				const stagedHashes = await mapWithConcurrency(files, concurrency, (file) =>
					hashFile(join(sourceDirectory, file.sourceName)),
				);
				const hashOnlyMs = performance.now() - hashStarted;
				const stagedHashesValid = stagedHashes.every((hash, index) => hash.value === files[index]?.expectedHash);
				if (!stagedHashesValid) {
					throw new Error("STAGED_HASH_MISMATCH: diagnostic preparation changed staged content");
				}

				const renameStarted = performance.now();
				await mapWithConcurrency(files, concurrency, (file) =>
					rename(join(sourceDirectory, file.sourceName), join(targetDirectory, file.targetName)),
				);
				const renameOnlyMs = performance.now() - renameStarted;
				const [sourceEntries, targetEntries] = await Promise.all([
					readdir(sourceDirectory),
					readdir(targetDirectory),
				]);
				const finalHashes = await mapWithConcurrency(files, VERIFY_CONCURRENCY, (file) =>
					hashFile(join(targetDirectory, file.targetName)),
				);
				const finalHashesValid = finalHashes.every((hash, index) => hash.value === files[index]?.expectedHash);
				if (sourceEntries.length !== 0 || targetEntries.length !== FILE_COUNT || !finalHashesValid) {
					throw new Error("PUBLISH_VALIDATION_FAILED: diagnostic publish did not preserve every staged file");
				}
				measurements.push({
					concurrency,
					repetition,
					stagedWriteAndSyncMs: Number(stagedWriteAndSyncMs.toFixed(3)),
					stagedHashesValid,
					hashOnlyMs: Number(hashOnlyMs.toFixed(3)),
					renameOnlyMs: Number(renameOnlyMs.toFixed(3)),
					sourceCount: sourceEntries.length,
					targetCount: targetEntries.length,
					finalHashesValid,
				});
			}
		}
		const summaries = CONCURRENCIES.map((concurrency) => {
			const matching = measurements.filter((measurement) => measurement.concurrency === concurrency);
			return {
				concurrency,
				stagedWriteAndSync: distribution(matching.map(({ stagedWriteAndSyncMs }) => stagedWriteAndSyncMs)),
				hashOnly: distribution(matching.map(({ hashOnlyMs }) => hashOnlyMs)),
				renameOnly: distribution(matching.map(({ renameOnlyMs }) => renameOnlyMs)),
			};
		});
		const report = {
			format: "doro-windows-file-publish-diagnostic",
			version: 1,
			candidateCommit,
			generatedAt: new Date().toISOString(),
			platform: `${process.platform}-${process.arch}`,
			node: process.version,
			fixture: {
				files: FILE_COUNT,
				repetitions: REPETITIONS,
				concurrencies: CONCURRENCIES,
				orderOffsets: ORDER_OFFSETS,
				stagedFilesFsynced: true,
			},
			measurements,
			summaries,
			evidenceRole: "exploratory",
			status: "diagnostic",
		};
		const output = `${JSON.stringify(report, null, 2)}\n`;
		const outputPath = argumentValue("--output");
		if (outputPath === undefined) process.stdout.write(output);
		else await writeFile(resolve(process.cwd(), outputPath), output);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (process.platform !== "win32") {
	process.stderr.write("WINDOWS_ONLY: raw file publish diagnostics require Windows filesystem semantics\n");
	process.exitCode = 2;
} else {
	await run();
}
