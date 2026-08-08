// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile } from "node:fs/promises";
import type { MemoryDeletionTombstoneV1 } from "@research-agent/contracts";
import { validateMemoryDeletionTombstoneV1 } from "@research-agent/contracts";
import type {
	MemoryCandidateDraftV1,
	MemoryCategory,
	MemoryFeedbackV1,
	MemoryItemV1,
	MemoryPreferenceRefs,
	MemoryUseReceiptV1,
	PreferenceSignalV1,
	SafeRef,
} from "@research-agent/contracts/memory";
import type { MemorySnapshotManifestV1 } from "@research-agent/contracts/memory-transfer";
import { validateMemoryFeedbackV1 } from "@research-agent/contracts/memory-validators";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../contracts/integrity.ts";
import {
	MEMORY_ACTIVE_ITEMS_CACHE_PATH,
	MEMORY_RETRIEVAL_INDEX_HASH_PATH,
	MEMORY_RETRIEVAL_INDEX_PATH,
	memoryMonthPath,
	resolveMemoryPath,
	validateMemoryIdentifier,
} from "./layout.ts";
import { clearPersonalMemoryRetrievalCache, retrievePersonalMemory } from "./retrieval.ts";
import { type CanonicalMemoryState, loadCanonicalMemoryState, memoryItemRootHash, openMemoryProfile } from "./store.ts";
import { runMemoryTransaction } from "./transactions.ts";

export interface DeletePersonalMemoryRequest {
	feedbackId: string;
	target: { memoryId: string; revision: number };
	sourceRef: SafeRef;
	requestedAt: string;
	reasonCode: MemoryDeletionTombstoneV1["reasonCode"];
}

export interface DeletePersonalMemoryOptions {
	expectedProfileRevision?: number;
}

export interface MemoryDeletionVerification {
	status: "verified" | "failed";
	memoryId: string;
	checkedClasses: readonly string[];
	tombstoneHash: string | null;
	profileRootHash: string | null;
	residueCodes: string[];
	physicalDeletionLimitation: string;
}

type DeletableRecord =
	| PreferenceSignalV1
	| MemoryCandidateDraftV1
	| MemoryItemV1
	| MemoryFeedbackV1
	| MemoryUseReceiptV1
	| MemorySnapshotManifestV1;

interface DeletionTarget {
	path: string;
	kind: string;
	id: string;
	record: DeletableRecord;
}

const categories: readonly MemoryCategory[] = [
	"domain",
	"theory",
	"method",
	"evidence",
	"writing",
	"workflow",
	"tool",
	"output",
];
const cachePaths = [
	MEMORY_ACTIVE_ITEMS_CACHE_PATH,
	MEMORY_RETRIEVAL_INDEX_PATH,
	MEMORY_RETRIEVAL_INDEX_HASH_PATH,
] as const;
const checkedClasses = [
	"profile",
	"items",
	"signals",
	"candidates",
	"feedback",
	"receipts",
	"audit",
	"transfer_manifests",
	"active_index",
	"retrieval_index",
	"retrieval_context",
	"plaintext_export_dry_run",
	"encrypted_export_manifest_dry_run",
	"pending_transactions",
] as const;
const physicalDeletionLimitation =
	"Verified deletion covers Doro normative state, ordinary files, indexes, context, and exports; external backups, filesystem snapshots, and storage-media remanence are outside the application guarantee.";

function sha256(value: string): `sha256:${string}` {
	return `sha256:${hashBytes(value).value}`;
}

function sortedHashes(values: Iterable<string>): `sha256:${string}`[] {
	return [...new Set([...values].map(sha256))].sort() as `sha256:${string}`[];
}

function recordText(value: unknown): string {
	return `${canonicalStringify(value)}\n`;
}

function semanticKey(category: MemoryCategory, key: string, value: unknown): string {
	return canonicalStringify({ category, key, value });
}

function itemPath(item: MemoryItemV1): string {
	return `items/${item.category}/${item.memoryId}/${item.revision}.json`;
}

function feedbackPath(feedback: MemoryFeedbackV1): string {
	return `feedback/${memoryMonthPath(feedback.requestedAt)}/${feedback.feedbackId}.json`;
}

function removePreferenceRefs(refs: MemoryPreferenceRefs, memoryId: string): MemoryPreferenceRefs {
	return Object.fromEntries(
		categories.flatMap((category) => {
			const remaining = (refs[category] ?? []).filter((ref) => ref.memoryId !== memoryId);
			return remaining.length === 0 ? [] : [[category, remaining] as const];
		}),
	) as MemoryPreferenceRefs;
}

function requireValid<T>(
	validation: { ok: true; value: T } | { ok: false; issues: readonly unknown[] },
	label: string,
): T {
	if (validation.ok) return validation.value;
	throw new TypeError(`Invalid ${label}`);
}

async function existingCachePaths(profileRoot: string): Promise<string[]> {
	const existing: string[] = [];
	for (const path of cachePaths) {
		try {
			await lstat(await resolveMemoryPath(profileRoot, path));
			existing.push(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return existing;
}

function exportablePaths(state: CanonicalMemoryState): string[] {
	return [
		...state.signals.map((record) => `signals/${memoryMonthPath(record.createdAt)}/${record.signalId}.json`),
		...state.candidates.map((record) => `candidates/${record.candidateId}.json`),
		...state.items.map(itemPath),
		...state.feedback.map(feedbackPath),
		...state.receipts.map((record) => `receipts/${memoryMonthPath(record.appliedAt)}/${record.receiptId}.json`),
		...state.transferManifests.map((record) => `transfer-manifests/${record.snapshotId}.json`),
	].sort();
}

function canonicalRecordHashes(state: CanonicalMemoryState): Set<string> {
	return new Set(
		[
			...state.signals,
			...state.candidates,
			...state.items,
			...state.feedback,
			...state.receipts,
			...state.transferManifests,
		].map((record) => sha256(recordText(record))),
	);
}

function identifierHashes(state: CanonicalMemoryState): Set<string> {
	return new Set([
		...state.items.map(({ memoryId }) => sha256(`memory:${memoryId}`)),
		...state.signals.map(({ signalId }) => sha256(`signal:${signalId}`)),
		...state.candidates.map(({ candidateId }) => sha256(`candidate:${candidateId}`)),
		...state.feedback.map(({ feedbackId }) => sha256(`feedback:${feedbackId}`)),
		...state.receipts.map(({ receiptId }) => sha256(`receipt:${receiptId}`)),
		...state.transferManifests.map(({ snapshotId }) => sha256(`snapshot:${snapshotId}`)),
	]);
}

export async function verifyMemoryDeletion(
	profileRoot: string,
	memoryIdInput: string,
): Promise<MemoryDeletionVerification> {
	const memoryId = validateMemoryIdentifier(memoryIdInput, "memoryId");
	const residueCodes = new Set<string>();
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
	if (opened.mode !== "read-write") {
		return {
			status: "failed",
			memoryId,
			checkedClasses,
			tombstoneHash: null,
			profileRootHash: opened.profile?.currentItemRootHash ?? null,
			residueCodes: ["canonical_state_unavailable"],
			physicalDeletionLimitation,
		};
	}
	const tombstone = opened.tombstones.find((record) => record.memoryId === memoryId) ?? null;
	if (tombstone === null) residueCodes.add("tombstone_missing");
	const state = await loadCanonicalMemoryState(opened.root, opened.profile);
	if (state.items.some((item) => item.memoryId === memoryId)) residueCodes.add("item_residue");
	if (
		Object.values(opened.profile.preferenceRefs).some((refs) => (refs ?? []).some((ref) => ref.memoryId === memoryId))
	) {
		residueCodes.add("profile_ref_residue");
	}
	if (
		state.feedback.some(
			(feedback) =>
				feedback.target.memoryId === memoryId &&
				(tombstone === null ||
					feedback.action !== "delete" ||
					feedback.transactionId !== tombstone.transactionId ||
					feedback.correction !== null),
		)
	) {
		residueCodes.add("feedback_residue");
	}
	if (state.receipts.some((receipt) => receipt.itemRefs.some((ref) => ref.memoryId === memoryId))) {
		residueCodes.add("receipt_residue");
	}
	if (tombstone !== null) {
		const relatedHashes = identifierHashes(state);
		if (tombstone.relatedIdentifierHashes.some((hash) => relatedHashes.has(hash))) {
			residueCodes.add("related_identifier_residue");
		}
		const recordHashes = canonicalRecordHashes(state);
		if (tombstone.deletedRecordHashes.some((hash) => recordHashes.has(hash))) {
			residueCodes.add("canonical_record_residue");
		}
		const exportHashes = new Set<string>(exportablePaths(state).map(sha256));
		if (tombstone.deletedPathHashes.some((hash) => exportHashes.has(hash))) {
			residueCodes.add("export_path_residue");
		}
		if (
			state.transferManifests.some((manifest) =>
				manifest.files.some(
					(file) =>
						tombstone.deletedPathHashes.includes(sha256(file.path)) ||
						tombstone.deletedRecordHashes.includes(file.plaintextHash),
				),
			)
		) {
			residueCodes.add("transfer_manifest_residue");
		}
	}
	for (const effect of [
		"routing",
		"ranking",
		"prompt_context",
		"formatting",
		"tool_order",
		"recommendation",
	] as const) {
		const retrieval = await retrievePersonalMemory(profileRoot, {
			taskCategories: categories,
			keywords: [],
			effect,
			allowedDataClasses: ["public", "internal", "restricted"],
			criticalDecision: false,
			availableContextTokens: 20_000,
			requestedMaxTokens: 800,
			now: new Date().toISOString(),
		});
		if (retrieval.items.some((item) => item.memoryId === memoryId)) residueCodes.add("retrieval_residue");
	}
	for (const path of cachePaths) {
		try {
			if ((await readFile(await resolveMemoryPath(profileRoot, path), "utf8")).includes(memoryId)) {
				residueCodes.add("cache_residue");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") residueCodes.add("cache_unreadable");
		}
	}
	const residues = [...residueCodes].sort();
	return {
		status: residues.length === 0 ? "verified" : "failed",
		memoryId,
		checkedClasses,
		tombstoneHash: tombstone === null ? null : sha256(recordText(tombstone)),
		profileRootHash: opened.profile.currentItemRootHash,
		residueCodes: residues,
		physicalDeletionLimitation,
	};
}

export async function deletePersonalMemory(
	profileRoot: string,
	request: DeletePersonalMemoryRequest,
	options: DeletePersonalMemoryOptions = {},
): Promise<{
	transactionId: string;
	tombstone: MemoryDeletionTombstoneV1;
	feedback: MemoryFeedbackV1;
	verification: MemoryDeletionVerification;
}> {
	validateMemoryIdentifier(request.feedbackId, "feedbackId");
	validateMemoryIdentifier(request.target.memoryId, "memoryId");
	const prepared = await runMemoryTransaction(
		profileRoot,
		options.expectedProfileRevision,
		async (profile, transactionId) => {
			const deletedAt = new Date().toISOString();
			if (Date.parse(request.requestedAt) > Date.parse(deletedAt)) {
				throw new TypeError("Memory deletion requestedAt cannot be in the future");
			}
			const state = await loadCanonicalMemoryState(profileRoot, profile);
			if (state.tombstones.some(({ memoryId }) => memoryId === request.target.memoryId)) {
				throw new Error("MEMORY_DELETED_TERMINAL: memory is already deleted");
			}
			if (state.feedback.some(({ feedbackId }) => feedbackId === request.feedbackId)) {
				throw new Error("DATA_CONFLICT: memory deletion feedback ID already exists");
			}
			const targetItems = state.items
				.filter(({ memoryId }) => memoryId === request.target.memoryId)
				.sort((left, right) => left.revision - right.revision);
			const latest = targetItems.at(-1);
			if (latest === undefined || latest.revision !== request.target.revision) {
				throw new Error("DATA_CONFLICT: deletion must target the exact latest memory revision");
			}
			const semanticKeys = new Set(
				targetItems
					.filter((item) => item.value !== null)
					.map((item) => semanticKey(item.category, item.key, item.value)),
			);
			const sourceSignalIds = new Set(
				targetItems.flatMap((item) => item.sourceSignalRefs.map(({ signalId }) => signalId)),
			);
			const signals = state.signals.filter(
				(signal) =>
					sourceSignalIds.has(signal.signalId) ||
					semanticKeys.has(semanticKey(signal.category, signal.normalizedKey, signal.normalizedValue)),
			);
			const signalIds = new Set(signals.map(({ signalId }) => signalId));
			if (
				state.items.some(
					(item) =>
						item.memoryId !== request.target.memoryId &&
						item.sourceSignalRefs.some(({ signalId }) => signalIds.has(signalId)),
				)
			) {
				throw new Error("MEMORY_DELETE_SHARED_PROVENANCE: a related signal supports another memory item");
			}
			const candidates = state.candidates.filter(
				(candidate) =>
					candidate.sourceSignalRefs.some(({ signalId }) => signalIds.has(signalId)) ||
					semanticKeys.has(semanticKey(candidate.category, candidate.key, candidate.value)),
			);
			const feedback = state.feedback.filter(
				(record) =>
					record.target.memoryId === request.target.memoryId ||
					(record.correction !== null &&
						semanticKeys.has(semanticKey(latest.category, record.correction.key, record.correction.value))),
			);
			const feedbackIds = new Set(feedback.map(({ feedbackId }) => feedbackId));
			const receipts = state.receipts.filter(
				(receipt) =>
					receipt.itemRefs.some(({ memoryId }) => memoryId === request.target.memoryId) ||
					receipt.feedbackRefs.some((feedbackId) => feedbackIds.has(feedbackId)),
			);
			const records: DeletionTarget[] = [
				...signals.map((record) => ({
					path: `signals/${memoryMonthPath(record.createdAt)}/${record.signalId}.json`,
					kind: "signal",
					id: record.signalId,
					record,
				})),
				...candidates.map((record) => ({
					path: `candidates/${record.candidateId}.json`,
					kind: "candidate",
					id: record.candidateId,
					record,
				})),
				...targetItems.map((record) => ({
					path: itemPath(record),
					kind: "memory",
					id: record.memoryId,
					record,
				})),
				...feedback.map((record) => ({
					path: feedbackPath(record),
					kind: "feedback",
					id: record.feedbackId,
					record,
				})),
				...receipts.map((record) => ({
					path: `receipts/${memoryMonthPath(record.appliedAt)}/${record.receiptId}.json`,
					kind: "receipt",
					id: record.receiptId,
					record,
				})),
			];
			const recordPaths = new Set(records.map(({ path }) => path));
			const recordHashes = new Set(records.map(({ record }) => sha256(recordText(record))));
			const transferManifests = state.transferManifests.filter((manifest) =>
				manifest.files.some(
					(file) => recordPaths.has(file.path) || recordHashes.has(file.plaintextHash as `sha256:${string}`),
				),
			);
			for (const record of transferManifests) {
				records.push({
					path: `transfer-manifests/${record.snapshotId}.json`,
					kind: "snapshot",
					id: record.snapshotId,
					record,
				});
			}
			const deletionPaths = records.map(({ path }) => path).sort();
			const derivedCaches = await existingCachePaths(profileRoot);
			const tombstone = requireValid(
				validateMemoryDeletionTombstoneV1({
					format: "doro-memory-deletion-tombstone",
					schemaVersion: "1.0.0",
					profileId: profile.profileId,
					memoryId: request.target.memoryId,
					terminalRevision: latest.revision + 1,
					lineageHash: `sha256:${
						hashCanonicalJson(
							targetItems.map(({ revision, provenanceHash, transactionId: itemTransactionId }) => ({
								revision,
								provenanceHash,
								transactionId: itemTransactionId,
							})),
						).value
					}`,
					deletedRecordHashes: [...new Set(records.map(({ record }) => sha256(recordText(record))))].sort(),
					relatedIdentifierHashes: sortedHashes([
						`memory:${request.target.memoryId}`,
						...records.map(({ kind, id }) => `${kind}:${id}`),
					]),
					deletedPathHashes: sortedHashes([...deletionPaths, ...derivedCaches]),
					deletedAt,
					reasonCode: request.reasonCode,
					transactionId,
				}),
				"MemoryDeletionTombstoneV1",
			);
			const deletionFeedback = requireValid(
				validateMemoryFeedbackV1({
					format: "doro-memory-feedback",
					schemaVersion: "1.0.0",
					feedbackId: request.feedbackId,
					profileId: profile.profileId,
					target: request.target,
					action: "delete",
					correction: null,
					actor: "user",
					sourceRef: request.sourceRef,
					reasonCode: request.reasonCode,
					requestedAt: request.requestedAt,
					applicationStatus: "applied",
					resultingRevision: latest.revision + 1,
					deactivatedAt: deletedAt,
					cacheInvalidatedAt: deletedAt,
					exportExclusionVerifiedAt: deletedAt,
					transactionId,
					errorCode: null,
				}),
				"MemoryFeedbackV1",
			);
			const remainingItems = state.items.filter(({ memoryId }) => memoryId !== request.target.memoryId);
			const nextProfile = {
				...profile,
				revision: profile.revision + 1,
				preferenceRefs: removePreferenceRefs(profile.preferenceRefs, request.target.memoryId),
				currentItemRootHash: memoryItemRootHash(remainingItems),
				updatedAt: deletedAt,
				lastTransactionId: transactionId,
			};
			return {
				profile: nextProfile,
				writes: [
					...deletionPaths.map((path) => ({ path, delete: true as const })),
					...derivedCaches.map((path) => ({ path, delete: true as const })),
					{
						path: `tombstones/${request.target.memoryId}.json`,
						content: recordText(tombstone),
					},
					{
						path: `feedback/${memoryMonthPath(request.requestedAt)}/${request.feedbackId}.json`,
						content: recordText(deletionFeedback),
					},
				],
				result: { tombstone, feedback: deletionFeedback },
			};
		},
	);
	await clearPersonalMemoryRetrievalCache(profileRoot);
	const verification = await verifyMemoryDeletion(profileRoot, request.target.memoryId);
	if (verification.status !== "verified") {
		throw new Error(`MEMORY_DELETE_VERIFICATION_FAILED: ${verification.residueCodes.join(",")}`);
	}
	return { transactionId: prepared.transactionId, ...prepared.result, verification };
}
