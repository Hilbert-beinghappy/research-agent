// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile } from "node:fs/promises";
import type {
	MemoryDeletionResidueCode,
	MemoryDeletionTombstoneV1,
	MemoryDeletionVerificationV1,
} from "@research-agent/contracts";
import {
	MEMORY_DELETION_CHECKED_CLASSES,
	MEMORY_DELETION_PHYSICAL_LIMITATION,
	validateMemoryDeletionTombstoneV1,
	validateMemoryDeletionVerificationV1,
} from "@research-agent/contracts";
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
import {
	deletionFeedbackMatchesTombstone,
	deletionRecordConflicts,
	loadCanonicalMemoryState,
	memoryItemRootHash,
	openMemoryProfile,
} from "./store.ts";
import { assertCommittedMemoryRecords, runMemoryTransaction } from "./transactions.ts";
import { dryRunMemoryTransferSnapshot } from "./transfer.ts";

export interface DeletePersonalMemoryRequest {
	feedbackId: string;
	target: { memoryId: string; revision: number };
	sourceRef: SafeRef;
	requestedAt: string;
	reasonCode: MemoryDeletionTombstoneV1["reasonCode"];
}

export interface DeletePersonalMemoryOptions {
	expectedProfileRevision?: number;
	/** Deterministic fault injection for post-commit verification regressions. */
	faultAfterDeletionCommit?: "verification" | "attestation";
}

export interface MemoryDeletionVerification {
	status: "verified" | "failed";
	verificationId: null;
	transactionId: null;
	profileId: string | null;
	memoryId: string;
	deletionTransactionId: string | null;
	checkedAt: string;
	profileRevision: number | null;
	checkedClasses: readonly (typeof MEMORY_DELETION_CHECKED_CLASSES)[number][];
	tombstoneHash: string | null;
	profileRootHash: string | null;
	residueCodes: MemoryDeletionResidueCode[];
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

export async function verifyMemoryDeletion(
	profileRoot: string,
	memoryIdInput: string,
): Promise<MemoryDeletionVerification> {
	const memoryId = validateMemoryIdentifier(memoryIdInput, "memoryId");
	const checkedAt = new Date().toISOString();
	const residueCodes = new Set<MemoryDeletionResidueCode>();
	const checkedClasses = new Set<(typeof MEMORY_DELETION_CHECKED_CLASSES)[number]>();
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
	if (opened.mode !== "read-write") {
		return {
			status: "failed",
			verificationId: null,
			transactionId: null,
			profileId: opened.profile?.profileId ?? null,
			memoryId,
			deletionTransactionId: null,
			checkedAt,
			profileRevision: opened.profile?.revision ?? null,
			checkedClasses: ["profile"],
			tombstoneHash: null,
			profileRootHash: opened.profile?.currentItemRootHash ?? null,
			residueCodes: ["canonical_state_unavailable"],
			physicalDeletionLimitation: MEMORY_DELETION_PHYSICAL_LIMITATION,
		};
	}
	checkedClasses.add("profile");
	checkedClasses.add("pending_transactions");
	const tombstone = opened.tombstones.find((record) => record.memoryId === memoryId) ?? null;
	if (tombstone === null) residueCodes.add("tombstone_missing");
	const state = await loadCanonicalMemoryState(opened.root, opened.profile);
	for (const checkedClass of [
		"items",
		"signals",
		"candidates",
		"feedback",
		"receipts",
		"audit",
		"transfer_manifests",
	] as const) {
		checkedClasses.add(checkedClass);
	}
	if (state.items.some((item) => item.memoryId === memoryId)) residueCodes.add("item_residue");
	if (
		Object.values(opened.profile.preferenceRefs).some((refs) => (refs ?? []).some((ref) => ref.memoryId === memoryId))
	) {
		residueCodes.add("profile_ref_residue");
	}
	const targetFeedback = state.feedback.filter((feedback) => feedback.target.memoryId === memoryId);
	const appliedDelete = targetFeedback[0];
	const deletionBindingInvalid =
		tombstone === null ||
		targetFeedback.length !== 1 ||
		appliedDelete === undefined ||
		!deletionFeedbackMatchesTombstone(appliedDelete, tombstone);
	if (deletionBindingInvalid) {
		residueCodes.add("feedback_residue");
	} else {
		try {
			await assertCommittedMemoryRecords(opened.root, {
				transactionId: tombstone.transactionId,
				profileId: opened.profile.profileId,
				records: [
					{ path: `tombstones/${tombstone.memoryId}.json`, content: recordText(tombstone) },
					{ path: feedbackPath(appliedDelete), content: recordText(appliedDelete) },
				],
			});
			checkedClasses.add("deletion_transaction");
		} catch {
			residueCodes.add("deletion_binding_mismatch");
		}
	}
	if (state.receipts.some((receipt) => receipt.itemRefs.some((ref) => ref.memoryId === memoryId))) {
		residueCodes.add("receipt_residue");
	}
	const exportPreview = dryRunMemoryTransferSnapshot(opened.profile, state, checkedAt);
	checkedClasses.add("plaintext_export_dry_run");
	checkedClasses.add("encrypted_export_manifest_dry_run");
	if (tombstone !== null) {
		const previewPathHashes = new Set<string>(exportPreview.files.map(({ path }) => sha256(path)));
		const previewRecordHashes = new Set<string>(exportPreview.files.map(({ plaintextHash }) => plaintextHash));
		if (tombstone.deletedPathHashes.some((hash) => previewPathHashes.has(hash))) {
			residueCodes.add("export_path_residue");
		}
		if (tombstone.deletedRecordHashes.some((hash) => previewRecordHashes.has(hash))) {
			residueCodes.add("canonical_record_residue");
		}
	}
	let retrievalContextChecked = true;
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
		const statusAndCodeAgree =
			(retrieval.status === "applied" && retrieval.code === "ok") ||
			(retrieval.status === "empty" &&
				(retrieval.code === "no_eligible_items" ||
					retrieval.code === "budget_exhausted" ||
					retrieval.code === "profile_paused"));
		if (!statusAndCodeAgree) {
			residueCodes.add("verification_unavailable");
			retrievalContextChecked = false;
		}
		if (
			retrieval.profileId !== opened.profile.profileId ||
			retrieval.profileRevision !== opened.profile.revision ||
			retrieval.profileRootHash !== opened.profile.currentItemRootHash
		) {
			residueCodes.add("deletion_binding_mismatch");
			retrievalContextChecked = false;
		}
		if (retrieval.items.some((item) => item.memoryId === memoryId) || retrieval.context.includes(memoryId)) {
			residueCodes.add("retrieval_residue");
			retrievalContextChecked = false;
		}
	}
	if (retrievalContextChecked) checkedClasses.add("retrieval_context");
	let activeIndexChecked = true;
	let retrievalIndexChecked = true;
	for (const [path, indexClass] of [
		[MEMORY_ACTIVE_ITEMS_CACHE_PATH, "active_index"],
		[MEMORY_RETRIEVAL_INDEX_PATH, "retrieval_index"],
		[MEMORY_RETRIEVAL_INDEX_HASH_PATH, "retrieval_index"],
	] as const) {
		try {
			if ((await readFile(await resolveMemoryPath(profileRoot, path), "utf8")).includes(memoryId)) {
				residueCodes.add("cache_residue");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				residueCodes.add("cache_unreadable");
				if (indexClass === "active_index") activeIndexChecked = false;
				else retrievalIndexChecked = false;
			}
		}
	}
	if (activeIndexChecked) checkedClasses.add("active_index");
	if (retrievalIndexChecked) checkedClasses.add("retrieval_index");
	const residues = [...residueCodes].sort();
	return {
		status: residues.length === 0 ? "verified" : "failed",
		verificationId: null,
		transactionId: null,
		profileId: opened.profile.profileId,
		memoryId,
		deletionTransactionId: tombstone?.transactionId ?? null,
		checkedAt,
		profileRevision: opened.profile.revision,
		checkedClasses: MEMORY_DELETION_CHECKED_CLASSES.filter((checkedClass) => checkedClasses.has(checkedClass)),
		tombstoneHash: tombstone === null ? null : sha256(recordText(tombstone)),
		profileRootHash: opened.profile.currentItemRootHash,
		residueCodes: residues,
		physicalDeletionLimitation: MEMORY_DELETION_PHYSICAL_LIMITATION,
	};
}

interface DeletionVerificationBinding {
	profileId: string;
	memoryId: string;
	deletionTransactionId: string;
	profileRevision: number;
	tombstoneHash: `sha256:${string}`;
	profileRootHash: string;
}

async function currentDeletionVerificationBinding(
	profileRoot: string,
	memoryId: string,
): Promise<DeletionVerificationBinding | null> {
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
	if (opened.mode !== "read-write") return null;
	const tombstone = opened.tombstones.find((record) => record.memoryId === memoryId);
	if (tombstone === undefined) return null;
	return {
		profileId: opened.profile.profileId,
		memoryId,
		deletionTransactionId: tombstone.transactionId,
		profileRevision: opened.profile.revision,
		tombstoneHash: sha256(recordText(tombstone)),
		profileRootHash: opened.profile.currentItemRootHash,
	};
}

function unavailableVerification(binding: DeletionVerificationBinding): MemoryDeletionVerification {
	return {
		status: "failed",
		verificationId: null,
		transactionId: null,
		profileId: binding.profileId,
		memoryId: binding.memoryId,
		deletionTransactionId: binding.deletionTransactionId,
		checkedAt: new Date().toISOString(),
		profileRevision: binding.profileRevision,
		checkedClasses: [],
		tombstoneHash: binding.tombstoneHash,
		profileRootHash: binding.profileRootHash,
		residueCodes: ["verification_unavailable"],
		physicalDeletionLimitation: MEMORY_DELETION_PHYSICAL_LIMITATION,
	};
}

function bindPostCommitVerification(
	verification: MemoryDeletionVerification,
	binding: DeletionVerificationBinding,
): MemoryDeletionVerification {
	const residueCodes = new Set(verification.residueCodes);
	if (
		verification.profileId !== binding.profileId ||
		verification.memoryId !== binding.memoryId ||
		verification.deletionTransactionId !== binding.deletionTransactionId ||
		verification.profileRevision !== binding.profileRevision ||
		verification.tombstoneHash !== binding.tombstoneHash ||
		verification.profileRootHash !== binding.profileRootHash
	) {
		residueCodes.add("deletion_binding_mismatch");
	}
	const residues = [...residueCodes].sort();
	return {
		...verification,
		status: residues.length === 0 ? "verified" : "failed",
		profileId: binding.profileId,
		memoryId: binding.memoryId,
		deletionTransactionId: binding.deletionTransactionId,
		profileRevision: binding.profileRevision,
		tombstoneHash: binding.tombstoneHash,
		profileRootHash: binding.profileRootHash,
		residueCodes: residues,
	};
}

function deletionVerificationAttestation(
	verification: MemoryDeletionVerification,
	transactionId: string,
): MemoryDeletionVerificationV1 | null {
	if (
		verification.profileId === null ||
		verification.deletionTransactionId === null ||
		verification.profileRevision === null ||
		verification.tombstoneHash === null ||
		verification.profileRootHash === null
	) {
		return null;
	}
	return requireValid(
		validateMemoryDeletionVerificationV1({
			format: "doro-memory-deletion-verification",
			schemaVersion: "1.0.0",
			verificationId: `deletion_verification_${transactionId}`,
			profileId: verification.profileId,
			memoryId: verification.memoryId,
			deletionTransactionId: verification.deletionTransactionId,
			transactionId,
			checkedAt: verification.checkedAt,
			profileRevision: verification.profileRevision,
			status: verification.status,
			checkedClasses: [...verification.checkedClasses],
			tombstoneHash: verification.tombstoneHash,
			profileRootHash: verification.profileRootHash,
			residueCodes: verification.residueCodes,
			physicalDeletionLimitation: MEMORY_DELETION_PHYSICAL_LIMITATION,
		}),
		"MemoryDeletionVerificationV1",
	);
}

async function persistDeletionVerification(
	profileRoot: string,
	verification: MemoryDeletionVerification,
): Promise<{ transactionId: string; verification: MemoryDeletionVerificationV1 } | null> {
	if (verification.profileRevision === null || verification.profileId === null) return null;
	const persisted = await runMemoryTransaction(profileRoot, verification.profileRevision, (profile, transactionId) => {
		if (profile.profileId !== verification.profileId) {
			throw new TypeError("Memory deletion verification profile ID does not match profile.json");
		}
		const attestation = deletionVerificationAttestation(verification, transactionId);
		if (attestation === null) throw new TypeError("Incomplete MemoryDeletionVerificationV1 binding");
		return {
			profile: {
				...profile,
				revision: profile.revision + 1,
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			},
			writes: [
				{
					path: `audit/${memoryMonthPath(attestation.checkedAt)}/${attestation.verificationId}.json`,
					content: recordText(attestation),
				},
			],
			result: attestation,
		};
	});
	return { transactionId: persisted.transactionId, verification: persisted.result };
}

export async function verifyAndRecordMemoryDeletion(
	profileRoot: string,
	memoryId: string,
	options: { faultDuringVerification?: boolean } = {},
): Promise<{
	attestationRecorded: boolean;
	verificationTransactionId: string | null;
	verification: MemoryDeletionVerification | MemoryDeletionVerificationV1;
	errorCode: "MEMORY_DELETE_COMMITTED_UNVERIFIED" | "MEMORY_DELETE_VERIFICATION_FAILED" | null;
}> {
	const validatedMemoryId = validateMemoryIdentifier(memoryId, "memoryId");
	const binding = await currentDeletionVerificationBinding(profileRoot, validatedMemoryId);
	if (binding === null) {
		const checked = await verifyMemoryDeletion(profileRoot, validatedMemoryId);
		return {
			attestationRecorded: false,
			verificationTransactionId: null,
			verification: checked,
			errorCode: "MEMORY_DELETE_VERIFICATION_FAILED",
		};
	}
	let checked: MemoryDeletionVerification;
	try {
		if (options.faultDuringVerification === true) throw new Error("injected verification failure");
		checked = bindPostCommitVerification(await verifyMemoryDeletion(profileRoot, validatedMemoryId), binding);
	} catch {
		checked = unavailableVerification(binding);
	}
	try {
		const persisted = await persistDeletionVerification(profileRoot, checked);
		if (persisted === null) throw new TypeError("Incomplete MemoryDeletionVerificationV1 binding");
		return {
			attestationRecorded: true,
			verificationTransactionId: persisted.transactionId,
			verification: persisted.verification,
			errorCode: persisted.verification.status === "failed" ? "MEMORY_DELETE_VERIFICATION_FAILED" : null,
		};
	} catch {
		return {
			attestationRecorded: false,
			verificationTransactionId: null,
			verification: checked,
			errorCode: "MEMORY_DELETE_COMMITTED_UNVERIFIED",
		};
	}
}

export async function deletePersonalMemory(
	profileRoot: string,
	request: DeletePersonalMemoryRequest,
	options: DeletePersonalMemoryOptions = {},
): Promise<{
	committed: true;
	transactionId: string;
	verificationTransactionId: string | null;
	attestationRecorded: boolean;
	tombstone: MemoryDeletionTombstoneV1;
	feedback: MemoryFeedbackV1;
	verification: MemoryDeletionVerification | MemoryDeletionVerificationV1;
	errorCode: "MEMORY_DELETE_COMMITTED_UNVERIFIED" | "MEMORY_DELETE_VERIFICATION_FAILED" | null;
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
					exportExclusionVerifiedAt: null,
					transactionId,
					errorCode: null,
				}),
				"MemoryFeedbackV1",
			);
			const deletionFeedbackPath = `feedback/${memoryMonthPath(request.requestedAt)}/${request.feedbackId}.json`;
			const deletionFeedbackContent = recordText(deletionFeedback);
			if (
				deletionRecordConflicts(deletionFeedback, deletionFeedbackPath, deletionFeedbackContent, [
					...state.tombstones,
					tombstone,
				])
			) {
				throw new Error("MEMORY_DELETED_TERMINAL: deletion feedback references deleted records");
			}
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
						path: deletionFeedbackPath,
						content: deletionFeedbackContent,
					},
				],
				result: { tombstone, feedback: deletionFeedback },
			};
		},
	);
	const binding: DeletionVerificationBinding = {
		profileId: prepared.profile.profileId,
		memoryId: prepared.result.tombstone.memoryId,
		deletionTransactionId: prepared.transactionId,
		profileRevision: prepared.profile.revision,
		tombstoneHash: sha256(recordText(prepared.result.tombstone)),
		profileRootHash: prepared.profile.currentItemRootHash,
	};
	let checked: MemoryDeletionVerification;
	try {
		await clearPersonalMemoryRetrievalCache(profileRoot);
		if (options.faultAfterDeletionCommit === "verification") throw new Error("injected verification failure");
		checked = bindPostCommitVerification(await verifyMemoryDeletion(profileRoot, request.target.memoryId), binding);
	} catch {
		checked = unavailableVerification(binding);
	}
	try {
		if (options.faultAfterDeletionCommit === "attestation") throw new Error("injected attestation failure");
		const persisted = await persistDeletionVerification(profileRoot, checked);
		if (persisted === null) throw new TypeError("Incomplete MemoryDeletionVerificationV1 binding");
		return {
			committed: true,
			transactionId: prepared.transactionId,
			verificationTransactionId: persisted.transactionId,
			attestationRecorded: true,
			...prepared.result,
			verification: persisted.verification,
			errorCode: persisted.verification.status === "failed" ? "MEMORY_DELETE_VERIFICATION_FAILED" : null,
		};
	} catch {
		return {
			committed: true,
			transactionId: prepared.transactionId,
			verificationTransactionId: null,
			attestationRecorded: false,
			...prepared.result,
			verification: checked,
			errorCode: "MEMORY_DELETE_COMMITTED_UNVERIFIED",
		};
	}
}
