// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { MemoryCandidateDraftV1, MemoryItemV1, PreferenceSignalV1 } from "@research-agent/contracts/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import { hashCanonicalJson } from "../../src/contracts/integrity.ts";
import { MEMORY_ACTIVE_ITEMS_CACHE_PATH, MEMORY_LAYOUT_DIRECTORIES } from "../../src/memory/layout.ts";
import {
	appendMemoryItem,
	appendMemoryRecord,
	createMemoryProfile,
	doctorMemoryProfile,
	memoryItemRootHash,
	openMemoryProfile,
	validateMemoryProfile,
} from "../../src/memory/store.ts";
import {
	commitPreparedMemoryTransaction,
	listPendingMemoryTransactions,
	prepareMemoryTransaction,
	rollbackPreparedMemoryTransaction,
	runMemoryTransaction,
} from "../../src/memory/transactions.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";

let temporaryDirectory: string;
const worker = join(import.meta.dirname, "..", "fixtures", "memory-writer-worker.ts");

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-memory-store-"));
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function hash(value: unknown): `sha256:${string}` {
	return `sha256:${hashCanonicalJson(value).value}`;
}

function signal(profileId: string, signalId = "signal-1"): PreferenceSignalV1 {
	const now = new Date().toISOString();
	return {
		format: "doro-preference-signal",
		schemaVersion: "1.0.0",
		signalId,
		profileId,
		signalType: "explicit_statement",
		actor: "user",
		observedAt: now,
		category: "writing",
		normalizedKey: "language",
		normalizedValue: "zh-CN",
		scopeCandidate: { level: "global" },
		baseWeight: 1,
		dedupeKey: hash({ signalId }),
		dataClass: "public",
		sourceRefs: [{ kind: "session", locator: `session:${signalId}`, dataClass: "public" }],
		sourceContentHash: hash({ source: signalId }),
		captureMethod: { type: "deterministic", ruleVersion: "test-v1" },
		trustState: "accepted",
		rejectionCode: null,
		createdAt: now,
	};
}

function itemDraft(
	profileId: string,
	revision: number,
	status: MemoryItemV1["status"] = "active",
): Omit<MemoryItemV1, "transactionId"> {
	const now = new Date().toISOString();
	return {
		format: "doro-memory-item",
		schemaVersion: "1.0.0",
		profileId,
		memoryId: "memory-language",
		revision,
		previousRevision: revision === 1 ? null : revision - 1,
		status,
		category: "writing",
		key: "language",
		value: status === "forgotten" ? null : "zh-CN",
		origin: "explicit",
		scope: { level: "global" },
		confidence: 1,
		supportCount: revision,
		independentSupportCount: revision,
		contradictionCount: 0,
		dataClass: "public",
		allowedEffects: status === "active" ? ["formatting", "prompt_context"] : [],
		criticalDecisionPolicy: "format_only",
		sourceSignalRefs: [{ signalId: "signal-1", contentHash: hash("signal-1") }],
		supersedes: revision === 1 ? [] : [{ memoryId: "memory-language", revision: revision - 1 }],
		generator: {
			type: revision === 1 ? "rule" : "user_correction",
			version: "test-v1",
			schemaHash: hash("memory-item-schema"),
		},
		provenanceHash: hash({ profileId, revision, status }),
		validFrom: now,
		validUntil: null,
		lastSupportedAt: now,
		lastUsedAt: null,
		decay: { halfLifeDays: 180 },
		createdAt: now,
	};
}

function candidate(profileId: string, candidateId: string): MemoryCandidateDraftV1 {
	return {
		format: "doro-memory-candidate-draft",
		schemaVersion: "1.0.0",
		candidateId,
		profileId,
		category: "writing",
		key: "language",
		value: "zh-CN",
		proposedScope: { level: "global" },
		sourceSignalRefs: [{ signalId: "signal-1", contentHash: hash("signal-1") }],
		proposedEffects: ["formatting"],
		rationaleCodes: ["explicit-user-preference"],
		generatedBy: { type: "rule", version: "test-v1", outputSchemaHash: hash("candidate-schema") },
		createdAt: new Date().toISOString(),
	};
}

async function runBatch(profileRoot: string, label: string, count: number): Promise<void> {
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", worker, "batch", profileRoot, label, String(count)],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const [code] = (await once(child, "exit")) as [number | null];
	if (code !== 0) throw new Error(`memory worker ${label} failed (${code}): ${stderr}`);
	expect(JSON.parse(stdout)).toEqual({ count });
}

describe("Personal Memory store", () => {
	it("degrades a missing profile without exposing its host path", async () => {
		const root = join(temporaryDirectory, "missing-private-profile");
		const opened = await openMemoryProfile(root);
		expect(opened).toMatchObject({
			mode: "read-only",
			profile: null,
			activeItems: [],
			issues: [{ code: "memory.unavailable" }],
		});
		if (opened.mode !== "read-only") throw new Error("expected unavailable profile");
		expect(opened.issues[0]?.message).not.toContain(root);
	});

	it("creates and validates a separate canonical profile with deterministic defaults", async () => {
		const root = join(temporaryDirectory, "profile");
		const opened = await createMemoryProfile(root, { profileId: "profile-1" });
		expect(opened).toMatchObject({
			mode: "read-write",
			profile: { profileId: "profile-1", revision: 0, status: "active", lastTransactionId: null },
			activeItems: [],
			cacheStatus: "valid",
		});
		if (opened.mode !== "read-write") throw new Error("expected writable profile");
		expect(opened.profile.currentItemRootHash).toBe(memoryItemRootHash([]));
		for (const directory of MEMORY_LAYOUT_DIRECTORIES) {
			await expect(access(join(root, ...directory.split("/")))).resolves.toBeUndefined();
		}
		const profileText = await readFile(join(root, "profile.json"), "utf8");
		expect(profileText).toBe(`${canonicalStringify(JSON.parse(profileText))}\n`);
		await expect(validateMemoryProfile(root)).resolves.toMatchObject({ valid: true, profileRevision: 0 });
	});

	it("appends immutable signals and consecutive item revisions with a manifest-last root", async () => {
		const root = join(temporaryDirectory, "profile");
		const created = await createMemoryProfile(root, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		await appendMemoryRecord(root, signal(created.profile.profileId), { expectedProfileRevision: 0 });
		await appendMemoryItem(root, itemDraft(created.profile.profileId, 1), { expectedProfileRevision: 1 });

		let opened = await openMemoryProfile(root);
		expect(opened).toMatchObject({
			mode: "read-write",
			profile: {
				revision: 2,
				preferenceRefs: { writing: [{ memoryId: "memory-language", revision: 1 }] },
			},
			counts: { signals: 1, items: 1 },
			activeItems: [{ memoryId: "memory-language", revision: 1 }],
		});
		if (opened.mode !== "read-write") throw new Error("expected writable profile");
		expect(opened.profile.currentItemRootHash).toBe(memoryItemRootHash(opened.items));

		await appendMemoryItem(root, itemDraft(created.profile.profileId, 2, "forgotten"), {
			expectedProfileRevision: 2,
		});
		opened = await openMemoryProfile(root);
		expect(opened).toMatchObject({
			mode: "read-write",
			profile: { revision: 3, preferenceRefs: {}, currentItemRootHash: memoryItemRootHash([]) },
			counts: { items: 2 },
			activeItems: [],
		});
		await expect(
			appendMemoryItem(
				root,
				{ ...itemDraft(created.profile.profileId, 4), previousRevision: 2 },
				{ expectedProfileRevision: 3 },
			),
		).rejects.toThrow("consecutive revision");
		await expect(openMemoryProfile(root)).resolves.toMatchObject({ mode: "read-write", profile: { revision: 3 } });
	});

	it("rebuilds a deleted cache and isolates canonical corruption from Research Project state", async () => {
		const profileRoot = join(temporaryDirectory, "profile");
		const projectRoot = join(temporaryDirectory, "project");
		const created = await createMemoryProfile(profileRoot, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		await initializeProject(projectRoot, { title: "Independent project" });
		await appendMemoryRecord(profileRoot, signal(created.profile.profileId), { expectedProfileRevision: 0 });
		await appendMemoryItem(profileRoot, itemDraft(created.profile.profileId, 1), { expectedProfileRevision: 1 });
		await rm(join(profileRoot, ...MEMORY_ACTIVE_ITEMS_CACHE_PATH.split("/")));
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			cacheStatus: "rebuilt",
			activeItems: [{ memoryId: "memory-language" }],
		});

		await writeFile(join(profileRoot, "items", "writing", "memory-language", "1.json"), "{\n");
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-only",
			activeItems: [],
			issues: [{ code: "memory.canonical_invalid" }],
		});
		await expect(openProject(projectRoot)).resolves.toMatchObject({ compatibility: "current", mode: "read-write" });
	});

	it("continues a partially applied transaction after its lease holder is killed", async () => {
		const root = join(temporaryDirectory, "profile");
		await createMemoryProfile(root, { profileId: "profile-1" });
		const child = spawn(process.execPath, ["--experimental-strip-types", worker, "prepare-crash", root], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf8");
		const lines = createInterface({ input: child.stdout });
		const [line] = (await once(lines, "line")) as [string];
		lines.close();
		const { transactionId } = JSON.parse(line) as { transactionId: string };
		child.kill("SIGKILL");
		await once(child, "exit");

		await expect(openMemoryProfile(root)).resolves.toMatchObject({
			mode: "read-only",
			activeItems: [],
			pendingTransactions: [transactionId],
		});
		await commitPreparedMemoryTransaction(root, transactionId);
		await expect(openMemoryProfile(root)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 1, lastTransactionId: transactionId },
			counts: { candidates: 1 },
		});
		expect(await listPendingMemoryTransactions(root)).toEqual([]);
	}, 30_000);

	it("rolls a prepared append back without changing the profile root", async () => {
		const root = join(temporaryDirectory, "profile");
		const created = await createMemoryProfile(root, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		const record = candidate(created.profile.profileId, "candidate-rollback");
		const prepared = await prepareMemoryTransaction(root, 0, (profile, transactionId) => ({
			profile: { ...profile, revision: 1, updatedAt: new Date().toISOString(), lastTransactionId: transactionId },
			writes: [{ path: "candidates/candidate-rollback.json", content: `${canonicalStringify(record)}\n` }],
			result: null,
		}));
		await rollbackPreparedMemoryTransaction(root, prepared.transactionId);
		await expect(access(join(root, "candidates", "candidate-rollback.json"))).rejects.toThrow();
		await expect(openMemoryProfile(root)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 0, currentItemRootHash: created.profile.currentItemRootHash },
			counts: { candidates: 0 },
		});
	});

	it("serializes independent signal writers under one profile lease", async () => {
		const root = join(temporaryDirectory, "profile");
		await createMemoryProfile(root, { profileId: "profile-1" });
		await Promise.all([runBatch(root, "left", 20), runBatch(root, "right", 20)]);
		await expect(openMemoryProfile(root)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 40 },
			counts: { signals: 40 },
		});
		expect(await listPendingMemoryTransactions(root)).toEqual([]);
	}, 30_000);

	it("enforces data-class, pause, and terminal deletion boundaries at the transaction entry", async () => {
		const root = join(temporaryDirectory, "profile");
		const created = await createMemoryProfile(root, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		await expect(
			appendMemoryRecord(root, {
				...signal(created.profile.profileId),
				dataClass: "restricted",
				scopeCandidate: { level: "project", projectId: "project-1" },
				sourceRefs: [{ kind: "project", locator: "project:project-1", dataClass: "restricted" }],
			}),
		).rejects.toThrow("MEMORY_DATA_CLASS_DENIED");
		await runMemoryTransaction(root, 0, (profile, transactionId) => ({
			profile: {
				...profile,
				revision: 1,
				status: "paused",
				learningPolicy: { ...profile.learningPolicy, mode: "paused" },
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			},
			writes: [],
			result: null,
		}));
		await expect(appendMemoryRecord(root, signal(created.profile.profileId))).rejects.toThrow(
			"MEMORY_PROFILE_PAUSED",
		);
		await expect(appendMemoryItem(root, itemDraft(created.profile.profileId, 1))).rejects.toThrow(
			"MEMORY_PROFILE_PAUSED",
		);
		await runMemoryTransaction(root, 1, (profile, transactionId) => ({
			profile: {
				...profile,
				revision: 2,
				status: "deleted",
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			},
			writes: [],
			result: null,
		}));
		await expect(
			runMemoryTransaction(root, 2, (profile, transactionId) => ({
				profile: { ...profile, revision: 3, lastTransactionId: transactionId },
				writes: [],
				result: null,
			})),
		).rejects.toThrow("MEMORY_PROFILE_DELETED");
		await expect(openMemoryProfile(root)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 2, status: "deleted" },
			activeItems: [],
		});
	});

	it.skipIf(process.platform === "win32")("rejects canonical symlinks and never follows a cache symlink", async () => {
		const profileRoot = join(temporaryDirectory, "profile-link");
		await createMemoryProfile(profileRoot, { profileId: "profile-1" });
		const profileText = await readFile(join(profileRoot, "profile.json"), "utf8");
		await rm(join(profileRoot, "profile.json"));
		await writeFile(join(profileRoot, "profile-target.json"), profileText);
		await symlink("profile-target.json", join(profileRoot, "profile.json"));
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-only",
			issues: [{ code: "memory.canonical_invalid", message: expect.stringContaining("symbolic link") }],
		});

		const layoutRoot = join(temporaryDirectory, "layout-link");
		await createMemoryProfile(layoutRoot, { profileId: "profile-2" });
		await rm(join(layoutRoot, "signals"), { recursive: true });
		await symlink("candidates", join(layoutRoot, "signals"), "dir");
		await expect(openMemoryProfile(layoutRoot)).resolves.toMatchObject({
			mode: "read-only",
			issues: [{ code: "memory.canonical_invalid" }],
		});

		const cacheRoot = join(temporaryDirectory, "cache-link");
		await createMemoryProfile(cacheRoot, { profileId: "profile-3" });
		const cachePath = join(cacheRoot, ...MEMORY_ACTIVE_ITEMS_CACHE_PATH.split("/"));
		await rm(cachePath);
		await symlink("../profile.json", cachePath);
		await expect(openMemoryProfile(cacheRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { profileId: "profile-3", revision: 0 },
			cacheStatus: "unavailable",
		});
		expect(JSON.parse(await readFile(join(cacheRoot, "profile.json"), "utf8"))).toMatchObject({
			profileId: "profile-3",
			revision: 0,
		});
		await symlink("../profile.json", join(cacheRoot, "locks", "writer.lock"));
		await expect(appendMemoryRecord(cacheRoot, signal("profile-3"))).rejects.toThrow("symbolic link");
		expect(JSON.parse(await readFile(join(cacheRoot, "profile.json"), "utf8"))).toMatchObject({ revision: 0 });
	});

	it.skipIf(process.platform === "win32")("leaves a recoverable old profile after a permission failure", async () => {
		const root = join(temporaryDirectory, "profile");
		const created = await createMemoryProfile(root, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		await chmod(root, 0o500);
		try {
			await expect(
				appendMemoryRecord(root, candidate(created.profile.profileId, "candidate-permission")),
			).rejects.toThrow();
		} finally {
			await chmod(root, 0o700);
		}
		const pending = await listPendingMemoryTransactions(root);
		expect(pending).toHaveLength(1);
		await rollbackPreparedMemoryTransaction(root, pending[0] as string);
		await expect(openMemoryProfile(root)).resolves.toMatchObject({ mode: "read-write", profile: { revision: 0 } });
	});

	it("reports cache repair separately from canonical recovery", async () => {
		const root = join(temporaryDirectory, "profile");
		await createMemoryProfile(root, { profileId: "profile-1" });
		await rm(join(root, ...MEMORY_ACTIVE_ITEMS_CACHE_PATH.split("/")));
		await expect(doctorMemoryProfile(root)).resolves.toMatchObject({ status: "healthy", cacheStatus: "stale" });
		await expect(doctorMemoryProfile(root, { repairCache: true })).resolves.toMatchObject({
			status: "healthy",
			cacheStatus: "rebuilt",
			repairs: [MEMORY_ACTIVE_ITEMS_CACHE_PATH],
		});
	});
});
