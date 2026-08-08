// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PreferenceSignalV1 } from "@research-agent/contracts/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AtomicWriteModule from "../../src/project/atomic-write.ts";

const diskFault = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../src/project/atomic-write.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof AtomicWriteModule>();
	return {
		...actual,
		atomicWriteFile: async (path: string, content: string | Uint8Array): Promise<void> => {
			if (diskFault.enabled && basename(path) === "profile.json") {
				throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
			}
			await actual.atomicWriteFile(path, content);
		},
	};
});

import { hashCanonicalJson } from "../../src/contracts/integrity.ts";
import { appendMemoryRecord, createMemoryProfile, openMemoryProfile } from "../../src/memory/store.ts";
import { commitPreparedMemoryTransaction, listPendingMemoryTransactions } from "../../src/memory/transactions.ts";

let temporaryDirectory: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-memory-enospc-"));
});

afterEach(async () => {
	diskFault.enabled = false;
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function signal(profileId: string): PreferenceSignalV1 {
	const now = new Date().toISOString();
	const hash = (value: unknown): `sha256:${string}` => `sha256:${hashCanonicalJson(value).value}`;
	return {
		format: "doro-preference-signal",
		schemaVersion: "1.0.0",
		signalId: "signal-disk-full",
		profileId,
		signalType: "explicit_statement",
		actor: "user",
		observedAt: now,
		category: "writing",
		normalizedKey: "language",
		normalizedValue: "zh-CN",
		scopeCandidate: { level: "global" },
		baseWeight: 1,
		dedupeKey: hash("signal-disk-full"),
		dataClass: "public",
		sourceRefs: [{ kind: "session", locator: "session:disk-full", dataClass: "public" }],
		sourceContentHash: hash("disk-full-source"),
		captureMethod: { type: "deterministic", ruleVersion: "test-v1" },
		trustState: "accepted",
		rejectionCode: null,
		createdAt: now,
	};
}

describe("Personal Memory disk-full recovery", () => {
	it("keeps the old profile and completes the pending transaction after ENOSPC clears", async () => {
		const root = join(temporaryDirectory, "profile");
		const created = await createMemoryProfile(root, { profileId: "profile-1" });
		if (created.mode !== "read-write") throw new Error("expected writable profile");
		diskFault.enabled = true;
		await expect(appendMemoryRecord(root, signal(created.profile.profileId))).rejects.toMatchObject({
			code: "ENOSPC",
		});
		diskFault.enabled = false;
		const pending = await listPendingMemoryTransactions(root);
		expect(pending).toHaveLength(1);
		await expect(openMemoryProfile(root)).resolves.toMatchObject({
			mode: "read-only",
			profile: { revision: 0 },
			pendingTransactions: pending,
		});
		await commitPreparedMemoryTransaction(root, pending[0] as string);
		await expect(openMemoryProfile(root)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 1 },
			counts: { signals: 1 },
		});
	});
});
