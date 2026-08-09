// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open as openFile, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MemoryDeletionTombstoneV1, MemoryDeletionVerificationV1 } from "@research-agent/contracts";
import { validateMemoryDeletionTombstoneV1, validateMemoryDeletionVerificationV1 } from "@research-agent/contracts";
import type {
	MemoryCandidateDraftV1,
	MemoryCategory,
	MemoryFeedbackV1,
	MemoryItemV1,
	MemoryPreferenceRefs,
	MemoryUseReceiptV1,
	PreferenceSignalV1,
	ResearcherProfileV1,
} from "@research-agent/contracts/memory";
import type { MemorySnapshotManifestV1 } from "@research-agent/contracts/memory-transfer";
import {
	type MemoryContractValidation,
	validateMemoryCandidateDraftV1,
	validateMemoryFeedbackV1,
	validateMemoryItemV1,
	validateMemorySnapshotManifestV1,
	validateMemoryUseReceiptV1,
	validatePreferenceSignalV1,
} from "@research-agent/contracts/memory-validators";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../contracts/integrity.ts";
import { resolveProjectPath, validatePortablePathSet } from "../kernel/paths.ts";
import { atomicWriteFile, syncParentDirectory } from "../project/atomic-write.ts";
import {
	canonicalMemoryProfileRoot,
	MEMORY_ACTIVE_ITEMS_CACHE_PATH,
	MEMORY_LAYOUT_DIRECTORIES,
	MEMORY_PROFILE_PATH,
	MEMORY_TRANSFER_LOCK_PATH,
	memoryMonthPath,
	resolveMemoryPath,
	validateMemoryIdentifier,
	validateMemoryLayout,
} from "./layout.ts";
import {
	assertCommittedMemoryRecords,
	listPendingMemoryTransactions,
	listPendingMemoryTransactionsAtRoot,
	readMemoryProfileFile,
	runMemoryTransaction,
	withMemoryWriterLease,
} from "./transactions.ts";

export type ImmutableMemoryRecord =
	| PreferenceSignalV1
	| MemoryCandidateDraftV1
	| MemoryUseReceiptV1
	| MemoryFeedbackV1
	| MemorySnapshotManifestV1;

type DeletionProtectedRecord = ImmutableMemoryRecord | MemoryItemV1;

export type MemoryItemDraft = Omit<MemoryItemV1, "transactionId">;

export interface MemoryStoreIssue {
	code: string;
	path: string;
	message: string;
}

interface ActiveItemRef {
	category: MemoryCategory;
	memoryId: string;
	revision: number;
	provenanceHash: string;
}

interface ActiveItemsCacheV1 {
	format: "doro-active-memory-items";
	version: 1;
	basedOnProfileRevision: number;
	currentItemRootHash: string;
	items: ActiveItemRef[];
}

export interface CanonicalMemoryState {
	signals: PreferenceSignalV1[];
	candidates: MemoryCandidateDraftV1[];
	items: MemoryItemV1[];
	activeItems: MemoryItemV1[];
	feedback: MemoryFeedbackV1[];
	receipts: MemoryUseReceiptV1[];
	tombstones: MemoryDeletionTombstoneV1[];
	audit: MemoryDeletionVerificationV1[];
	transferManifests: MemorySnapshotManifestV1[];
	counts: {
		signals: number;
		candidates: number;
		items: number;
		feedback: number;
		receipts: number;
		tombstones: number;
		audit: number;
		transferManifests: number;
	};
}

export type OpenedMemoryProfile =
	| {
			mode: "read-write";
			root: string;
			profile: ResearcherProfileV1;
			items: MemoryItemV1[];
			activeItems: MemoryItemV1[];
			tombstones: MemoryDeletionTombstoneV1[];
			cacheStatus: "valid" | "rebuilt" | "stale" | "unavailable";
			counts: CanonicalMemoryState["counts"];
	  }
	| {
			mode: "read-only";
			root: string;
			profile: ResearcherProfileV1 | null;
			activeItems: [];
			pendingTransactions: string[];
			issues: MemoryStoreIssue[];
	  };

export interface CreateMemoryProfileInput {
	profileId?: string;
	createdBy?: "user" | "migration";
}

export interface AppendMemoryOptions {
	expectedProfileRevision?: number;
}

const memoryCategories: readonly MemoryCategory[] = [
	"domain",
	"theory",
	"method",
	"evidence",
	"writing",
	"workflow",
	"tool",
	"output",
];

function issue(code: string, path: string, message: string): MemoryStoreIssue {
	return { code, path, message };
}

function errorMessage(error: unknown, profileRoot: string, canonicalRoot?: string): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const path of new Set([profileRoot, resolve(profileRoot), canonicalRoot])) {
		if (path !== undefined && path.length > 0) message = message.replaceAll(path, "<profile>");
	}
	return message;
}

function requireValid<T>(validation: MemoryContractValidation<T>, path: string): T {
	if (validation.ok) return validation.value;
	throw new TypeError(
		`Invalid ${path}: ${validation.issues.map(({ code, path: issuePath }) => `${issuePath}:${code}`).join(", ")}`,
	);
}

async function canonicalFiles(profileRoot: string, directory: string): Promise<string[]> {
	const files: string[] = [];
	const walk = async (relativeDirectory: string): Promise<void> => {
		const entries = await readdir(await resolveProjectPath(profileRoot, relativeDirectory), {
			withFileTypes: true,
			encoding: "utf8",
		});
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
			const relativePath = `${relativeDirectory}/${entry.name}`;
			if (entry.isSymbolicLink()) throw new TypeError(`Memory canonical path is a symbolic link: ${relativePath}`);
			if (entry.isDirectory()) {
				await walk(relativePath);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json")) {
				throw new TypeError(`Unexpected memory canonical entry: ${relativePath}`);
			}
			files.push(relativePath);
		}
	};
	await walk(directory);
	return validatePortablePathSet(files);
}

async function readCanonicalJson(profileRoot: string, path: string): Promise<unknown> {
	const text = await readFile(await resolveProjectPath(profileRoot, path), "utf8");
	const value = canonicalizeJson(JSON.parse(text));
	if (text !== `${canonicalStringify(value)}\n`) throw new TypeError(`Memory record is not canonical JSON: ${path}`);
	return value;
}

async function scanRecords<T extends { profileId: string }>(
	profileRoot: string,
	profileId: string,
	directory: string,
	validate: (value: unknown) => MemoryContractValidation<T>,
	identity: (value: T) => string,
	expectedPath: (value: T) => string,
): Promise<T[]> {
	const records: T[] = [];
	const identities = new Set<string>();
	for (const path of await canonicalFiles(profileRoot, directory)) {
		const record = requireValid(validate(await readCanonicalJson(profileRoot, path)), path);
		if (record.profileId !== profileId) throw new TypeError(`Memory record profile mismatch: ${path}`);
		if (expectedPath(record) !== path) throw new TypeError(`Memory record path mismatch: ${path}`);
		const id = identity(record);
		if (identities.has(id)) throw new TypeError(`Duplicate memory record identity: ${id}`);
		identities.add(id);
		records.push(record);
	}
	return records;
}

function activeRefs(items: readonly MemoryItemV1[]): ActiveItemRef[] {
	return items
		.map(({ category, memoryId, revision, provenanceHash }) => ({ category, memoryId, revision, provenanceHash }))
		.sort(
			(left, right) =>
				left.category.localeCompare(right.category) ||
				left.memoryId.localeCompare(right.memoryId) ||
				left.revision - right.revision,
		);
}

function latestMemoryItems(items: readonly MemoryItemV1[]): MemoryItemV1[] {
	const groups = new Map<string, MemoryItemV1[]>();
	for (const item of items) {
		const revisions = groups.get(item.memoryId) ?? [];
		revisions.push(item);
		groups.set(item.memoryId, revisions);
	}
	const latest: MemoryItemV1[] = [];
	for (const [memoryId, revisions] of groups) {
		revisions.sort((left, right) => left.revision - right.revision);
		for (const [index, item] of revisions.entries()) {
			if (item.revision !== index + 1 || item.previousRevision !== (index === 0 ? null : index)) {
				throw new TypeError(`Memory revision chain is not consecutive: ${memoryId}`);
			}
			if (item.category !== revisions[0]?.category) {
				throw new TypeError(`Memory category changes across revisions: ${memoryId}`);
			}
		}
		const current = revisions.at(-1);
		if (current !== undefined) latest.push(current);
	}
	return latest;
}

export function memoryItemRootHash(items: readonly MemoryItemV1[]): string {
	const active = latestMemoryItems(items)
		.filter(({ status }) => status === "active")
		.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
	return `sha256:${hashCanonicalJson(active).value}`;
}

function validateItemHistory(profile: ResearcherProfileV1, items: MemoryItemV1[]): MemoryItemV1[] {
	const latest = latestMemoryItems(items);
	const active = latest.filter(({ status }) => status === "active");
	if (memoryItemRootHash(items) !== profile.currentItemRootHash) {
		throw new TypeError("profile.json currentItemRootHash does not match active item revisions");
	}
	const expectedRefs = activeRefs(active).map(({ category, memoryId, revision }) => ({
		category,
		memoryId,
		revision,
	}));
	const actualRefs = memoryCategories
		.flatMap((category) => (profile.preferenceRefs[category] ?? []).map((ref) => ({ category, ...ref })))
		.sort(
			(left, right) =>
				left.category.localeCompare(right.category) ||
				left.memoryId.localeCompare(right.memoryId) ||
				left.revision - right.revision,
		);
	if (canonicalStringify(actualRefs) !== canonicalStringify(expectedRefs)) {
		throw new TypeError("profile.json preferenceRefs do not match active latest item revisions");
	}
	return active.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
}

function validateDeletionTombstoneFeedbackBindings(
	tombstones: readonly MemoryDeletionTombstoneV1[],
	signals: readonly PreferenceSignalV1[],
	candidates: readonly MemoryCandidateDraftV1[],
	items: readonly MemoryItemV1[],
	feedback: readonly MemoryFeedbackV1[],
	receipts: readonly MemoryUseReceiptV1[],
	transferManifests: readonly MemorySnapshotManifestV1[],
): void {
	const appliedDeletes = feedback.filter(
		(record) => record.action === "delete" && record.applicationStatus === "applied",
	);
	for (const tombstone of tombstones) {
		const targeted = feedback.filter((record) => record.target.memoryId === tombstone.memoryId);
		const record = targeted[0];
		if (targeted.length !== 1 || record === undefined || !deletionFeedbackMatchesTombstone(record, tombstone)) {
			throw new TypeError(`Memory deletion tombstone does not match applied feedback: ${tombstone.memoryId}`);
		}
	}
	for (const record of appliedDeletes) {
		const matchingTombstones = tombstones.filter((tombstone) => deletionFeedbackMatchesTombstone(record, tombstone));
		if (matchingTombstones.length !== 1) {
			throw new TypeError(`Applied deletion feedback does not match a tombstone: ${record.feedbackId}`);
		}
	}
	const records: Array<{ path: string; record: DeletionProtectedRecord }> = [
		...signals.map((record) => ({
			path: `signals/${memoryMonthPath(record.createdAt)}/${record.signalId}.json`,
			record,
		})),
		...candidates.map((record) => ({ path: `candidates/${record.candidateId}.json`, record })),
		...items.map((record) => ({
			path: `items/${record.category}/${record.memoryId}/${record.revision}.json`,
			record,
		})),
		...feedback.map((record) => ({
			path: `feedback/${memoryMonthPath(record.requestedAt)}/${record.feedbackId}.json`,
			record,
		})),
		...receipts.map((record) => ({
			path: `receipts/${memoryMonthPath(record.appliedAt)}/${record.receiptId}.json`,
			record,
		})),
		...transferManifests.map((record) => ({ path: `transfer-manifests/${record.snapshotId}.json`, record })),
	];
	for (const { path, record } of records) {
		if (deletionRecordConflicts(record, path, `${canonicalStringify(record)}\n`, tombstones)) {
			throw new TypeError(`Canonical record conflicts with deletion tombstone: ${path}`);
		}
	}
}

async function validateDeletionVerificationBindings(
	profileRoot: string,
	profile: ResearcherProfileV1,
	tombstones: readonly MemoryDeletionTombstoneV1[],
	audit: readonly MemoryDeletionVerificationV1[],
): Promise<void> {
	const tombstonesByMemoryId = new Map(tombstones.map((tombstone) => [tombstone.memoryId, tombstone]));
	for (const verification of audit) {
		const tombstone = tombstonesByMemoryId.get(verification.memoryId);
		const tombstoneHash =
			tombstone === undefined ? null : `sha256:${hashBytes(`${canonicalStringify(tombstone)}\n`).value}`;
		if (
			tombstone === undefined ||
			verification.deletionTransactionId !== tombstone.transactionId ||
			verification.tombstoneHash !== tombstoneHash ||
			Date.parse(verification.checkedAt) < Date.parse(tombstone.deletedAt) ||
			verification.verificationId !== `deletion_verification_${verification.transactionId}` ||
			verification.profileRevision >= profile.revision
		) {
			throw new TypeError(
				`Memory deletion verification does not match canonical tombstone: ${verification.verificationId}`,
			);
		}
		await assertCommittedMemoryRecords(profileRoot, {
			transactionId: verification.transactionId,
			profileId: verification.profileId,
			expectedRevision: verification.profileRevision,
			exactEntryCount: 1,
			records: [
				{
					path: `audit/${memoryMonthPath(verification.checkedAt)}/${verification.verificationId}.json`,
					content: `${canonicalStringify(verification)}\n`,
				},
			],
		});
	}
}

export async function loadCanonicalMemoryState(
	profileRoot: string,
	profile: ResearcherProfileV1,
): Promise<CanonicalMemoryState> {
	const [signals, candidates, items, feedback, receipts, tombstones, audit, transferManifests] = await Promise.all([
		scanRecords(
			profileRoot,
			profile.profileId,
			"signals",
			validatePreferenceSignalV1,
			(record) => record.signalId,
			(record) => `signals/${memoryMonthPath(record.createdAt)}/${record.signalId}.json`,
		),
		scanRecords(
			profileRoot,
			profile.profileId,
			"candidates",
			validateMemoryCandidateDraftV1,
			(record) => record.candidateId,
			(record) => `candidates/${record.candidateId}.json`,
		),
		scanRecords(
			profileRoot,
			profile.profileId,
			"items",
			validateMemoryItemV1,
			(record) => `${record.memoryId}:${record.revision}`,
			(record) => `items/${record.category}/${record.memoryId}/${record.revision}.json`,
		),
		scanRecords(
			profileRoot,
			profile.profileId,
			"feedback",
			validateMemoryFeedbackV1,
			(record) => record.feedbackId,
			(record) => `feedback/${memoryMonthPath(record.requestedAt)}/${record.feedbackId}.json`,
		),
		scanRecords(
			profileRoot,
			profile.profileId,
			"receipts",
			validateMemoryUseReceiptV1,
			(record) => record.receiptId,
			(record) => `receipts/${memoryMonthPath(record.appliedAt)}/${record.receiptId}.json`,
		),
		scanRecords(
			profileRoot,
			profile.profileId,
			"tombstones",
			validateMemoryDeletionTombstoneV1,
			(record) => record.memoryId,
			(record) => `tombstones/${record.memoryId}.json`,
		),
		scanRecords(
			profileRoot,
			profile.profileId,
			"audit",
			validateMemoryDeletionVerificationV1,
			(record) => record.verificationId,
			(record) => `audit/${memoryMonthPath(record.checkedAt)}/${record.verificationId}.json`,
		),
		scanRecords(
			profileRoot,
			profile.profileId,
			"transfer-manifests",
			validateMemorySnapshotManifestV1,
			(record) => record.snapshotId,
			(record) => `transfer-manifests/${record.snapshotId}.json`,
		),
	]);
	validateDeletionTombstoneFeedbackBindings(
		tombstones,
		signals,
		candidates,
		items,
		feedback,
		receipts,
		transferManifests,
	);
	await validateDeletionVerificationBindings(profileRoot, profile, tombstones, audit);
	return {
		signals,
		candidates,
		items,
		activeItems: validateItemHistory(profile, items),
		feedback,
		receipts,
		tombstones,
		audit,
		transferManifests,
		counts: {
			signals: signals.length,
			candidates: candidates.length,
			items: items.length,
			feedback: feedback.length,
			receipts: receipts.length,
			tombstones: tombstones.length,
			audit: audit.length,
			transferManifests: transferManifests.length,
		},
	};
}

function cacheDocument(profile: ResearcherProfileV1, activeItems: readonly MemoryItemV1[]): ActiveItemsCacheV1 {
	return {
		format: "doro-active-memory-items",
		version: 1,
		basedOnProfileRevision: profile.revision,
		currentItemRootHash: profile.currentItemRootHash,
		items: activeRefs(activeItems),
	};
}

async function cacheMatches(profileRoot: string, expected: ActiveItemsCacheV1): Promise<boolean> {
	const path = await resolveMemoryPath(profileRoot, MEMORY_ACTIVE_ITEMS_CACHE_PATH, { allowMissing: true });
	try {
		const text = await readFile(path, "utf8");
		const parsed = canonicalizeJson(JSON.parse(text));
		return text === `${canonicalStringify(parsed)}\n` && canonicalStringify(parsed) === canonicalStringify(expected);
	} catch {
		return false;
	}
}

async function writeActiveItemsCache(profileRoot: string, document: ActiveItemsCacheV1): Promise<void> {
	const path = await resolveMemoryPath(profileRoot, MEMORY_ACTIVE_ITEMS_CACHE_PATH, { allowMissing: true });
	await atomicWriteFile(path, `${canonicalStringify(document)}\n`);
}

async function writeNewFile(path: string, content: string): Promise<void> {
	const handle = await openFile(path, "wx", 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncParentDirectory(path);
}

export async function createMemoryProfile(
	profileRoot: string,
	input: CreateMemoryProfileInput = {},
): Promise<OpenedMemoryProfile> {
	await mkdir(profileRoot, { recursive: true, mode: 0o700 });
	await canonicalMemoryProfileRoot(profileRoot);
	const entries = (await readdir(profileRoot)).filter((entry) => !entry.startsWith("._") && entry !== ".DS_Store");
	const profileExists = entries.includes(MEMORY_PROFILE_PATH);
	if (!profileExists && entries.length > 0) {
		throw new Error("Cannot initialize a memory profile in a non-empty directory");
	}
	if (process.platform !== "win32") await chmod(profileRoot, 0o700);
	if (profileExists) {
		const opened = await openMemoryProfile(profileRoot);
		if (
			opened.mode !== "read-write" ||
			(input.profileId !== undefined && opened.profile.profileId !== input.profileId)
		) {
			throw new Error("Memory profile already exists with different or invalid initialization state");
		}
		return opened;
	}
	for (const directory of MEMORY_LAYOUT_DIRECTORIES) {
		await mkdir(await resolveProjectPath(profileRoot, directory), { recursive: true, mode: 0o700 });
	}
	const now = new Date().toISOString();
	const profile: ResearcherProfileV1 = {
		format: "doro-researcher-profile",
		schemaVersion: "1.0.0",
		profileId: validateMemoryIdentifier(input.profileId ?? `profile_${randomUUID()}`, "profileId"),
		revision: 0,
		status: "active",
		preferenceRefs: {},
		learningPolicy: {
			mode: "active",
			explicitAutoActivation: true,
			inferredLowRiskThreshold: 0.85,
			inferredResearchThreshold: 0.9,
			minimumIndependentSignals: 3,
			maxItemsPerTask: 8,
			maxContextTokens: 800,
			criticalDecisionMode: "never_auto",
		},
		sensitivityPolicy: {
			allowedDataClasses: ["public", "internal"],
			restrictedProjectLearning: "disabled",
			externalProviderMemoryView: "task_scoped_redacted",
			prohibitedAttributePolicyVersion: "memory-sensitive-v1",
		},
		retentionPolicy: {
			signalDays: 180,
			candidateDays: 30,
			receiptDays: 365,
			auditDays: 365,
			tombstoneDays: "indefinite",
		},
		budgetPolicy: {
			maxInferenceCallsPerSession: 1,
			maxInferenceCostUsdPerSession: 0.05,
			maxAdditionalTokensPerTask: 800,
		},
		currentItemRootHash: memoryItemRootHash([]),
		createdAt: now,
		updatedAt: now,
		createdBy: input.createdBy ?? "user",
		lastTransactionId: null,
	};
	await writeNewFile(await resolveProjectPath(profileRoot, MEMORY_PROFILE_PATH), `${canonicalStringify(profile)}\n`);
	await writeActiveItemsCache(profileRoot, cacheDocument(profile, []));
	return openMemoryProfile(profileRoot);
}

export async function openMemoryProfile(
	profileRoot: string,
	options: { rebuildCache?: boolean } = {},
): Promise<OpenedMemoryProfile> {
	let root = resolve(profileRoot);
	try {
		root = await canonicalMemoryProfileRoot(root);
	} catch {
		return {
			mode: "read-only",
			root,
			profile: null,
			activeItems: [],
			pendingTransactions: [],
			issues: [
				issue(
					"memory.unavailable",
					MEMORY_PROFILE_PATH,
					"Personal Memory is unavailable; personalization is disabled",
				),
			],
		};
	}
	let profile: ResearcherProfileV1 | null = null;
	let pendingTransactions: string[] = [];
	try {
		await validateMemoryLayout(root);
		const transferInProgress = async (): Promise<boolean> => {
			try {
				await lstat(await resolveMemoryPath(root, MEMORY_TRANSFER_LOCK_PATH, { allowMissing: true }));
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
		};
		if (await transferInProgress()) {
			return {
				mode: "read-only",
				root,
				profile: null,
				activeItems: [],
				pendingTransactions: [],
				issues: [
					issue(
						"memory.transfer_in_progress",
						MEMORY_TRANSFER_LOCK_PATH,
						"Personal Memory import is in progress; personalization is temporarily disabled",
					),
				],
			};
		}
		pendingTransactions = await listPendingMemoryTransactions(root);
		profile = await readMemoryProfileFile(root);
		if (pendingTransactions.length > 0) {
			return {
				mode: "read-only",
				root,
				profile,
				activeItems: [],
				pendingTransactions,
				issues: [
					issue(
						"memory.pending_transaction",
						"transactions/pending",
						"Memory profile requires transaction recovery before personalization",
					),
				],
			};
		}
		const state = await loadCanonicalMemoryState(root, profile);
		const cache = cacheDocument(profile, state.activeItems);
		let cacheStatus: "valid" | "rebuilt" | "stale" | "unavailable" = "unavailable";
		try {
			cacheStatus = (await cacheMatches(root, cache)) ? "valid" : "stale";
			if (cacheStatus === "stale" && (options.rebuildCache ?? true)) {
				await withMemoryWriterLease(root, async (lockedRoot) => {
					const [currentProfile, pending] = await Promise.all([
						readMemoryProfileFile(lockedRoot),
						listPendingMemoryTransactionsAtRoot(lockedRoot),
					]);
					if (pending.length > 0 || canonicalStringify(currentProfile) !== canonicalStringify(profile)) {
						throw new Error("DATA_CONFLICT: profile changed before active memory cache rebuild");
					}
					await writeActiveItemsCache(lockedRoot, cache);
				});
				cacheStatus = "rebuilt";
			}
		} catch {
			cacheStatus = "unavailable";
		}
		if (await transferInProgress()) {
			return {
				mode: "read-only",
				root,
				profile,
				activeItems: [],
				pendingTransactions: [],
				issues: [
					issue(
						"memory.transfer_in_progress",
						MEMORY_TRANSFER_LOCK_PATH,
						"Personal Memory import is in progress; personalization is temporarily disabled",
					),
				],
			};
		}
		return {
			mode: "read-write",
			root,
			profile,
			items: state.items,
			activeItems: profile.status === "active" ? state.activeItems : [],
			tombstones: state.tombstones,
			cacheStatus,
			counts: state.counts,
		};
	} catch (error) {
		return {
			mode: "read-only",
			root,
			profile,
			activeItems: [],
			pendingTransactions,
			issues: [issue("memory.canonical_invalid", MEMORY_PROFILE_PATH, errorMessage(error, profileRoot, root))],
		};
	}
}

export async function setMemoryProfileStatus(
	profileRoot: string,
	status: "active" | "paused",
): Promise<{ changed: boolean; transactionId: string | null; profile: ResearcherProfileV1 }> {
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
	if (opened.mode !== "read-write") {
		throw new Error(
			`MEMORY_PROFILE_READ_ONLY: ${opened.issues.map(({ code }) => code).join(",") || "memory.unavailable"}`,
		);
	}
	if (opened.profile.status === status && opened.profile.learningPolicy.mode === status) {
		return { changed: false, transactionId: null, profile: opened.profile };
	}
	const prepared = await runMemoryTransaction(profileRoot, opened.profile.revision, (profile, transactionId) => ({
		profile: {
			...profile,
			status,
			learningPolicy: { ...profile.learningPolicy, mode: status },
			updatedAt: new Date().toISOString(),
			revision: profile.revision + 1,
			lastTransactionId: transactionId,
		},
		writes: [],
		result: null,
	}));
	return { changed: true, transactionId: prepared.transactionId, profile: prepared.profile };
}

function validateImmutableRecord(record: ImmutableMemoryRecord): ImmutableMemoryRecord {
	switch (record.format) {
		case "doro-preference-signal":
			return requireValid(validatePreferenceSignalV1(record), "PreferenceSignalV1");
		case "doro-memory-candidate-draft":
			return requireValid(validateMemoryCandidateDraftV1(record), "MemoryCandidateDraftV1");
		case "doro-memory-use-receipt":
			return requireValid(validateMemoryUseReceiptV1(record), "MemoryUseReceiptV1");
		case "doro-memory-feedback":
			return requireValid(validateMemoryFeedbackV1(record), "MemoryFeedbackV1");
		case "doro-memory-snapshot":
			return requireValid(validateMemorySnapshotManifestV1(record), "MemorySnapshotManifestV1");
	}
}

function immutableRecordPath(record: ImmutableMemoryRecord): string {
	switch (record.format) {
		case "doro-preference-signal":
			return `signals/${memoryMonthPath(record.createdAt)}/${validateMemoryIdentifier(record.signalId, "signalId")}.json`;
		case "doro-memory-candidate-draft":
			return `candidates/${validateMemoryIdentifier(record.candidateId, "candidateId")}.json`;
		case "doro-memory-use-receipt":
			return `receipts/${memoryMonthPath(record.appliedAt)}/${validateMemoryIdentifier(record.receiptId, "receiptId")}.json`;
		case "doro-memory-feedback":
			return `feedback/${memoryMonthPath(record.requestedAt)}/${validateMemoryIdentifier(record.feedbackId, "feedbackId")}.json`;
		case "doro-memory-snapshot":
			return `transfer-manifests/${validateMemoryIdentifier(record.snapshotId, "snapshotId")}.json`;
	}
}

function deletionHash(value: string | Uint8Array): `sha256:${string}` {
	return `sha256:${hashBytes(value).value}`;
}

export function deletionFeedbackMatchesTombstone(
	record: MemoryFeedbackV1,
	tombstone: MemoryDeletionTombstoneV1,
): boolean {
	return (
		record.action === "delete" &&
		record.applicationStatus === "applied" &&
		record.target.memoryId === tombstone.memoryId &&
		record.target.revision + 1 === tombstone.terminalRevision &&
		record.resultingRevision === tombstone.terminalRevision &&
		record.transactionId === tombstone.transactionId &&
		record.correction === null &&
		record.exportExclusionVerifiedAt === null &&
		record.reasonCode === tombstone.reasonCode &&
		Date.parse(record.requestedAt) <= Date.parse(tombstone.deletedAt) &&
		record.deactivatedAt === tombstone.deletedAt &&
		record.cacheInvalidatedAt === tombstone.deletedAt
	);
}

export function deletionRecordConflicts(
	record: DeletionProtectedRecord,
	path: string,
	content: string,
	tombstones: readonly MemoryDeletionTombstoneV1[],
): boolean {
	let identifier: string;
	switch (record.format) {
		case "doro-preference-signal":
			identifier = `signal:${record.signalId}`;
			break;
		case "doro-memory-candidate-draft":
			identifier = `candidate:${record.candidateId}`;
			break;
		case "doro-memory-item":
			identifier = `memory:${record.memoryId}`;
			break;
		case "doro-memory-use-receipt":
			identifier = `receipt:${record.receiptId}`;
			break;
		case "doro-memory-feedback":
			identifier = `feedback:${record.feedbackId}`;
			break;
		case "doro-memory-snapshot":
			identifier = `snapshot:${record.snapshotId}`;
			break;
	}
	const pathHash = deletionHash(path);
	const contentHash = deletionHash(content);
	const identifierHash = deletionHash(identifier);
	const sourceSignalHashes =
		record.format === "doro-memory-candidate-draft" || record.format === "doro-memory-item"
			? record.sourceSignalRefs.map(({ signalId }) => deletionHash(`signal:${signalId}`))
			: [];
	const feedbackRefHashes =
		record.format === "doro-memory-use-receipt"
			? record.feedbackRefs.map((feedbackId) => deletionHash(`feedback:${feedbackId}`))
			: [];
	const supersededMemoryHashes =
		record.format === "doro-memory-item"
			? record.supersedes.map(({ memoryId }) => deletionHash(`memory:${memoryId}`))
			: [];
	const safeRefHashes =
		record.format === "doro-preference-signal"
			? record.sourceRefs.map(({ locator }) => deletionHash(locator))
			: record.format === "doro-memory-feedback"
				? [deletionHash(record.sourceRef.locator)]
				: record.format === "doro-memory-use-receipt"
					? [record.sessionRef, record.taskRef, record.operationRef, record.artifactRef]
							.filter((ref) => ref !== null)
							.map(({ locator }) => deletionHash(locator))
					: [];
	const snapshotPathHashes =
		record.format === "doro-memory-snapshot" ? record.files.map((file) => deletionHash(file.path)) : [];
	const snapshotRecordHashes =
		record.format === "doro-memory-snapshot" ? record.files.map(({ plaintextHash }) => plaintextHash) : [];
	return tombstones.some(
		(tombstone) =>
			tombstone.deletedPathHashes.includes(pathHash) ||
			tombstone.deletedRecordHashes.includes(contentHash) ||
			tombstone.relatedIdentifierHashes.includes(identifierHash) ||
			(record.format === "doro-memory-item" && record.memoryId === tombstone.memoryId) ||
			(record.format === "doro-memory-feedback" &&
				record.target.memoryId === tombstone.memoryId &&
				!deletionFeedbackMatchesTombstone(record, tombstone)) ||
			(record.format === "doro-memory-use-receipt" &&
				record.itemRefs.some(({ memoryId }) => memoryId === tombstone.memoryId)) ||
			(record.format === "doro-memory-item" &&
				record.supersedes.some(({ memoryId }) => memoryId === tombstone.memoryId)) ||
			sourceSignalHashes.some((hash) => tombstone.relatedIdentifierHashes.includes(hash)) ||
			feedbackRefHashes.some((hash) => tombstone.relatedIdentifierHashes.includes(hash)) ||
			supersededMemoryHashes.some((hash) => tombstone.relatedIdentifierHashes.includes(hash)) ||
			safeRefHashes.some((hash) => tombstone.relatedIdentifierHashes.includes(hash)) ||
			snapshotPathHashes.some((hash) => tombstone.deletedPathHashes.includes(hash)) ||
			snapshotRecordHashes.some((hash) => tombstone.deletedRecordHashes.includes(hash)),
	);
}

export async function appendMemoryRecord(
	profileRoot: string,
	recordInput: ImmutableMemoryRecord,
	options: AppendMemoryOptions = {},
): Promise<{ transactionId: string; profile: ResearcherProfileV1; record: ImmutableMemoryRecord }> {
	const record = validateImmutableRecord(recordInput);
	if (
		record.format === "doro-memory-feedback" &&
		record.action === "delete" &&
		record.applicationStatus === "applied"
	) {
		throw new Error("MEMORY_DELETE_ATOMIC_REQUIRED: applied delete feedback must use deletePersonalMemory");
	}
	const path = immutableRecordPath(record);
	const content = `${canonicalStringify(record)}\n`;
	const prepared = await runMemoryTransaction(
		profileRoot,
		options.expectedProfileRevision,
		async (profile, transactionId) => {
			if (record.profileId !== profile.profileId)
				throw new TypeError("Memory record profile ID does not match profile.json");
			if (
				profile.status !== "active" &&
				(record.format === "doro-preference-signal" || record.format === "doro-memory-candidate-draft")
			) {
				throw new Error("MEMORY_PROFILE_PAUSED: paused profiles do not capture signals or candidates");
			}
			if (
				record.format === "doro-preference-signal" &&
				!profile.sensitivityPolicy.allowedDataClasses.includes(record.dataClass)
			) {
				throw new Error(`MEMORY_DATA_CLASS_DENIED: ${record.dataClass}`);
			}
			const tombstones = await scanRecords(
				profileRoot,
				profile.profileId,
				"tombstones",
				validateMemoryDeletionTombstoneV1,
				(value) => value.memoryId,
				(value) => `tombstones/${value.memoryId}.json`,
			);
			if (deletionRecordConflicts(record, path, content, tombstones)) {
				throw new Error("MEMORY_DELETED_TERMINAL: deleted memory records cannot be reintroduced");
			}
			const nextProfile: ResearcherProfileV1 = {
				...profile,
				revision: profile.revision + 1,
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			};
			return {
				profile: nextProfile,
				writes: [{ path, content }],
				result: record,
			};
		},
	);
	return { transactionId: prepared.transactionId, profile: prepared.profile, record: prepared.result };
}

export function nextMemoryPreferenceRefs(profile: ResearcherProfileV1, item: MemoryItemV1): MemoryPreferenceRefs {
	return Object.fromEntries(
		memoryCategories.flatMap((category) => {
			const refs = (profile.preferenceRefs[category] ?? []).filter(({ memoryId }) => memoryId !== item.memoryId);
			if (item.status === "active" && category === item.category) {
				refs.push({ memoryId: item.memoryId, revision: item.revision });
			}
			return refs.length === 0
				? []
				: [[category, refs.sort((left, right) => left.memoryId.localeCompare(right.memoryId))] as const];
		}),
	) as MemoryPreferenceRefs;
}

export async function appendMemoryItem(
	profileRoot: string,
	itemInput: MemoryItemDraft,
	options: AppendMemoryOptions = {},
): Promise<{ transactionId: string; profile: ResearcherProfileV1; item: MemoryItemV1 }> {
	const prepared = await runMemoryTransaction(
		profileRoot,
		options.expectedProfileRevision,
		async (profile, transactionId) => {
			if (itemInput.profileId !== profile.profileId)
				throw new TypeError("Memory item profile ID does not match profile.json");
			if (!profile.sensitivityPolicy.allowedDataClasses.includes(itemInput.dataClass)) {
				throw new Error(`MEMORY_DATA_CLASS_DENIED: ${itemInput.dataClass}`);
			}
			if (itemInput.status === "active" && profile.status !== "active") {
				throw new Error("MEMORY_PROFILE_PAUSED: paused profiles cannot activate memory items");
			}
			// ponytail: scan canonical items here; add a validated item hash index only after profile-scale benchmarks require it.
			const state = await loadCanonicalMemoryState(profileRoot, profile);
			const revisions = state.items
				.filter(({ memoryId }) => memoryId === itemInput.memoryId)
				.sort((left, right) => left.revision - right.revision);
			const latest = revisions.at(-1);
			if (latest === undefined) {
				if (itemInput.revision !== 1 || itemInput.previousRevision !== null) {
					throw new Error("New memory item must start at revision 1");
				}
			} else {
				if (
					itemInput.category !== latest.category ||
					itemInput.revision !== latest.revision + 1 ||
					itemInput.previousRevision !== latest.revision ||
					!itemInput.supersedes.some(
						({ memoryId, revision }) => memoryId === latest.memoryId && revision === latest.revision,
					)
				) {
					throw new Error(
						"Memory item revision must preserve category and supersede the latest consecutive revision",
					);
				}
			}
			const item = requireValid(validateMemoryItemV1({ ...itemInput, transactionId }), "MemoryItemV1");
			const path = `items/${item.category}/${validateMemoryIdentifier(item.memoryId, "memoryId")}/${item.revision}.json`;
			const content = `${canonicalStringify(item)}\n`;
			if (deletionRecordConflicts(item, path, content, state.tombstones)) {
				throw new Error("MEMORY_DELETED_TERMINAL: deleted memory records cannot be reintroduced");
			}
			const items = [...state.items, item];
			const nextProfile: ResearcherProfileV1 = {
				...profile,
				revision: profile.revision + 1,
				preferenceRefs: nextMemoryPreferenceRefs(profile, item),
				currentItemRootHash: memoryItemRootHash(items),
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			};
			return {
				profile: nextProfile,
				writes: [{ path, content }],
				result: item,
			};
		},
	);
	return { transactionId: prepared.transactionId, profile: prepared.profile, item: prepared.result };
}

export async function validateMemoryProfile(profileRoot: string): Promise<{
	valid: boolean;
	mode: OpenedMemoryProfile["mode"];
	profileRevision: number | null;
	rootHash: string | null;
	cacheStatus: "valid" | "stale" | "unavailable" | null;
	issues: MemoryStoreIssue[];
}> {
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
	if (opened.mode === "read-only") {
		return {
			valid: false,
			mode: opened.mode,
			profileRevision: opened.profile?.revision ?? null,
			rootHash: opened.profile?.currentItemRootHash ?? null,
			cacheStatus: null,
			issues: opened.issues,
		};
	}
	return {
		valid: true,
		mode: opened.mode,
		profileRevision: opened.profile.revision,
		rootHash: opened.profile.currentItemRootHash,
		cacheStatus: opened.cacheStatus === "rebuilt" ? "valid" : opened.cacheStatus,
		issues: [],
	};
}

export async function doctorMemoryProfile(
	profileRoot: string,
	options: { repairCache?: boolean } = {},
): Promise<{
	status: "healthy" | "recovery_required";
	profileId: string | null;
	profileRevision: number | null;
	rootHash: string | null;
	cacheStatus: string | null;
	repairs: string[];
	issues: MemoryStoreIssue[];
}> {
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: options.repairCache ?? false });
	if (opened.mode === "read-only") {
		return {
			status: "recovery_required",
			profileId: opened.profile?.profileId ?? null,
			profileRevision: opened.profile?.revision ?? null,
			rootHash: opened.profile?.currentItemRootHash ?? null,
			cacheStatus: null,
			repairs: [],
			issues: opened.issues,
		};
	}
	return {
		status: "healthy",
		profileId: opened.profile.profileId,
		profileRevision: opened.profile.revision,
		rootHash: opened.profile.currentItemRootHash,
		cacheStatus: opened.cacheStatus,
		repairs: opened.cacheStatus === "rebuilt" ? [MEMORY_ACTIVE_ITEMS_CACHE_PATH] : [],
		issues: [],
	};
}
