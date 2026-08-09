// SPDX-License-Identifier: Apache-2.0

import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_DELETION_CHECKED_CLASSES } from "@research-agent/contracts";
import type {
	MemoryCandidateDraftV1,
	MemoryFeedbackV1,
	MemoryUseReceiptV1,
	PreferenceSignalV1,
} from "@research-agent/contracts/memory";
import type { MemorySnapshotManifestV1 } from "@research-agent/contracts/memory-transfer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../../../src/contracts/canonical-json.ts";
import { hashBytes } from "../../../../src/contracts/integrity.ts";
import {
	deletePersonalMemory,
	verifyAndRecordMemoryDeletion,
	verifyMemoryDeletion,
} from "../../../../src/memory/deletion.ts";
import { applyMemoryFeedback } from "../../../../src/memory/feedback.ts";
import {
	MEMORY_RETRIEVAL_INDEX_HASH_PATH,
	MEMORY_RETRIEVAL_INDEX_PATH,
	memoryMonthPath,
} from "../../../../src/memory/layout.ts";
import { retrievePersonalMemoryForUse } from "../../../../src/memory/receipts.ts";
import { retrievePersonalMemory } from "../../../../src/memory/retrieval.ts";
import {
	appendMemoryItem,
	appendMemoryRecord,
	createMemoryProfile,
	loadCanonicalMemoryState,
	openMemoryProfile,
} from "../../../../src/memory/store.ts";
import {
	commitPreparedMemoryTransaction,
	listPendingMemoryTransactions,
	prepareMemoryTransaction,
	rollbackPreparedMemoryTransaction,
} from "../../../../src/memory/transactions.ts";
import { hash, itemDraft, retrievalQuery } from "./retrieval-fixtures.ts";

let temporaryDirectory: string;
let profileRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-delete-residue-"));
	profileRoot = join(temporaryDirectory, "profile");
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function signal(profileId: string, signalId: string, value: string): PreferenceSignalV1 {
	return {
		format: "doro-preference-signal",
		schemaVersion: "1.0.0",
		signalId,
		profileId,
		signalType: "explicit_statement",
		actor: "user",
		observedAt: "2026-08-08T10:00:00.000Z",
		category: "writing",
		normalizedKey: "language",
		normalizedValue: value,
		scopeCandidate: { level: "global" },
		baseWeight: 1,
		dedupeKey: hash({ signalId }),
		dataClass: "public",
		sourceRefs: [{ kind: "session", locator: "session:delete-test", dataClass: "public" }],
		sourceContentHash: hash({ value }),
		captureMethod: { type: "deterministic", ruleVersion: "delete-test-v1" },
		trustState: "accepted",
		rejectionCode: null,
		createdAt: "2026-08-08T10:00:00.000Z",
	};
}

function candidate(profileId: string, candidateId: string, signalId: string, value: string): MemoryCandidateDraftV1 {
	return {
		format: "doro-memory-candidate-draft",
		schemaVersion: "1.0.0",
		candidateId,
		profileId,
		category: "writing",
		key: "language",
		value,
		proposedScope: { level: "global" },
		sourceSignalRefs: [{ signalId, contentHash: hash({ signalId }) }],
		proposedEffects: ["formatting"],
		rationaleCodes: ["explicit-user-preference"],
		generatedBy: { type: "rule", version: "delete-test-v1", outputSchemaHash: hash("candidate") },
		createdAt: "2026-08-08T10:00:01.000Z",
	};
}

async function seedDeletableItem(memoryId: string): Promise<void> {
	const created = await createMemoryProfile(profileRoot, { profileId: "profile-1" });
	if (created.mode !== "read-write") throw new Error("expected writable profile");
	await appendMemoryItem(
		profileRoot,
		itemDraft(created.profile.profileId, memoryId, {
			category: "writing",
			key: "language",
			value: "en-US",
			allowedEffects: ["formatting"],
		}),
		{ expectedProfileRevision: 0 },
	);
}

async function allFileText(root: string): Promise<string> {
	const texts: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) texts.push(await readFile(path, "utf8"));
		}
	};
	await walk(root);
	return texts.join("\n");
}

describe("Personal Memory semantic deletion", () => {
	it("removes semantic residue from every normative, cache, context, and export path", async () => {
		const semantic = "zz-Private";
		const memoryId = "memory-delete-language";
		const signalId = `signal-${memoryId}`;
		const created = await createMemoryProfile(profileRoot, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		await appendMemoryRecord(profileRoot, signal(created.profile.profileId, signalId, semantic), {
			expectedProfileRevision: 0,
		});
		await appendMemoryRecord(
			profileRoot,
			candidate(created.profile.profileId, "candidate-delete-language", signalId, semantic),
			{ expectedProfileRevision: 1 },
		);
		await appendMemoryItem(
			profileRoot,
			itemDraft(created.profile.profileId, memoryId, {
				category: "writing",
				key: "language",
				value: semantic,
				allowedEffects: ["formatting"],
			}),
			{ expectedProfileRevision: 2 },
		);
		const used = await retrievePersonalMemoryForUse(profileRoot, retrievalQuery(), {
			receiptId: "receipt-delete-language",
			sessionRef: { kind: "session", locator: "session:delete-use", dataClass: "public" },
			taskRef: { kind: "task", locator: "task:delete-use", dataClass: "public" },
			decisionCodeBefore: "default-language",
			decisionCodeAfter: "preferred-language",
			explanationCodes: ["explicit-preference"],
			criticalResearchDecisionTouched: false,
			approvalRequired: false,
			appliedAt: "2026-08-08T10:00:02.000Z",
		});
		expect(used.retrieval.context).toContain(semantic);
		const reinforced = await applyMemoryFeedback(
			profileRoot,
			{
				feedbackId: "feedback-before-delete",
				target: { memoryId, revision: 1 },
				action: "reinforce",
				correction: null,
				sourceRef: { kind: "receipt", locator: "receipt:receipt-delete-language", dataClass: "public" },
				reasonCode: "user-confirmed",
				requestedAt: "2026-08-08T10:00:03.000Z",
			},
			{ expectedProfileRevision: 4 },
		);
		const itemPath = `items/writing/${memoryId}/2.json`;
		const itemText = await readFile(join(profileRoot, ...itemPath.split("/")), "utf8");
		const manifest: MemorySnapshotManifestV1 = {
			format: "doro-memory-snapshot",
			schemaVersion: "1.0.0",
			snapshotId: "snapshot-before-delete",
			profileId: created.profile.profileId,
			profileRevision: 5,
			createdAt: "2026-08-08T10:00:04.000Z",
			includedClasses: ["items"],
			excluded: [
				"session_content",
				"project_content",
				"restricted_sources",
				"credentials",
				"keys",
				"cache",
				"pending_transactions",
			],
			files: [
				{
					path: itemPath,
					size: Buffer.byteLength(itemText),
					plaintextHash: `sha256:${hashBytes(itemText).value}`,
					dataClass: "public",
				},
			],
			rootHash: hash({ itemPath }),
			sourceLineage: { profileId: created.profile.profileId, baseRevision: 0 },
		};
		await appendMemoryRecord(profileRoot, manifest, { expectedProfileRevision: 5 });
		await writeFile(join(profileRoot, ...MEMORY_RETRIEVAL_INDEX_PATH.split("/")), `{"stale":"${semantic}"}\n`);
		expect(await readFile(join(profileRoot, ...MEMORY_RETRIEVAL_INDEX_HASH_PATH.split("/")), "utf8")).toMatch(
			/^sha256:/u,
		);
		for (const [feedbackId, sourceRef] of [
			[
				"feedback-delete-from-receipt",
				{ kind: "receipt", locator: "receipt:receipt-delete-language", dataClass: "public" },
			],
			["feedback-delete-from-signal", { kind: "signal", locator: `signal:${signalId}`, dataClass: "public" }],
		] as const) {
			await expect(
				deletePersonalMemory(
					profileRoot,
					{
						feedbackId,
						target: { memoryId, revision: reinforced.item.revision },
						sourceRef,
						requestedAt: "2026-08-08T10:00:05.000Z",
						reasonCode: "privacy_request",
					},
					{ expectedProfileRevision: 6 },
				),
			).rejects.toThrow("MEMORY_DELETED_TERMINAL");
		}
		await expect(openMemoryProfile(profileRoot, { rebuildCache: false })).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 6 },
			counts: { items: 2, tombstones: 0 },
		});

		const deleted = await deletePersonalMemory(
			profileRoot,
			{
				feedbackId: "feedback-delete-language",
				target: { memoryId, revision: reinforced.item.revision },
				sourceRef: { kind: "session", locator: "session:delete-request", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:05.000Z",
				reasonCode: "privacy_request",
			},
			{ expectedProfileRevision: 6 },
		);
		expect(deleted).toMatchObject({
			committed: true,
			verification: { status: "verified", residueCodes: [] },
		});
		expect(deleted.verification.deletionTransactionId).toBe(deleted.transactionId);
		expect(deleted.verification.transactionId).toBe(deleted.verificationTransactionId);
		expect(deleted.verification.profileRevision).toBe(7);
		expect(deleted.verification.checkedClasses).toEqual(MEMORY_DELETION_CHECKED_CLASSES);
		expect(deleted.verificationTransactionId).not.toBe(deleted.transactionId);
		expect(deleted.tombstone).toMatchObject({
			memoryId,
			terminalRevision: 3,
			reasonCode: "privacy_request",
		});
		const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") throw new Error("expected writable deleted profile");
		expect(opened).toMatchObject({
			profile: { revision: 8, preferenceRefs: {} },
			activeItems: [],
			counts: {
				signals: 0,
				candidates: 0,
				items: 0,
				feedback: 1,
				receipts: 0,
				tombstones: 1,
				audit: 1,
				transferManifests: 0,
			},
		});
		const state = await loadCanonicalMemoryState(opened.root, opened.profile);
		expect(state.feedback).toHaveLength(1);
		expect(state.feedback[0]).toMatchObject({ action: "delete", exportExclusionVerifiedAt: null });
		expect(state.audit).toEqual([deleted.verification]);
		expect(JSON.stringify(state.audit)).not.toMatch(/(?:value|path|zz-Private)/iu);
		const tombstoneText = await readFile(join(profileRoot, "tombstones", `${memoryId}.json`), "utf8");
		expect(tombstoneText).not.toContain(semantic);
		expect(tombstoneText).not.toMatch(/(?:value|excerpt|prompt|credential|project title|host path)/iu);
		expect(await allFileText(profileRoot)).not.toContain(semantic);
		await expect(verifyMemoryDeletion(profileRoot, memoryId)).resolves.toMatchObject({
			status: "verified",
			residueCodes: [],
		});
		await expect(retrievePersonalMemory(profileRoot, retrievalQuery())).resolves.toMatchObject({
			status: "empty",
			items: [],
			context: "",
		});
		await expect(
			applyMemoryFeedback(
				profileRoot,
				{
					feedbackId: "feedback-restore-deleted",
					target: { memoryId, revision: 2 },
					action: "restore",
					correction: null,
					sourceRef: { kind: "session", locator: "session:restore-deleted", dataClass: "public" },
					reasonCode: "restore-deleted",
					requestedAt: "2026-08-08T10:00:06.000Z",
				},
				{ expectedProfileRevision: 8 },
			),
		).rejects.toThrow("MEMORY_DELETED_TERMINAL");
		await expect(
			appendMemoryItem(
				profileRoot,
				itemDraft(created.profile.profileId, memoryId, {
					category: "writing",
					key: "language",
					value: "en-US",
					allowedEffects: ["formatting"],
				}),
				{ expectedProfileRevision: 8 },
			),
		).rejects.toThrow("MEMORY_DELETED_TERMINAL");
		const independent = await appendMemoryItem(
			profileRoot,
			itemDraft(created.profile.profileId, "memory-independent-language", {
				category: "writing",
				key: "language",
				value: "en-US",
				allowedEffects: ["formatting"],
			}),
			{ expectedProfileRevision: 8 },
		);
		await expect(
			applyMemoryFeedback(
				profileRoot,
				{
					feedbackId: "feedback-replay-deleted-receipt",
					target: { memoryId: independent.item.memoryId, revision: 1 },
					action: "reinforce",
					correction: null,
					sourceRef: {
						kind: "receipt",
						locator: "receipt:receipt-delete-language",
						dataClass: "public",
					},
					reasonCode: "replayed-deleted-receipt",
					requestedAt: "2026-08-08T10:00:07.000Z",
				},
				{ expectedProfileRevision: 9 },
			),
		).rejects.toThrow("MEMORY_DELETED_TERMINAL");
	});

	it("returns a committed deletion with a persisted failed verification attestation", async () => {
		const memoryId = "memory-verification-failure";
		await seedDeletableItem(memoryId);
		const deleted = await deletePersonalMemory(
			profileRoot,
			{
				feedbackId: "feedback-verification-failure",
				target: { memoryId, revision: 1 },
				sourceRef: { kind: "session", locator: "session:verification-failure", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:05.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 1, faultAfterDeletionCommit: "verification" },
		);
		expect(deleted).toMatchObject({
			committed: true,
			verification: {
				status: "failed",
				profileRevision: 2,
				checkedClasses: [],
				residueCodes: ["verification_unavailable"],
			},
		});
		expect(deleted.verification.transactionId).toBe(deleted.verificationTransactionId);
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 3 },
			counts: { items: 0, tombstones: 1, audit: 1 },
		});
	});

	it("returns committed partial evidence when the attestation transaction cannot start", async () => {
		const memoryId = "memory-attestation-crash";
		await seedDeletableItem(memoryId);
		await expect(
			deletePersonalMemory(
				profileRoot,
				{
					feedbackId: "feedback-attestation-crash",
					target: { memoryId, revision: 1 },
					sourceRef: { kind: "session", locator: "session:attestation-crash", dataClass: "public" },
					requestedAt: "2026-08-08T10:00:05.000Z",
					reasonCode: "user_requested",
				},
				{ expectedProfileRevision: 1, faultAfterDeletionCommit: "attestation" },
			),
		).resolves.toMatchObject({
			committed: true,
			attestationRecorded: false,
			verificationTransactionId: null,
			errorCode: "MEMORY_DELETE_COMMITTED_UNVERIFIED",
			verification: { status: "verified", verificationId: null, transactionId: null },
		});
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 2 },
			counts: { items: 0, feedback: 1, tombstones: 1, audit: 0 },
		});
		await expect(verifyAndRecordMemoryDeletion(profileRoot, memoryId)).resolves.toMatchObject({
			attestationRecorded: true,
			verification: { status: "verified", residueCodes: [] },
		});
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 3 },
			counts: { audit: 1 },
		});
		await expect(
			verifyAndRecordMemoryDeletion(profileRoot, memoryId, { faultDuringVerification: true }),
		).resolves.toMatchObject({
			attestationRecorded: true,
			verification: {
				status: "failed",
				checkedClasses: [],
				residueCodes: ["verification_unavailable"],
			},
		});
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 4 },
			counts: { audit: 2 },
		});
	});

	it("fails closed when an audit record forges its deletion transaction binding", async () => {
		const memoryId = "memory-forged-attestation";
		await seedDeletableItem(memoryId);
		const deleted = await deletePersonalMemory(
			profileRoot,
			{
				feedbackId: "feedback-forged-attestation",
				target: { memoryId, revision: 1 },
				sourceRef: { kind: "session", locator: "session:forged-attestation", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:05.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 1 },
		);
		const auditPath = join(
			profileRoot,
			"audit",
			...memoryMonthPath(deleted.verification.checkedAt).split("/"),
			`${deleted.verification.verificationId}.json`,
		);
		const audit = JSON.parse(await readFile(auditPath, "utf8")) as Record<string, unknown>;
		await writeFile(
			auditPath,
			`${canonicalStringify({ ...audit, deletionTransactionId: "forged-deletion-transaction" })}\n`,
		);
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-only",
			issues: [{ code: "memory.canonical_invalid" }],
		});
	});

	it("fails closed when an audit record claims verification before deletion", async () => {
		const memoryId = "memory-predated-attestation";
		await seedDeletableItem(memoryId);
		const deleted = await deletePersonalMemory(
			profileRoot,
			{
				feedbackId: "feedback-predated-attestation",
				target: { memoryId, revision: 1 },
				sourceRef: { kind: "session", locator: "session:predated-attestation", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:05.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 1 },
		);
		const auditPath = join(
			profileRoot,
			"audit",
			...memoryMonthPath(deleted.verification.checkedAt).split("/"),
			`${deleted.verification.verificationId}.json`,
		);
		const audit = JSON.parse(await readFile(auditPath, "utf8")) as Record<string, unknown>;
		await writeFile(auditPath, `${canonicalStringify({ ...audit, checkedAt: "2026-08-08T09:59:59.000Z" })}\n`);
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-only",
			issues: [{ code: "memory.canonical_invalid" }],
		});
	});

	it("fails closed when a tombstone loses its applied delete feedback", async () => {
		const memoryId = "memory-missing-delete-feedback";
		await seedDeletableItem(memoryId);
		await deletePersonalMemory(
			profileRoot,
			{
				feedbackId: "feedback-missing-delete-feedback",
				target: { memoryId, revision: 1 },
				sourceRef: { kind: "session", locator: "session:missing-delete-feedback", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:05.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 1 },
		);
		await rm(
			join(
				profileRoot,
				"feedback",
				...memoryMonthPath("2026-08-08T10:00:05.000Z").split("/"),
				"feedback-missing-delete-feedback.json",
			),
		);
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-only",
			issues: [{ code: "memory.canonical_invalid" }],
		});
	});

	it("fails closed and blocks ID reuse when applied delete feedback loses its tombstone", async () => {
		const memoryId = "memory-missing-tombstone";
		await seedDeletableItem(memoryId);
		await expect(
			deletePersonalMemory(
				profileRoot,
				{
					feedbackId: "feedback-missing-tombstone",
					target: { memoryId, revision: 1 },
					sourceRef: { kind: "session", locator: "session:missing-tombstone", dataClass: "public" },
					requestedAt: "2026-08-08T10:00:05.000Z",
					reasonCode: "user_requested",
				},
				{ expectedProfileRevision: 1, faultAfterDeletionCommit: "attestation" },
			),
		).resolves.toMatchObject({
			committed: true,
			attestationRecorded: false,
			errorCode: "MEMORY_DELETE_COMMITTED_UNVERIFIED",
		});
		await rm(join(profileRoot, "tombstones", `${memoryId}.json`));
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-only",
			issues: [{ code: "memory.canonical_invalid" }],
		});
		await expect(
			appendMemoryItem(
				profileRoot,
				itemDraft("profile-1", memoryId, {
					category: "writing",
					key: "language",
					value: "en-US",
					allowedEffects: ["formatting"],
				}),
				{ expectedProfileRevision: 2 },
			),
		).rejects.toThrow("Applied deletion feedback does not match a tombstone");
	});

	it("rejects post-delete records through writers and canonical import boundaries", async () => {
		const memoryId = "memory-terminal-records";
		await seedDeletableItem(memoryId);
		const beforeDelete = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (beforeDelete.mode !== "read-write") throw new Error("expected writable seeded profile");
		const deletedItem = beforeDelete.items[0];
		if (deletedItem === undefined) throw new Error("expected seeded item");
		const deleted = await deletePersonalMemory(
			profileRoot,
			{
				feedbackId: "feedback-terminal-delete",
				target: { memoryId, revision: 1 },
				sourceRef: { kind: "session", locator: "session:terminal-delete", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:05.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 1, faultAfterDeletionCommit: "attestation" },
		);
		expect(deleted).toMatchObject({ committed: true, attestationRecorded: false });
		const correction: MemoryFeedbackV1 = {
			format: "doro-memory-feedback",
			schemaVersion: "1.0.0",
			feedbackId: "feedback-terminal-correction",
			profileId: "profile-1",
			target: { memoryId, revision: 1 },
			action: "correct",
			correction: { key: "language", value: "fr-FR" },
			actor: "user",
			sourceRef: { kind: "session", locator: "session:terminal-correction", dataClass: "public" },
			reasonCode: "user_corrected",
			requestedAt: "2026-08-08T10:00:06.000Z",
			applicationStatus: "pending",
			resultingRevision: null,
			deactivatedAt: null,
			cacheInvalidatedAt: null,
			exportExclusionVerifiedAt: null,
			transactionId: null,
			errorCode: null,
		};
		await expect(appendMemoryRecord(profileRoot, correction, { expectedProfileRevision: 2 })).rejects.toThrow(
			"MEMORY_DELETED_TERMINAL",
		);
		await expect(appendMemoryRecord(profileRoot, deleted.feedback, { expectedProfileRevision: 2 })).rejects.toThrow(
			"MEMORY_DELETE_ATOMIC_REQUIRED",
		);
		const forgedReceipt: MemoryUseReceiptV1 = {
			format: "doro-memory-use-receipt",
			schemaVersion: "1.0.0",
			receiptId: "receipt-terminal-forged",
			profileId: "profile-1",
			sessionRef: { kind: "session", locator: "session:terminal-forged", dataClass: "public" },
			taskRef: { kind: "task", locator: "task:terminal-forged", dataClass: "public" },
			operationRef: null,
			artifactRef: null,
			itemRefs: [{ memoryId, revision: 1, provenanceHash: deletedItem.provenanceHash }],
			effect: "formatting",
			decisionCodeBefore: "default",
			decisionCodeAfter: "deleted",
			explanationCodes: ["forged"],
			criticalResearchDecisionTouched: false,
			approvalRequired: false,
			appliedAt: "2026-08-08T10:00:07.000Z",
			retrievalLatencyMs: 1,
			addedContextTokens: 1,
			estimatedCostUsd: 0,
			outcome: "applied",
			feedbackRefs: [],
			contextDigest: hash("forged-receipt"),
		};
		await expect(appendMemoryRecord(profileRoot, forgedReceipt, { expectedProfileRevision: 2 })).rejects.toThrow(
			"MEMORY_DELETED_TERMINAL",
		);
		const successorDraft = {
			...itemDraft("profile-1", "memory-terminal-successor", {
				category: "writing",
				key: "language",
				value: "en-US",
				allowedEffects: ["formatting"],
			}),
			supersedes: [{ memoryId, revision: 1 }],
		};
		await expect(appendMemoryItem(profileRoot, successorDraft, { expectedProfileRevision: 2 })).rejects.toThrow(
			"MEMORY_DELETED_TERMINAL",
		);
		const clean = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (clean.mode !== "read-write") throw new Error("expected clean deleted profile");
		const forgedItemPath = join(profileRoot, "items", deletedItem.category, memoryId, `${deletedItem.revision}.json`);
		await mkdir(join(profileRoot, "items", deletedItem.category, memoryId), { recursive: true });
		await writeFile(forgedItemPath, `${canonicalStringify(deletedItem)}\n`);
		await expect(loadCanonicalMemoryState(profileRoot, clean.profile)).rejects.toThrow(
			"Canonical record conflicts with deletion tombstone",
		);
		await rm(forgedItemPath);
		const successorPath = join(profileRoot, "items", "writing", "memory-terminal-successor", "1.json");
		await mkdir(join(profileRoot, "items", "writing", "memory-terminal-successor"), { recursive: true });
		await writeFile(
			successorPath,
			`${canonicalStringify({ ...successorDraft, transactionId: "transaction-forged-successor" })}\n`,
		);
		await expect(loadCanonicalMemoryState(profileRoot, clean.profile)).rejects.toThrow(
			"Canonical record conflicts with deletion tombstone",
		);
		await rm(successorPath);
		const correctionPath = join(
			profileRoot,
			"feedback",
			...memoryMonthPath(correction.requestedAt).split("/"),
			`${correction.feedbackId}.json`,
		);
		await writeFile(correctionPath, `${canonicalStringify(correction)}\n`);
		await expect(loadCanonicalMemoryState(profileRoot, clean.profile)).rejects.toThrow(
			"Memory deletion tombstone does not match applied feedback",
		);
		await rm(correctionPath);
		const receiptDirectory = join(profileRoot, "receipts", ...memoryMonthPath(forgedReceipt.appliedAt).split("/"));
		await mkdir(receiptDirectory, { recursive: true });
		await writeFile(
			join(receiptDirectory, `${forgedReceipt.receiptId}.json`),
			`${canonicalStringify(forgedReceipt)}\n`,
		);
		await expect(loadCanonicalMemoryState(profileRoot, clean.profile)).rejects.toThrow(
			"Canonical record conflicts with deletion tombstone",
		);
	});

	it("restores a partial delete before profile commit and finalizes either committed crash state", async () => {
		const created = await createMemoryProfile(profileRoot, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		await appendMemoryRecord(
			profileRoot,
			candidate(created.profile.profileId, "candidate-rollback", "signal-rollback", "en-US"),
			{ expectedProfileRevision: 0 },
		);
		const candidatePath = join(profileRoot, "candidates", "candidate-rollback.json");
		const rollback = await prepareMemoryTransaction(profileRoot, 1, (profile, transactionId) => ({
			profile: {
				...profile,
				revision: 2,
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			},
			writes: [{ path: "candidates/candidate-rollback.json", delete: true }],
			result: null,
		}));
		const rollbackPending = join(profileRoot, "transactions", "pending", rollback.transactionId);
		await rename(candidatePath, join(rollbackPending, "staged", "deleted-0.bin"));
		await rollbackPreparedMemoryTransaction(profileRoot, rollback.transactionId);
		await expect(access(candidatePath)).resolves.toBeUndefined();
		await expect(
			access(join(profileRoot, "transactions", "failed", rollback.transactionId, "staged")),
		).rejects.toThrow();

		const resumed = await prepareMemoryTransaction(profileRoot, 1, (profile, transactionId) => ({
			profile: {
				...profile,
				revision: 2,
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			},
			writes: [{ path: "candidates/candidate-rollback.json", delete: true }],
			result: null,
		}));
		const resumedPending = join(profileRoot, "transactions", "pending", resumed.transactionId);
		await rename(candidatePath, join(resumedPending, "staged", "deleted-0.bin"));
		await commitPreparedMemoryTransaction(profileRoot, resumed.transactionId);
		await expect(access(candidatePath)).rejects.toThrow();
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 2 },
			counts: { candidates: 0 },
		});

		await appendMemoryRecord(
			profileRoot,
			candidate(created.profile.profileId, "candidate-finalized", "signal-finalized", "fr-FR"),
			{ expectedProfileRevision: 2 },
		);
		const finalizedPath = join(profileRoot, "candidates", "candidate-finalized.json");
		const finalized = await prepareMemoryTransaction(profileRoot, 3, (profile, transactionId) => ({
			profile: {
				...profile,
				revision: 4,
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			},
			writes: [{ path: "candidates/candidate-finalized.json", delete: true }],
			result: null,
		}));
		const finalizedPending = join(profileRoot, "transactions", "pending", finalized.transactionId);
		const finalizedBackup = join(finalizedPending, "staged", "deleted-0.bin");
		await rename(finalizedPath, finalizedBackup);
		await writeFile(
			join(profileRoot, "profile.json"),
			await readFile(join(finalizedPending, "staged", "profile.bin")),
		);
		await rm(finalizedBackup);
		await commitPreparedMemoryTransaction(profileRoot, finalized.transactionId);
		expect(await listPendingMemoryTransactions(profileRoot)).toEqual([]);
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 4, lastTransactionId: finalized.transactionId },
			counts: { candidates: 0 },
		});
	});

	it("recovers a pending version 1 append journal after the transaction upgrade", async () => {
		const created = await createMemoryProfile(profileRoot, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		const record = candidate(created.profile.profileId, "candidate-v1-journal", "signal-v1", "de-DE");
		const prepared = await prepareMemoryTransaction(profileRoot, 0, (profile, transactionId) => ({
			profile: {
				...profile,
				revision: 1,
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			},
			writes: [{ path: "candidates/candidate-v1-journal.json", content: `${canonicalStringify(record)}\n` }],
			result: null,
		}));
		const journalPath = join(profileRoot, "transactions", "pending", prepared.transactionId, "transaction.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			version: number;
			entries: Array<{ path: string; newHash: string }>;
			[key: string]: unknown;
		};
		await writeFile(
			journalPath,
			`${canonicalStringify({
				...journal,
				version: 1,
				entries: journal.entries.map(({ path, newHash }) => ({ path, newHash })),
			})}\n`,
		);
		await commitPreparedMemoryTransaction(profileRoot, prepared.transactionId);
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 1 },
			counts: { candidates: 1 },
		});
	});
});
