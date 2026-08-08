// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import type { HashValue, JsonValue, ResearchProjectManifest } from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { hashBytes, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath, validatePortablePathSet, validateProjectRelativePath } from "../kernel/paths.ts";
import { atomicWriteFile, syncParentDirectory } from "./atomic-write.ts";
import { PROJECT_MANIFEST_PATH } from "./layout.ts";
import { openProject } from "./open.ts";
import { type ProjectTransactionTraceContext, traceProjectTransactionPhase } from "./transaction-trace.ts";
import { withProjectWriterLease } from "./writer-lock.ts";

export interface TransactionWrite {
	path: string;
	content: string | Uint8Array | null;
	expectedHash?: HashValue | null;
}

export interface ProjectTransactionInput {
	expectedRevision: number;
	writes: readonly TransactionWrite[];
	manifest: ResearchProjectManifest;
}

interface TransactionEntry {
	path: string;
	oldHash: HashValue | null;
	newHash: HashValue | null;
}

interface TransactionJournal {
	version: 1;
	transactionId: string;
	expectedRevision: number;
	createdAt: string;
	entries: TransactionEntry[];
}

type TransactionFileState = "old" | "new" | "other";

const PENDING_DIRECTORY = ".research/transactions/pending";
const COMMITTED_DIRECTORY = ".research/transactions/committed";
const FAILED_DIRECTORY = ".research/transactions/failed";
const TRANSACTION_IO_BATCH_SIZE = 512;

function traceContextFromInput(input: ProjectTransactionInput): ProjectTransactionTraceContext {
	return {
		...(input.manifest.lastCommittedOperationId === null
			? {}
			: { operationId: input.manifest.lastCommittedOperationId }),
		manifestRevision: input.expectedRevision,
		recordCount: input.manifest.recordSets.reduce((total, recordSet) => total + recordSet.count, 0),
		writeCount: input.writes.length,
	};
}

async function settleBatch<Value>(promises: readonly Promise<Value>[]): Promise<Value[]> {
	const values: Value[] = [];
	for (const result of await Promise.allSettled(promises)) {
		if (result.status === "rejected") throw result.reason;
		values.push(result.value);
	}
	return values;
}

async function transactionPathResolver(projectRoot: string): Promise<(path: string) => Promise<string>> {
	const canonicalRoot = await realpath(projectRoot);
	const directories = new Map<string, Promise<string>>([["", Promise.resolve(canonicalRoot)]]);
	return async (path) => {
		const segments = validateProjectRelativePath(path).split("/");
		const fileName = segments.pop();
		if (fileName === undefined) throw new TypeError(`Invalid transaction path: ${path}`);
		const parentPath = segments.join("/");
		let parent = directories.get(parentPath);
		if (parent === undefined) {
			parent = resolveProjectPath(canonicalRoot, parentPath);
			directories.set(parentPath, parent);
		}
		return join(await parent, fileName);
	};
}

export async function listPendingProjectTransactions(projectRoot: string): Promise<string[]> {
	const entries = await readdir(await resolveProjectPath(projectRoot, PENDING_DIRECTORY), { withFileTypes: true });
	const ids: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^tx_[0-9a-f-]{36}$/.test(entry.name)) {
			throw new TypeError(`Invalid pending transaction entry: ${entry.name}`);
		}
		ids.push(entry.name);
	}
	return ids.sort();
}

function transactionDirectory(statusDirectory: string, transactionId: string): string {
	if (!/^tx_[0-9a-f-]{36}$/.test(transactionId)) throw new TypeError(`Invalid transaction ID: ${transactionId}`);
	return `${statusDirectory}/${transactionId}`;
}

function hashFromJson(value: JsonValue | undefined): HashValue | null | undefined {
	if (value === null) return null;
	if (
		value === undefined ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value.algorithm !== "sha256" ||
		typeof value.value !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.value)
	) {
		return undefined;
	}
	return { algorithm: "sha256", value: value.value };
}

async function existingHash(path: string, rejectSymbolicLink = true): Promise<HashValue | null> {
	try {
		if (rejectSymbolicLink && (await lstat(path)).isSymbolicLink()) {
			throw new TypeError(`Transaction target is a symbolic link: ${path}`);
		}
		return await hashFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function fileState(
	path: string,
	entry: TransactionEntry,
	alreadyValidatedRegularFile = false,
): Promise<TransactionFileState> {
	const currentHash = await existingHash(path, !alreadyValidatedRegularFile);
	if ((currentHash === null && entry.newHash === null) || currentHash?.value === entry.newHash?.value) return "new";
	if (currentHash?.value === entry.oldHash?.value || (currentHash === null && entry.oldHash === null)) return "old";
	return "other";
}

async function readJournal(projectRoot: string, transactionId: string): Promise<TransactionJournal> {
	const directory = transactionDirectory(PENDING_DIRECTORY, transactionId);
	const raw = canonicalizeJson(
		JSON.parse(await readFile(await resolveProjectPath(projectRoot, `${directory}/transaction.json`), "utf8")),
	);
	if (
		raw === null ||
		typeof raw !== "object" ||
		Array.isArray(raw) ||
		raw.version !== 1 ||
		raw.transactionId !== transactionId ||
		typeof raw.expectedRevision !== "number" ||
		!Number.isInteger(raw.expectedRevision) ||
		typeof raw.createdAt !== "string" ||
		!Array.isArray(raw.entries)
	) {
		throw new TypeError(`Invalid transaction journal: ${transactionId}`);
	}

	const entries: TransactionEntry[] = [];
	for (const value of raw.entries) {
		if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.path !== "string") {
			throw new TypeError(`Invalid transaction journal entry: ${transactionId}`);
		}
		const oldHash = hashFromJson(value.oldHash);
		const newHash = hashFromJson(value.newHash);
		if (oldHash === undefined || newHash === undefined) {
			throw new TypeError(`Invalid transaction journal hash: ${transactionId}`);
		}
		const path = validateProjectRelativePath(value.path);
		if (path === ".research/transactions" || path.startsWith(".research/transactions/")) {
			throw new TypeError(`Transaction journal targets its own workspace: ${transactionId}`);
		}
		entries.push({ path, oldHash, newHash });
	}
	if (entries.length === 0 || entries.at(-1)?.path !== PROJECT_MANIFEST_PATH) {
		throw new TypeError(`Transaction manifest must be the final entry: ${transactionId}`);
	}
	if (entries.at(-1)?.newHash === null)
		throw new TypeError(`Transaction manifest cannot be deleted: ${transactionId}`);
	validatePortablePathSet(entries.map(({ path }) => path));
	return {
		version: 1,
		transactionId,
		expectedRevision: raw.expectedRevision,
		createdAt: raw.createdAt,
		entries,
	};
}

async function moveTransaction(projectRoot: string, transactionId: string, destination: string): Promise<void> {
	const source = await resolveProjectPath(projectRoot, transactionDirectory(PENDING_DIRECTORY, transactionId));
	const target = await resolveProjectPath(projectRoot, transactionDirectory(destination, transactionId));
	await rename(source, target);
	await Promise.all([syncParentDirectory(source), syncParentDirectory(target)]);
}

async function prepareProjectTransactionUnlocked(
	projectRoot: string,
	input: ProjectTransactionInput,
	traceContext = traceContextFromInput(input),
): Promise<string> {
	const pending = await traceProjectTransactionPhase("pending_transaction_scan", traceContext, () =>
		listPendingProjectTransactions(projectRoot),
	);
	if (pending.length > 0) {
		throw new Error("PROJECT_RECOVERY_REQUIRED: recover the pending project transaction before writing");
	}
	const opened = await traceProjectTransactionPhase("project_open", traceContext, () =>
		openProject(projectRoot, input.expectedRevision),
	);
	if (opened.compatibility !== "current") throw new Error("Project schema is read-only");
	const validation = validatePersistedRecord(input.manifest);
	if (!validation.ok || validation.value.kind !== "research_project_manifest") {
		throw new TypeError("Transaction manifest is invalid");
	}
	if (
		input.manifest.projectId !== opened.manifest.projectId ||
		input.manifest.revision !== input.expectedRevision + 1
	) {
		throw new Error("Transaction manifest must preserve project ID and increment revision once");
	}
	const paths = input.writes.map(({ path }) => path);
	if (
		paths.some(
			(path) =>
				path === PROJECT_MANIFEST_PATH ||
				path === ".research/transactions" ||
				path.startsWith(".research/transactions/"),
		)
	) {
		throw new TypeError("Transaction writes cannot target the manifest or transaction workspace directly");
	}
	validatePortablePathSet([...paths, PROJECT_MANIFEST_PATH]);
	const resolveTransactionPath = await transactionPathResolver(projectRoot);
	const preflightHashes = new Map<string, HashValue | null>();
	await traceProjectTransactionPhase("transaction_preflight", traceContext, async () => {
		for (let offset = 0; offset < input.writes.length; offset += TRANSACTION_IO_BATCH_SIZE) {
			await Promise.all(
				input.writes.slice(offset, offset + TRANSACTION_IO_BATCH_SIZE).map(async (write) => {
					if (write.expectedHash === undefined) return;
					const oldHash = await existingHash(await resolveTransactionPath(write.path));
					preflightHashes.set(write.path, oldHash);
					if (write.expectedHash?.value !== oldHash?.value) {
						throw new Error(`DATA_CONFLICT: target changed before transaction prepare: ${write.path}`);
					}
				}),
			);
		}
	});

	const transactionId = `tx_${randomUUID()}`;
	const directory = transactionDirectory(PENDING_DIRECTORY, transactionId);
	await traceProjectTransactionPhase("journal_prepare", { ...traceContext, transactionId }, async () => {
		await mkdir(await resolveProjectPath(projectRoot, `${directory}/staged`), { recursive: true });
		await mkdir(await resolveProjectPath(projectRoot, `${directory}/backups`), { recursive: true });
		const writes: readonly TransactionWrite[] = [
			...input.writes,
			{ path: PROJECT_MANIFEST_PATH, content: `${canonicalStringify(input.manifest)}\n` },
		];
		const entries: TransactionEntry[] = [];
		for (let offset = 0; offset < writes.length; offset += TRANSACTION_IO_BATCH_SIZE) {
			const batch = writes.slice(offset, offset + TRANSACTION_IO_BATCH_SIZE);
			entries.push(
				...(await settleBatch(
					batch.map(async (write, batchIndex): Promise<TransactionEntry> => {
						const index = offset + batchIndex;
						const target = await resolveTransactionPath(write.path);
						const oldHash =
							write.expectedHash === null && preflightHashes.has(write.path)
								? (preflightHashes.get(write.path) ?? null)
								: await existingHash(target);
						if (write.expectedHash !== undefined && write.expectedHash?.value !== oldHash?.value) {
							throw new Error(`DATA_CONFLICT: target changed before transaction prepare: ${write.path}`);
						}
						if (oldHash !== null) {
							const backup = await resolveTransactionPath(`${directory}/backups/${index}.bin`);
							await copyFile(target, backup);
							const backupFile = await open(backup, "r+");
							try {
								await backupFile.sync();
							} finally {
								await backupFile.close();
							}
							if ((await hashFile(backup)).value !== oldHash.value) {
								throw new Error(`Backup hash mismatch: ${write.path}`);
							}
						}
						let newHash: HashValue | null = null;
						if (write.content !== null) {
							const staged = await resolveTransactionPath(`${directory}/staged/${index}.bin`);
							await atomicWriteFile(staged, write.content);
							newHash = hashBytes(write.content);
						}
						return { path: write.path, oldHash, newHash };
					}),
				)),
			);
		}

		const journal: TransactionJournal = {
			version: 1,
			transactionId,
			expectedRevision: input.expectedRevision,
			createdAt: new Date().toISOString(),
			entries,
		};
		await atomicWriteFile(
			await resolveProjectPath(projectRoot, `${directory}/transaction.json`),
			`${canonicalStringify(journal)}\n`,
		);
	});
	return transactionId;
}

async function commitPreparedTransactionUnlocked(projectRoot: string, transactionId: string): Promise<void> {
	const journal = await readJournal(projectRoot, transactionId);
	const directory = transactionDirectory(PENDING_DIRECTORY, transactionId);
	const resolveTransactionPath = await transactionPathResolver(projectRoot);
	const traceContext: ProjectTransactionTraceContext = {
		transactionId,
		manifestRevision: journal.expectedRevision,
		writeCount: journal.entries.length - 1,
	};
	const states = await traceProjectTransactionPhase("transaction_preflight", traceContext, () =>
		Promise.all(journal.entries.map(async (entry) => fileState(await resolveTransactionPath(entry.path), entry))),
	);
	if (states.includes("other")) throw new Error(`Transaction target hash mismatch: ${transactionId}`);
	if (states.at(-1) === "new") {
		await traceProjectTransactionPhase("post_commit_verify", traceContext, async () => {
			if (states.some((state) => state !== "new")) {
				throw new Error(`Committed transaction has mixed state: ${transactionId}`);
			}
		});
		await traceProjectTransactionPhase("journal_archive", traceContext, () =>
			moveTransaction(projectRoot, transactionId, COMMITTED_DIRECTORY),
		);
		return;
	}
	await traceProjectTransactionPhase("project_open", traceContext, () =>
		openProject(projectRoot, journal.expectedRevision),
	);

	const manifestIndex = journal.entries.length - 1;
	await traceProjectTransactionPhase("data_commit", traceContext, async () => {
		for (let offset = 0; offset < manifestIndex; offset += TRANSACTION_IO_BATCH_SIZE) {
			const batch = journal.entries.slice(offset, Math.min(offset + TRANSACTION_IO_BATCH_SIZE, manifestIndex));
			await settleBatch(
				batch.map(async (entry, batchIndex) => {
					const index = offset + batchIndex;
					if (states[index] === "new") return;
					const target = await resolveTransactionPath(entry.path);
					if (entry.newHash === null) {
						await rm(target, { force: true });
						await syncParentDirectory(target);
						return;
					}
					const staged = await resolveTransactionPath(`${directory}/staged/${index}.bin`);
					if ((await hashFile(staged)).value !== entry.newHash.value) {
						throw new Error(`Staged hash mismatch: ${entry.path}`);
					}
					if (entry.oldHash === null) {
						await rename(staged, target);
						await syncParentDirectory(target);
					} else await atomicWriteFile(target, await readFile(staged));
				}),
			);
		}
	});
	const manifestEntry = journal.entries[manifestIndex];
	if (manifestEntry === undefined) throw new Error(`Transaction manifest is missing: ${transactionId}`);
	await traceProjectTransactionPhase("manifest_commit", traceContext, async () => {
		if (states[manifestIndex] !== "new") {
			if (manifestEntry.newHash === null) {
				throw new Error(`Transaction manifest cannot be deleted: ${transactionId}`);
			}
			const target = await resolveTransactionPath(manifestEntry.path);
			const staged = await resolveTransactionPath(`${directory}/staged/${manifestIndex}.bin`);
			if ((await hashFile(staged)).value !== manifestEntry.newHash.value) {
				throw new Error(`Staged hash mismatch: ${manifestEntry.path}`);
			}
			await atomicWriteFile(target, await readFile(staged));
		}
	});
	await traceProjectTransactionPhase("post_commit_verify", traceContext, async () => {
		const finalStates = await Promise.all(
			journal.entries.map(async (entry) => fileState(await resolveTransactionPath(entry.path), entry, true)),
		);
		if (finalStates.some((state) => state !== "new")) {
			throw new Error(`Transaction commit verification failed: ${transactionId}`);
		}
	});
	await traceProjectTransactionPhase("journal_archive", traceContext, () =>
		moveTransaction(projectRoot, transactionId, COMMITTED_DIRECTORY),
	);
}

async function rollbackPreparedTransactionUnlocked(projectRoot: string, transactionId: string): Promise<void> {
	const journal = await readJournal(projectRoot, transactionId);
	const directory = transactionDirectory(PENDING_DIRECTORY, transactionId);
	const resolveTransactionPath = await transactionPathResolver(projectRoot);
	const states = await Promise.all(
		journal.entries.map(async (entry) => fileState(await resolveTransactionPath(entry.path), entry)),
	);
	if (states.includes("other")) throw new Error(`Transaction target hash mismatch: ${transactionId}`);
	if (states.at(-1) === "new") throw new Error(`Cannot roll back committed transaction: ${transactionId}`);

	for (let index = journal.entries.length - 2; index >= 0; index -= 1) {
		if (states[index] === "old") continue;
		const entry = journal.entries[index];
		if (entry === undefined) throw new Error(`Transaction entry missing: ${transactionId}`);
		const target = await resolveTransactionPath(entry.path);
		if (entry.oldHash === null) {
			await rm(target, { force: true });
			await syncParentDirectory(target);
		} else {
			const backup = await resolveTransactionPath(`${directory}/backups/${index}.bin`);
			if ((await hashFile(backup)).value !== entry.oldHash.value) {
				throw new Error(`Backup hash mismatch: ${entry.path}`);
			}
			await atomicWriteFile(target, await readFile(backup));
		}
	}
	const finalStates = await Promise.all(
		journal.entries.map(async (entry) => fileState(await resolveTransactionPath(entry.path), entry, true)),
	);
	if (finalStates.some((state) => state !== "old"))
		throw new Error(`Transaction rollback verification failed: ${transactionId}`);
	await moveTransaction(projectRoot, transactionId, FAILED_DIRECTORY);
}

export async function commitProjectTransaction(projectRoot: string, input: ProjectTransactionInput): Promise<string> {
	const traceContext = traceContextFromInput(input);
	return withProjectWriterLease(
		projectRoot,
		() => commitProjectTransactionWithWriterLeaseHeld(projectRoot, input, traceContext),
		traceContext,
	);
}

export async function commitProjectTransactionWithWriterLeaseHeld(
	projectRoot: string,
	input: ProjectTransactionInput,
	traceContext = traceContextFromInput(input),
): Promise<string> {
	// Internal transaction entry point: the caller must already hold the project writer lease.
	const transactionId = await prepareProjectTransactionUnlocked(projectRoot, input, traceContext);
	await commitPreparedTransactionUnlocked(projectRoot, transactionId);
	return transactionId;
}

export async function prepareProjectTransaction(projectRoot: string, input: ProjectTransactionInput): Promise<string> {
	const traceContext = traceContextFromInput(input);
	return withProjectWriterLease(
		projectRoot,
		() => prepareProjectTransactionUnlocked(projectRoot, input, traceContext),
		traceContext,
	);
}

export async function commitPreparedTransaction(projectRoot: string, transactionId: string): Promise<void> {
	return withProjectWriterLease(projectRoot, () => commitPreparedTransactionUnlocked(projectRoot, transactionId), {
		transactionId,
	});
}

export async function rollbackPreparedTransaction(projectRoot: string, transactionId: string): Promise<void> {
	return withProjectWriterLease(projectRoot, () => rollbackPreparedTransactionUnlocked(projectRoot, transactionId), {
		transactionId,
	});
}
