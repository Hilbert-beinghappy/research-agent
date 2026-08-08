// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBytes } from "../../../src/contracts/integrity.ts";
import { retrievePersonalMemoryForUse } from "../../../src/memory/receipts.ts";
import { appendMemoryItem, createMemoryProfile, openMemoryProfile } from "../../../src/memory/store.ts";
import { itemDraft, retrievalQuery } from "./security/retrieval-fixtures.ts";

let temporaryDirectory: string;
let profileRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-memory-receipt-"));
	profileRoot = join(temporaryDirectory, "profile");
	const created = await createMemoryProfile(profileRoot, { profileId: "profile-1" });
	if (created.mode !== "read-write") throw new Error("expected writable profile");
	await appendMemoryItem(
		profileRoot,
		itemDraft(created.profile.profileId, "memory-language", {
			category: "writing",
			key: "language",
			value: "zh-CN",
			allowedEffects: ["formatting"],
		}),
		{ expectedProfileRevision: 0 },
	);
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Personal Memory use receipts", () => {
	it("persists exact item revisions and a context digest without the preference value or full context", async () => {
		const result = await retrievePersonalMemoryForUse(profileRoot, retrievalQuery(), {
			receiptId: "receipt-language-1",
			sessionRef: { kind: "session", locator: "session:receipt-1", dataClass: "public" },
			taskRef: { kind: "task", locator: "task:receipt-1", dataClass: "public" },
			decisionCodeBefore: "default-format",
			decisionCodeAfter: "preferred-format",
			explanationCodes: ["explicit-preference"],
			criticalResearchDecisionTouched: false,
			approvalRequired: false,
			appliedAt: "2026-08-08T12:00:01.000Z",
		});
		expect(result.retrieval.status).toBe("applied");
		expect(result.receipt).toMatchObject({
			receiptId: "receipt-language-1",
			itemRefs: [{ memoryId: "memory-language", revision: 1 }],
			effect: "formatting",
			explanationCodes: ["explicit-preference"],
			addedContextTokens: result.retrieval.estimatedTokens,
			outcome: "applied",
		});
		expect(result.receipt?.contextDigest).toBe(`sha256:${hashBytes(result.retrieval.context).value}`);

		const receiptPath = join(profileRoot, "receipts", "2026", "08", "receipt-language-1.json");
		const receiptText = await readFile(receiptPath, "utf8");
		expect(receiptText).not.toContain("zh-CN");
		expect(receiptText).not.toContain(result.retrieval.context);

		const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") throw new Error("expected writable profile with receipt");
		expect(opened.profile.revision).toBe(2);
		expect(opened.counts.receipts).toBe(1);
		expect(opened.activeItems).toMatchObject([{ memoryId: "memory-language", revision: 1, value: "zh-CN" }]);
	});

	it("does not mutate the profile when explanation coverage is missing", async () => {
		const before = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (before.mode !== "read-write") throw new Error("expected writable profile");
		await expect(
			retrievePersonalMemoryForUse(profileRoot, retrievalQuery(), {
				receiptId: "receipt-invalid",
				sessionRef: { kind: "session", locator: "session:receipt-2", dataClass: "public" },
				taskRef: { kind: "task", locator: "task:receipt-2", dataClass: "public" },
				decisionCodeBefore: "default-format",
				decisionCodeAfter: "preferred-format",
				explanationCodes: [],
				criticalResearchDecisionTouched: false,
				approvalRequired: false,
				appliedAt: "2026-08-08T12:00:01.000Z",
			}),
		).rejects.toThrow("at least one explanation code");
		const after = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (after.mode !== "read-write") throw new Error("expected writable profile");
		expect(after.profile).toEqual(before.profile);
		expect(after.counts.receipts).toBe(0);
	});
});
