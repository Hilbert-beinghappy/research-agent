// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../../../src/contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../../../../src/contracts/integrity.ts";
import { deletePersonalMemory, verifyAndRecordMemoryDeletion } from "../../../../src/memory/deletion.ts";
import { memoryProfileRoot } from "../../../../src/memory/layout.ts";
import { appendMemoryItem, createMemoryProfile, openMemoryProfile } from "../../../../src/memory/store.ts";
import {
	exportEncryptedMemoryTransfer,
	importEncryptedMemoryTransfer,
	recoverMemoryTransferImport,
	verifyEncryptedMemoryTransfer,
} from "../../../../src/memory/transfer.ts";
import { itemDraft } from "./retrieval-fixtures.ts";

interface MutableBundle {
	entries: Array<{ path: string; ciphertextBase64: string }>;
	[key: string]: unknown;
}

let temporaryDirectory: string;
const profileId = "profile-transfer";
let passphrase: Buffer;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-transfer-atomic-"));
	passphrase = Buffer.from("atomic transfer passphrase");
});

afterEach(async () => {
	passphrase.fill(0);
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function createSource(path: string, id = profileId): Promise<void> {
	const created = await createMemoryProfile(path, { profileId: id });
	if (created.mode !== "read-write") throw new Error("expected writable source profile");
	await addMemory(path, id, "memory-base", "table", 0);
}

async function addMemory(
	profileRoot: string,
	id: string,
	memoryId: string,
	value: "table" | "prose" | "mixed",
	expectedProfileRevision: number,
): Promise<void> {
	await appendMemoryItem(
		profileRoot,
		itemDraft(id, memoryId, {
			category: "writing",
			key: "representation",
			value,
			allowedEffects: ["formatting"],
		}),
		{ expectedProfileRevision },
	);
}

async function directoryDigest(root: string): Promise<string> {
	const files: Array<{ path: string; bytes: string }> = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("unexpected symlink");
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) {
				files.push({
					path: relative(root, path).split(sep).join("/"),
					bytes: (await readFile(path)).toString("base64"),
				});
			}
		}
	};
	await walk(root);
	files.sort((left, right) => left.path.localeCompare(right.path));
	return hashCanonicalJson(files).value;
}

async function writeBundle(path: string, bundle: MutableBundle): Promise<void> {
	await writeFile(path, `${canonicalStringify(bundle)}\n`);
}

describe("Personal Memory transfer atomic rejection", { timeout: 60_000 }, () => {
	it("imports a new profile, treats replay as idempotent, and fast-forwards only after complete validation", async () => {
		const source = join(temporaryDirectory, "source");
		const targetHome = join(temporaryDirectory, "target-home");
		const firstBundle = join(temporaryDirectory, "first.doro-memory");
		await createSource(source);
		await exportEncryptedMemoryTransfer(source, firstBundle, passphrase, { snapshotId: "snapshot-first" });

		const first = await importEncryptedMemoryTransfer(targetHome, firstBundle, passphrase);
		expect(first).toMatchObject({ outcome: "imported", profileId, profileRevision: 2, manifestRecorded: true });
		const replay = await importEncryptedMemoryTransfer(targetHome, firstBundle, passphrase);
		expect(replay).toMatchObject({ outcome: "idempotent", profileRevision: 2, manifestRecorded: true });

		await addMemory(source, profileId, "memory-fast-forward", "prose", 2);
		const nextBundle = join(temporaryDirectory, "next.doro-memory");
		await exportEncryptedMemoryTransfer(source, nextBundle, passphrase, { snapshotId: "snapshot-next" });
		const targetRoot = memoryProfileRoot(targetHome, profileId);
		const beforeFault = await directoryDigest(targetRoot);
		await expect(
			importEncryptedMemoryTransfer(targetHome, nextBundle, passphrase, { faultAfterPhase: "staged" }),
		).rejects.toMatchObject({ code: "MEMORY_TRANSFER_INTERRUPTED" });
		expect(await directoryDigest(targetRoot)).toBe(beforeFault);
		await expect(
			importEncryptedMemoryTransfer(targetHome, nextBundle, passphrase, { faultAfterPhase: "backed_up" }),
		).rejects.toMatchObject({ code: "MEMORY_TRANSFER_INTERRUPTED" });
		expect(await directoryDigest(targetRoot)).toBe(beforeFault);

		const advanced = await importEncryptedMemoryTransfer(targetHome, nextBundle, passphrase);
		expect(advanced).toMatchObject({ outcome: "imported", profileRevision: 4, manifestRecorded: true });
		const opened = await openMemoryProfile(targetRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") throw new Error("expected writable imported profile");
		expect(opened.cacheStatus).toBe("valid");
		expect(opened.activeItems.map(({ memoryId }) => memoryId).sort()).toEqual(["memory-base", "memory-fast-forward"]);
	});

	it("rejects a same-lineage fork and restores the exact local profile", async () => {
		const source = join(temporaryDirectory, "fork-source");
		const targetHome = join(temporaryDirectory, "fork-target-home");
		const baseBundle = join(temporaryDirectory, "fork-base.doro-memory");
		await createSource(source);
		await exportEncryptedMemoryTransfer(source, baseBundle, passphrase, { snapshotId: "snapshot-fork-base" });
		await importEncryptedMemoryTransfer(targetHome, baseBundle, passphrase);
		const targetRoot = memoryProfileRoot(targetHome, profileId);
		await addMemory(source, profileId, "memory-source-branch", "prose", 2);
		await addMemory(targetRoot, profileId, "memory-target-branch", "mixed", 2);
		const forkBundle = join(temporaryDirectory, "fork.doro-memory");
		await exportEncryptedMemoryTransfer(source, forkBundle, passphrase, { snapshotId: "snapshot-fork" });
		const before = await directoryDigest(targetRoot);
		await expect(importEncryptedMemoryTransfer(targetHome, forkBundle, passphrase)).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_CONFLICT",
		});
		expect(await directoryDigest(targetRoot)).toBe(before);
	});

	it("keeps deletion verification audit local and blocks a non-idempotent merge", async () => {
		const source = join(temporaryDirectory, "audit-source");
		const targetHome = join(temporaryDirectory, "audit-target-home");
		const baseBundle = join(temporaryDirectory, "audit-base.doro-memory");
		await createSource(source);
		await exportEncryptedMemoryTransfer(source, baseBundle, passphrase, { snapshotId: "snapshot-audit-base" });
		await importEncryptedMemoryTransfer(targetHome, baseBundle, passphrase);
		const targetRoot = memoryProfileRoot(targetHome, profileId);
		await deletePersonalMemory(
			targetRoot,
			{
				feedbackId: "feedback-audit-local",
				target: { memoryId: "memory-base", revision: 1 },
				sourceRef: { kind: "session", locator: "session:audit-local", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:00.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 2 },
		);
		const localBundle = join(temporaryDirectory, "audit-local.doro-memory");
		await exportEncryptedMemoryTransfer(targetRoot, localBundle, passphrase, { snapshotId: "snapshot-audit-local" });
		const localSnapshot = await verifyEncryptedMemoryTransfer(localBundle, passphrase);
		expect(localSnapshot.snapshot.files.some(({ path }) => path.startsWith("audit/"))).toBe(false);
		expect(localSnapshot.snapshot.files.some(({ path }) => path.startsWith("tombstones/"))).toBe(true);

		await addMemory(source, profileId, "memory-audit-advance-1", "prose", 2);
		await addMemory(source, profileId, "memory-audit-advance-2", "mixed", 3);
		await addMemory(source, profileId, "memory-audit-advance-3", "table", 4);
		await addMemory(source, profileId, "memory-audit-advance-4", "prose", 5);
		const advancedBundle = join(temporaryDirectory, "audit-advanced.doro-memory");
		await exportEncryptedMemoryTransfer(source, advancedBundle, passphrase, {
			snapshotId: "snapshot-audit-advanced",
		});
		const before = await directoryDigest(targetRoot);
		await expect(importEncryptedMemoryTransfer(targetHome, advancedBundle, passphrase)).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_CONFLICT",
		});
		expect(await directoryDigest(targetRoot)).toBe(before);
	});

	it("rejects export rather than orphaning a tombstone from restricted delete feedback", async () => {
		const source = join(temporaryDirectory, "restricted-delete-source");
		const bundle = join(temporaryDirectory, "restricted-delete.doro-memory");
		await createSource(source);
		await expect(
			deletePersonalMemory(
				source,
				{
					feedbackId: "feedback-restricted-delete",
					target: { memoryId: "memory-base", revision: 1 },
					sourceRef: { kind: "session", locator: "session:restricted-delete", dataClass: "restricted" },
					requestedAt: "2026-08-08T10:00:00.000Z",
					reasonCode: "privacy_request",
				},
				{ expectedProfileRevision: 1 },
			),
		).resolves.toMatchObject({
			committed: true,
			verification: {
				status: "failed",
				checkedClasses: [],
				residueCodes: ["verification_unavailable"],
			},
		});
		await expect(exportEncryptedMemoryTransfer(source, bundle, passphrase)).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_INVALID_BUNDLE",
		});
	});

	it("imports a terminal pair without claiming the missing source deletion journal", async () => {
		const source = join(temporaryDirectory, "terminal-import-source");
		const targetHome = join(temporaryDirectory, "terminal-import-home");
		const bundle = join(temporaryDirectory, "terminal-import.doro-memory");
		await createSource(source);
		await deletePersonalMemory(
			source,
			{
				feedbackId: "feedback-terminal-import",
				target: { memoryId: "memory-base", revision: 1 },
				sourceRef: { kind: "session", locator: "session:terminal-import", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:00.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 1 },
		);
		await exportEncryptedMemoryTransfer(source, bundle, passphrase, { snapshotId: "snapshot-terminal-import" });
		await importEncryptedMemoryTransfer(targetHome, bundle, passphrase);
		const targetRoot = memoryProfileRoot(targetHome, profileId);
		const recorded = await verifyAndRecordMemoryDeletion(targetRoot, "memory-base");
		expect(recorded).toMatchObject({
			attestationRecorded: true,
			errorCode: "MEMORY_DELETE_VERIFICATION_FAILED",
			verification: { status: "failed", residueCodes: ["deletion_binding_mismatch"] },
		});
		expect(recorded.verification.checkedClasses).not.toContain("deletion_transaction");
		const opened = await openMemoryProfile(targetRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") throw new Error("expected writable imported terminal profile");
		await expect(
			appendMemoryItem(
				targetRoot,
				itemDraft(profileId, "memory-base", {
					category: "writing",
					key: "representation",
					value: "prose",
					allowedEffects: ["formatting"],
				}),
				{ expectedProfileRevision: opened.profile.revision },
			),
		).rejects.toThrow("MEMORY_DELETED_TERMINAL");
	});

	it("requires incoming fast-forwards to preserve the local terminal pair byte-for-byte", async () => {
		const source = join(temporaryDirectory, "terminal-merge-source");
		const targetHome = join(temporaryDirectory, "terminal-merge-home");
		const baseBundle = join(temporaryDirectory, "terminal-merge-base.doro-memory");
		await createSource(source);
		await exportEncryptedMemoryTransfer(source, baseBundle, passphrase, {
			snapshotId: "snapshot-terminal-merge-base",
		});
		await importEncryptedMemoryTransfer(targetHome, baseBundle, passphrase);
		const targetRoot = memoryProfileRoot(targetHome, profileId);
		const localRequestedAt = "2026-08-08T10:00:00.000Z";
		await deletePersonalMemory(
			targetRoot,
			{
				feedbackId: "feedback-local-terminal",
				target: { memoryId: "memory-base", revision: 1 },
				sourceRef: { kind: "session", locator: "session:local-terminal", dataClass: "public" },
				requestedAt: localRequestedAt,
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 2, faultAfterDeletionCommit: "attestation" },
		);
		await addMemory(source, profileId, "memory-cover", "prose", 2);
		await deletePersonalMemory(
			source,
			{
				feedbackId: "feedback-cover-terminal",
				target: { memoryId: "memory-cover", revision: 1 },
				sourceRef: { kind: "session", locator: "session:cover-terminal", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:01.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 3, faultAfterDeletionCommit: "attestation" },
		);
		const coverTombstonePath = join(source, "tombstones", "memory-cover.json");
		const coverTombstone = JSON.parse(await readFile(coverTombstonePath, "utf8")) as {
			deletedPathHashes: string[];
			[key: string]: unknown;
		};
		const localFeedbackPath = `feedback/2026/08/feedback-local-terminal.json`;
		coverTombstone.deletedPathHashes = [
			...new Set([
				...coverTombstone.deletedPathHashes,
				`sha256:${hashBytes("tombstones/memory-base.json").value}`,
				`sha256:${hashBytes(localFeedbackPath).value}`,
			]),
		].sort();
		await writeFile(coverTombstonePath, `${canonicalStringify(coverTombstone)}\n`);
		const omittedBundle = join(temporaryDirectory, "terminal-merge-omitted.doro-memory");
		await exportEncryptedMemoryTransfer(source, omittedBundle, passphrase, {
			snapshotId: "snapshot-terminal-merge-omitted",
		});
		const before = await directoryDigest(targetRoot);
		await expect(importEncryptedMemoryTransfer(targetHome, omittedBundle, passphrase)).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_CONFLICT",
		});
		expect(await directoryDigest(targetRoot)).toBe(before);

		const rewrittenSource = join(temporaryDirectory, "terminal-merge-rewritten-source");
		await cp(targetRoot, rewrittenSource, { recursive: true });
		const oldFeedbackFile = join(rewrittenSource, ...localFeedbackPath.split("/"));
		const oldFeedback = JSON.parse(await readFile(oldFeedbackFile, "utf8")) as Record<string, unknown>;
		const rewrittenFeedback = {
			...oldFeedback,
			feedbackId: "feedback-local-terminal-rewritten",
			sourceRef: { kind: "session", locator: "session:rewritten-terminal", dataClass: "public" },
		};
		await rm(oldFeedbackFile);
		await writeFile(
			join(rewrittenSource, "feedback", "2026", "08", "feedback-local-terminal-rewritten.json"),
			`${canonicalStringify(rewrittenFeedback)}\n`,
		);
		await addMemory(rewrittenSource, profileId, "memory-rewrite-cover", "mixed", 3);
		await deletePersonalMemory(
			rewrittenSource,
			{
				feedbackId: "feedback-rewrite-cover",
				target: { memoryId: "memory-rewrite-cover", revision: 1 },
				sourceRef: { kind: "session", locator: "session:rewrite-cover", dataClass: "public" },
				requestedAt: "2026-08-08T10:00:02.000Z",
				reasonCode: "user_requested",
			},
			{ expectedProfileRevision: 4, faultAfterDeletionCommit: "attestation" },
		);
		const rewriteCoverPath = join(rewrittenSource, "tombstones", "memory-rewrite-cover.json");
		const rewriteCover = JSON.parse(await readFile(rewriteCoverPath, "utf8")) as {
			deletedPathHashes: string[];
			[key: string]: unknown;
		};
		rewriteCover.deletedPathHashes = [
			...new Set([...rewriteCover.deletedPathHashes, `sha256:${hashBytes(localFeedbackPath).value}`]),
		].sort();
		await writeFile(rewriteCoverPath, `${canonicalStringify(rewriteCover)}\n`);
		const rewrittenBundle = join(temporaryDirectory, "terminal-merge-rewritten.doro-memory");
		await exportEncryptedMemoryTransfer(rewrittenSource, rewrittenBundle, passphrase, {
			snapshotId: "snapshot-terminal-merge-rewritten",
		});
		await expect(importEncryptedMemoryTransfer(targetHome, rewrittenBundle, passphrase)).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_CONFLICT",
		});
		expect(await directoryDigest(targetRoot)).toBe(before);
	});

	it("recovers a durable after-backup journal left by an interrupted process", async () => {
		const source = join(temporaryDirectory, "recovery-source");
		const targetHome = join(temporaryDirectory, "recovery-target-home");
		const bundle = join(temporaryDirectory, "recovery.doro-memory");
		await createSource(source);
		await exportEncryptedMemoryTransfer(source, bundle, passphrase, { snapshotId: "snapshot-recovery" });
		await importEncryptedMemoryTransfer(targetHome, bundle, passphrase);
		const target = memoryProfileRoot(targetHome, profileId);
		const before = await directoryDigest(target);
		const token = randomUUID();
		const profiles = join(targetHome, "profiles");
		const stagingName = `.import-${token}`;
		const backupName = `.backup-${token}`;
		const staging = join(profiles, stagingName);
		const backup = join(profiles, backupName);
		const createdAt = new Date().toISOString();
		await writeFile(
			join(target, "locks", "transfer.lock"),
			`${canonicalStringify({
				format: "doro-memory-transfer-barrier",
				version: 1,
				profileId,
				token,
				createdAt,
			})}\n`,
		);
		await expect(openMemoryProfile(target)).resolves.toMatchObject({
			mode: "read-only",
			activeItems: [],
			issues: [{ code: "memory.transfer_in_progress" }],
		});
		await expect(addMemory(target, profileId, "memory-blocked", "prose", 2)).rejects.toThrow(
			"MEMORY_TRANSFER_IN_PROGRESS",
		);
		await cp(target, staging, { recursive: true });
		await rename(target, backup);
		const journalDirectory = join(targetHome, ".memory-transfer", "journals");
		await mkdir(journalDirectory, { recursive: true });
		await writeFile(
			join(journalDirectory, `${profileId}.json`),
			`${canonicalStringify({
				format: "doro-memory-import-journal",
				version: 1,
				profileId,
				token,
				targetName: profileId,
				stagingName,
				backupName,
				hadTarget: true,
				phase: "backed_up",
				createdAt,
			})}\n`,
		);
		await expect(recoverMemoryTransferImport(targetHome, profileId)).resolves.toBe("rolled_back");
		expect(await directoryDigest(target)).toBe(before);
	});

	it("rejects traversal, case collisions, and oversized containers before local mutation", async () => {
		const source = join(temporaryDirectory, "malformed-source");
		const targetHome = join(temporaryDirectory, "malformed-target-home");
		const validBundlePath = join(temporaryDirectory, "valid.doro-memory");
		await createSource(source);
		await exportEncryptedMemoryTransfer(source, validBundlePath, passphrase, { snapshotId: "snapshot-malformed" });
		await importEncryptedMemoryTransfer(targetHome, validBundlePath, passphrase);
		const targetRoot = memoryProfileRoot(targetHome, profileId);
		const before = await directoryDigest(targetRoot);
		const valid = JSON.parse(await readFile(validBundlePath, "utf8")) as MutableBundle;

		const traversal = structuredClone(valid);
		traversal.entries[0]!.path = "../escape.bin";
		traversal.entries.sort((left, right) => left.path.localeCompare(right.path));
		const traversalPath = join(temporaryDirectory, "traversal.doro-memory");
		await writeBundle(traversalPath, traversal);
		await expect(verifyEncryptedMemoryTransfer(traversalPath, passphrase)).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_INVALID_BUNDLE",
		});

		const collision = structuredClone(valid);
		const content = collision.entries.find(({ path }) => path.startsWith("content/"));
		if (content === undefined) throw new Error("expected encrypted content entry");
		collision.entries.push({ ...content, path: content.path.replace("content/", "Content/") });
		collision.entries.sort((left, right) => left.path.localeCompare(right.path));
		const collisionPath = join(temporaryDirectory, "collision.doro-memory");
		await writeBundle(collisionPath, collision);
		await expect(verifyEncryptedMemoryTransfer(collisionPath, passphrase)).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_INVALID_BUNDLE",
		});

		const oversizedPath = join(temporaryDirectory, "oversized.doro-memory");
		const oversized = await open(oversizedPath, "wx");
		try {
			await oversized.truncate(64 * 1024 * 1024 + 1);
		} finally {
			await oversized.close();
		}
		await expect(verifyEncryptedMemoryTransfer(oversizedPath, passphrase)).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_INVALID_BUNDLE",
		});
		expect(await directoryDigest(targetRoot)).toBe(before);
	});

	it("creates a different profile ID as a separate local profile", async () => {
		const firstSource = join(temporaryDirectory, "first-source");
		const secondSource = join(temporaryDirectory, "second-source");
		const targetHome = join(temporaryDirectory, "multi-profile-home");
		await createSource(firstSource, "profile-one");
		await createSource(secondSource, "profile-two");
		const firstBundle = join(temporaryDirectory, "profile-one.doro-memory");
		const secondBundle = join(temporaryDirectory, "profile-two.doro-memory");
		await exportEncryptedMemoryTransfer(firstSource, firstBundle, passphrase);
		await exportEncryptedMemoryTransfer(secondSource, secondBundle, passphrase);
		await importEncryptedMemoryTransfer(targetHome, firstBundle, passphrase);
		await importEncryptedMemoryTransfer(targetHome, secondBundle, passphrase);
		await expect(openMemoryProfile(memoryProfileRoot(targetHome, "profile-one"))).resolves.toMatchObject({
			mode: "read-write",
			profile: { profileId: "profile-one" },
		});
		await expect(openMemoryProfile(memoryProfileRoot(targetHome, "profile-two"))).resolves.toMatchObject({
			mode: "read-write",
			profile: { profileId: "profile-two" },
		});
	});
});
