// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResearcherProfileV1 } from "@research-agent/contracts/memory";
import { validateResearcherProfileV1 } from "@research-agent/contracts/memory-validators";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import { hashBytes } from "../contracts/integrity.ts";
import { hashFile } from "../kernel/integrity.ts";
import { validatePortablePathSet, validateProjectRelativePath } from "../kernel/paths.ts";
import { atomicWriteFile, syncParentDirectory } from "../project/atomic-write.ts";
import { withWriterLease } from "../project/writer-lock.ts";
import {
	MEMORY_PROFILE_PATH,
	MEMORY_WRITER_LOCK_PATH,
	resolveMemoryPath,
	validateMemoryIdentifier,
	validateMemoryLayout,
} from "./layout.ts";

export interface MemoryTransactionWrite {
	path: string;
	content: string;
}

export interface MemoryTransactionBuild<Result> {
	profile: ResearcherProfileV1;
	writes: readonly MemoryTransactionWrite[];
	result: Result;
}

export type MemoryTransactionBuilder<Result> = (
	profile: ResearcherProfileV1,
	transactionId: string,
) => MemoryTransactionBuild<Result> | Promise<MemoryTransactionBuild<Result>>;

interface MemoryTransactionEntry {
	path: string;
	newHash: string;
}

interface MemoryTransactionJournal {
	format: "doro-memory-transaction";
	version: 1;
	transactionId: string;
	profileId: string;
	expectedRevision: number;
	createdAt: string;
	profileOldHash: string;
	profileNewHash: string;
	entries: MemoryTransactionEntry[];
}

interface PreparedMemoryTransaction<Result> {
	transactionId: string;
	profile: ResearcherProfileV1;
	result: Result;
}

type FileState = "old" | "new" | "other";

const PENDING_DIRECTORY = "transactions/pending";
const COMMITTED_DIRECTORY = "transactions/committed";
const FAILED_DIRECTORY = "transactions/failed";
const transactionIdPattern = /^tx_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const canonicalRecordPrefixes = [
	"signals/",
	"candidates/",
	"items/",
	"feedback/",
	"receipts/",
	"transfer-manifests/",
] as const;

function transactionDirectory(statusDirectory: string, transactionId: string): string {
	if (!transactionIdPattern.test(transactionId))
		throw new TypeError(`Invalid memory transaction ID: ${transactionId}`);
	return `${statusDirectory}/${transactionId}`;
}

function validateRecordPath(path: string): string {
	const validated = validateProjectRelativePath(path);
	if (!validated.endsWith(".json") || !canonicalRecordPrefixes.some((prefix) => validated.startsWith(prefix))) {
		throw new TypeError(`Memory transaction target is not a canonical record path: ${path}`);
	}
	return validated;
}

async function transactionPathResolver(profileRoot: string): Promise<(path: string) => Promise<string>> {
	const canonicalRoot = await realpath(profileRoot);
	return (path) => resolveMemoryPath(canonicalRoot, validateProjectRelativePath(path), { allowMissing: true });
}

async function existingHash(path: string): Promise<string | null> {
	try {
		if ((await lstat(path)).isSymbolicLink())
			throw new TypeError(`Memory transaction target is a symbolic link: ${path}`);
		return (await hashFile(path)).value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function fileState(path: string, expectedHash: string): Promise<FileState> {
	const hash = await existingHash(path);
	if (hash === null) return "old";
	return hash === expectedHash ? "new" : "other";
}

function exactKeys(value: object, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateProfileInvariants(profile: ResearcherProfileV1): ResearcherProfileV1 {
	validateMemoryIdentifier(profile.profileId, "profileId");
	if ((profile.status === "active") !== (profile.learningPolicy.mode === "active")) {
		throw new TypeError("profile.json status and learningPolicy.mode must agree");
	}
	if (Date.parse(profile.updatedAt) < Date.parse(profile.createdAt)) {
		throw new TypeError("profile.json updatedAt must not precede createdAt");
	}
	if ((profile.revision === 0) !== (profile.lastTransactionId === null)) {
		throw new TypeError("profile.json revision and lastTransactionId must agree");
	}
	return profile;
}

export function parseMemoryProfile(text: string, label: string): ResearcherProfileV1 {
	const raw = canonicalizeJson(JSON.parse(text));
	if (text !== `${canonicalStringify(raw)}\n`) throw new TypeError(`${label} is not canonical JSON`);
	const validation = validateResearcherProfileV1(raw);
	if (!validation.ok) {
		throw new TypeError(
			`Invalid ${label}: ${validation.issues.map(({ code, path: issuePath }) => `${issuePath}:${code}`).join(", ")}`,
		);
	}
	return validateProfileInvariants(validation.value);
}

export async function readMemoryProfileFile(profileRoot: string): Promise<ResearcherProfileV1> {
	const path = await resolveMemoryPath(profileRoot, MEMORY_PROFILE_PATH);
	return parseMemoryProfile(await readFile(path, "utf8"), MEMORY_PROFILE_PATH);
}

export async function listPendingMemoryTransactionsAtRoot(profileRoot: string): Promise<string[]> {
	try {
		const entries = await readdir(await resolveMemoryPath(profileRoot, PENDING_DIRECTORY), {
			withFileTypes: true,
			encoding: "utf8",
		});
		const ids: string[] = [];
		for (const entry of entries) {
			if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
			if (!entry.isDirectory() || !transactionIdPattern.test(entry.name)) {
				throw new TypeError(`Invalid pending memory transaction entry: ${entry.name}`);
			}
			ids.push(entry.name);
		}
		return ids.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function listPendingMemoryTransactions(profileRoot: string): Promise<string[]> {
	return listPendingMemoryTransactionsAtRoot(await validateMemoryLayout(profileRoot));
}

async function readJournal(profileRoot: string, transactionId: string): Promise<MemoryTransactionJournal> {
	const directory = transactionDirectory(PENDING_DIRECTORY, transactionId);
	const text = await readFile(await resolveMemoryPath(profileRoot, `${directory}/transaction.json`), "utf8");
	const raw = canonicalizeJson(JSON.parse(text));
	if (text !== `${canonicalStringify(raw)}\n`)
		throw new TypeError(`Memory transaction journal is not canonical: ${transactionId}`);
	if (
		raw === null ||
		typeof raw !== "object" ||
		Array.isArray(raw) ||
		!exactKeys(raw, [
			"format",
			"version",
			"transactionId",
			"profileId",
			"expectedRevision",
			"createdAt",
			"profileOldHash",
			"profileNewHash",
			"entries",
		]) ||
		raw.format !== "doro-memory-transaction" ||
		raw.version !== 1 ||
		raw.transactionId !== transactionId ||
		typeof raw.profileId !== "string" ||
		typeof raw.expectedRevision !== "number" ||
		!Number.isInteger(raw.expectedRevision) ||
		raw.expectedRevision < 0 ||
		typeof raw.createdAt !== "string" ||
		!Number.isFinite(Date.parse(raw.createdAt)) ||
		typeof raw.profileOldHash !== "string" ||
		!sha256Pattern.test(raw.profileOldHash) ||
		typeof raw.profileNewHash !== "string" ||
		!sha256Pattern.test(raw.profileNewHash) ||
		!Array.isArray(raw.entries)
	) {
		throw new TypeError(`Invalid memory transaction journal: ${transactionId}`);
	}
	const entries: MemoryTransactionEntry[] = raw.entries.map((entry) => {
		if (
			entry === null ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			!exactKeys(entry, ["path", "newHash"]) ||
			typeof entry.path !== "string" ||
			typeof entry.newHash !== "string" ||
			!sha256Pattern.test(entry.newHash)
		) {
			throw new TypeError(`Invalid memory transaction journal entry: ${transactionId}`);
		}
		return { path: validateRecordPath(entry.path), newHash: entry.newHash };
	});
	validateMemoryIdentifier(raw.profileId, "profileId");
	validatePortablePathSet(entries.map(({ path }) => path));
	return {
		format: "doro-memory-transaction",
		version: 1,
		transactionId,
		profileId: raw.profileId,
		expectedRevision: raw.expectedRevision,
		createdAt: raw.createdAt,
		profileOldHash: raw.profileOldHash,
		profileNewHash: raw.profileNewHash,
		entries,
	};
}

async function moveTransaction(profileRoot: string, transactionId: string, destination: string): Promise<void> {
	const source = await resolveMemoryPath(profileRoot, transactionDirectory(PENDING_DIRECTORY, transactionId));
	const target = await resolveMemoryPath(profileRoot, transactionDirectory(destination, transactionId), {
		allowMissing: true,
	});
	await rename(source, target);
	await Promise.all([syncParentDirectory(source), syncParentDirectory(target)]);
}

async function prepareMemoryTransactionUnlocked<Result>(
	profileRoot: string,
	expectedRevision: number | undefined,
	builder: MemoryTransactionBuilder<Result>,
): Promise<PreparedMemoryTransaction<Result>> {
	if ((await listPendingMemoryTransactionsAtRoot(profileRoot)).length > 0) {
		throw new Error("MEMORY_RECOVERY_REQUIRED: recover the pending memory transaction before writing");
	}
	const current = await readMemoryProfileFile(profileRoot);
	if (current.status === "deleted") {
		throw new Error("MEMORY_PROFILE_DELETED: deleted profiles are terminal and cannot be modified");
	}
	if (expectedRevision !== undefined && current.revision !== expectedRevision) {
		throw new Error(`DATA_CONFLICT: expected profile revision ${expectedRevision}, found ${current.revision}`);
	}
	const baseRevision = current.revision;
	const transactionId = `tx_${randomUUID()}`;
	const built = await builder(current, transactionId);
	const validation = validateResearcherProfileV1(built.profile);
	if (!validation.ok) throw new TypeError("Memory transaction profile is invalid");
	validateProfileInvariants(validation.value);
	if (
		built.profile.profileId !== current.profileId ||
		built.profile.revision !== current.revision + 1 ||
		built.profile.lastTransactionId !== transactionId ||
		built.profile.createdAt !== current.createdAt ||
		built.profile.createdBy !== current.createdBy ||
		Date.parse(built.profile.updatedAt) < Date.parse(current.updatedAt)
	) {
		throw new Error(
			"Memory transaction must preserve profile identity, increment revision once, advance time, and bind its transaction ID",
		);
	}
	const paths = built.writes.map(({ path }) => validateRecordPath(path));
	validatePortablePathSet(paths);
	if (new Set(paths).size !== paths.length) throw new TypeError("Memory transaction contains a duplicate target");
	for (const write of built.writes) {
		const parsed = canonicalizeJson(JSON.parse(write.content));
		if (write.content !== `${canonicalStringify(parsed)}\n`) {
			throw new TypeError(`Memory transaction write is not canonical JSON: ${write.path}`);
		}
	}
	const resolveTransactionPath = await transactionPathResolver(profileRoot);
	for (const path of paths) {
		if ((await existingHash(await resolveTransactionPath(path))) !== null) {
			throw new Error(`DATA_CONFLICT: immutable memory target already exists: ${path}`);
		}
	}

	const directory = transactionDirectory(PENDING_DIRECTORY, transactionId);
	try {
		await mkdir(await resolveMemoryPath(profileRoot, directory, { allowMissing: true }));
		await mkdir(await resolveMemoryPath(profileRoot, `${directory}/staged`, { allowMissing: true }));
		const entries: MemoryTransactionEntry[] = [];
		for (const [index, write] of built.writes.entries()) {
			await atomicWriteFile(
				await resolveMemoryPath(profileRoot, `${directory}/staged/${index}.bin`, { allowMissing: true }),
				write.content,
			);
			entries.push({ path: paths[index] as string, newHash: hashBytes(write.content).value });
		}
		const profileContent = `${canonicalStringify(built.profile)}\n`;
		await atomicWriteFile(
			await resolveMemoryPath(profileRoot, `${directory}/staged/profile.bin`, { allowMissing: true }),
			profileContent,
		);
		const journal: MemoryTransactionJournal = {
			format: "doro-memory-transaction",
			version: 1,
			transactionId,
			profileId: current.profileId,
			expectedRevision: baseRevision,
			createdAt: new Date().toISOString(),
			profileOldHash: (await hashFile(await resolveMemoryPath(profileRoot, MEMORY_PROFILE_PATH))).value,
			profileNewHash: hashBytes(profileContent).value,
			entries,
		};
		await atomicWriteFile(
			await resolveMemoryPath(profileRoot, `${directory}/transaction.json`, { allowMissing: true }),
			`${canonicalStringify(journal)}\n`,
		);
	} catch (error) {
		await rm(await resolveMemoryPath(profileRoot, directory, { allowMissing: true }), {
			recursive: true,
			force: true,
		});
		throw error;
	}
	return { transactionId, profile: built.profile, result: built.result };
}

async function commitPreparedMemoryTransactionUnlocked(profileRoot: string, transactionId: string): Promise<void> {
	const journal = await readJournal(profileRoot, transactionId);
	const directory = transactionDirectory(PENDING_DIRECTORY, transactionId);
	const resolveTransactionPath = await transactionPathResolver(profileRoot);
	const profilePath = await resolveMemoryPath(profileRoot, MEMORY_PROFILE_PATH);
	const stagedProfile = await resolveMemoryPath(profileRoot, `${directory}/staged/profile.bin`);
	const stagedProfileContent = await readFile(stagedProfile, "utf8");
	if (hashBytes(stagedProfileContent).value !== journal.profileNewHash) {
		throw new Error(`Staged profile hash mismatch: ${transactionId}`);
	}
	const nextProfile = parseMemoryProfile(stagedProfileContent, `staged profile for ${transactionId}`);
	if (
		nextProfile.profileId !== journal.profileId ||
		nextProfile.revision !== journal.expectedRevision + 1 ||
		nextProfile.lastTransactionId !== transactionId
	) {
		throw new Error(`Staged profile does not match memory transaction journal: ${transactionId}`);
	}
	const currentProfileHash = await existingHash(profilePath);
	const profileState: FileState =
		currentProfileHash === journal.profileOldHash
			? "old"
			: currentProfileHash === journal.profileNewHash
				? "new"
				: "other";
	const states = await Promise.all(
		journal.entries.map(async (entry) => fileState(await resolveTransactionPath(entry.path), entry.newHash)),
	);
	if (profileState === "other" || states.includes("other")) {
		throw new Error(`Memory transaction target hash mismatch: ${transactionId}`);
	}
	const currentProfile = await readMemoryProfileFile(profileRoot);
	if (
		currentProfile.profileId !== journal.profileId ||
		currentProfile.revision !== journal.expectedRevision + (profileState === "new" ? 1 : 0) ||
		(profileState === "old" &&
			(currentProfile.createdAt !== nextProfile.createdAt ||
				currentProfile.createdBy !== nextProfile.createdBy ||
				Date.parse(nextProfile.updatedAt) < Date.parse(currentProfile.updatedAt)))
	) {
		throw new Error(`Current profile does not match memory transaction journal: ${transactionId}`);
	}
	if (profileState === "new") {
		if (states.some((state) => state !== "new")) {
			throw new Error(`Committed memory transaction has mixed state: ${transactionId}`);
		}
		await moveTransaction(profileRoot, transactionId, COMMITTED_DIRECTORY);
		return;
	}
	for (const [index, entry] of journal.entries.entries()) {
		if (states[index] === "new") continue;
		const staged = await resolveMemoryPath(profileRoot, `${directory}/staged/${index}.bin`);
		if ((await hashFile(staged)).value !== entry.newHash) throw new Error(`Staged hash mismatch: ${entry.path}`);
		const target = await resolveTransactionPath(entry.path);
		await mkdir(dirname(target), { recursive: true });
		await rename(staged, target);
		await syncParentDirectory(target);
	}
	await atomicWriteFile(profilePath, stagedProfileContent);
	const finalStates = await Promise.all(
		journal.entries.map(async (entry) => fileState(await resolveTransactionPath(entry.path), entry.newHash)),
	);
	if ((await existingHash(profilePath)) !== journal.profileNewHash || finalStates.some((state) => state !== "new")) {
		throw new Error(`Memory transaction commit verification failed: ${transactionId}`);
	}
	await moveTransaction(profileRoot, transactionId, COMMITTED_DIRECTORY);
}

async function rollbackPreparedMemoryTransactionUnlocked(profileRoot: string, transactionId: string): Promise<void> {
	const journal = await readJournal(profileRoot, transactionId);
	const resolveTransactionPath = await transactionPathResolver(profileRoot);
	const profileHash = await existingHash(await resolveMemoryPath(profileRoot, MEMORY_PROFILE_PATH));
	if (profileHash === journal.profileNewHash)
		throw new Error(`Cannot roll back committed memory transaction: ${transactionId}`);
	if (profileHash !== journal.profileOldHash)
		throw new Error(`Memory transaction profile hash mismatch: ${transactionId}`);
	const currentProfile = await readMemoryProfileFile(profileRoot);
	if (currentProfile.profileId !== journal.profileId || currentProfile.revision !== journal.expectedRevision) {
		throw new Error(`Current profile does not match memory transaction journal: ${transactionId}`);
	}
	for (const entry of journal.entries) {
		const target = await resolveTransactionPath(entry.path);
		const state = await fileState(target, entry.newHash);
		if (state === "other") throw new Error(`Memory transaction target hash mismatch: ${transactionId}`);
		if (state === "new") {
			await rm(target);
			await syncParentDirectory(target);
		}
	}
	await moveTransaction(profileRoot, transactionId, FAILED_DIRECTORY);
}

async function withMemoryWriterLease<Value>(
	profileRoot: string,
	action: (canonicalRoot: string) => Promise<Value>,
): Promise<Value> {
	const root = await validateMemoryLayout(profileRoot);
	await resolveMemoryPath(root, MEMORY_WRITER_LOCK_PATH, { allowMissing: true });
	return withWriterLease(root, MEMORY_WRITER_LOCK_PATH, "MEMORY", () => action(root));
}

export async function prepareMemoryTransaction<Result>(
	profileRoot: string,
	expectedRevision: number | undefined,
	builder: MemoryTransactionBuilder<Result>,
): Promise<PreparedMemoryTransaction<Result>> {
	return withMemoryWriterLease(profileRoot, (root) =>
		prepareMemoryTransactionUnlocked(root, expectedRevision, builder),
	);
}

export async function runMemoryTransaction<Result>(
	profileRoot: string,
	expectedRevision: number | undefined,
	builder: MemoryTransactionBuilder<Result>,
): Promise<PreparedMemoryTransaction<Result>> {
	return withMemoryWriterLease(profileRoot, async (root) => {
		const prepared = await prepareMemoryTransactionUnlocked(root, expectedRevision, builder);
		await commitPreparedMemoryTransactionUnlocked(root, prepared.transactionId);
		return prepared;
	});
}

export async function commitPreparedMemoryTransaction(profileRoot: string, transactionId: string): Promise<void> {
	return withMemoryWriterLease(profileRoot, (root) => commitPreparedMemoryTransactionUnlocked(root, transactionId));
}

export async function rollbackPreparedMemoryTransaction(profileRoot: string, transactionId: string): Promise<void> {
	return withMemoryWriterLease(profileRoot, (root) => rollbackPreparedMemoryTransactionUnlocked(root, transactionId));
}
