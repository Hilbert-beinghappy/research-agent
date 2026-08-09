// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../../../src/contracts/canonical-json.ts";
import { applyMemoryFeedback } from "../../../../src/memory/feedback.ts";
import { MEMORY_RETRIEVAL_INDEX_PATH, retrievePersonalMemory } from "../../../../src/memory/retrieval.ts";
import { appendMemoryItem, createMemoryProfile, openMemoryProfile } from "../../../../src/memory/store.ts";
import { itemDraft, retrievalQuery } from "./retrieval-fixtures.ts";

let temporaryDirectory: string;
let profileRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-correction-atomicity-"));
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

describe("Personal Memory correction and cache atomicity", () => {
	it("atomically supersedes the exact revision and rejects a stale retrieval cache", async () => {
		const before = await retrievePersonalMemory(profileRoot, retrievalQuery());
		expect(before).toMatchObject({ status: "applied", cacheStatus: "rebuilt" });
		expect(before.context).toContain("zh-CN");
		const indexPath = join(profileRoot, ...MEMORY_RETRIEVAL_INDEX_PATH.split("/"));
		expect(await readFile(indexPath, "utf8")).toContain("zh-CN");

		const applied = await applyMemoryFeedback(
			profileRoot,
			{
				feedbackId: "feedback-correct-language",
				target: { memoryId: "memory-language", revision: 1 },
				action: "correct",
				correction: { key: "language", value: "en-US" },
				sourceRef: { kind: "session", locator: "session:correction-1", dataClass: "public" },
				reasonCode: "user-corrected",
				requestedAt: "2026-08-08T12:00:01.000Z",
			},
			{ expectedProfileRevision: 1 },
		);
		expect(applied).toMatchObject({
			item: { memoryId: "memory-language", revision: 2, status: "active", value: "en-US" },
			feedback: {
				applicationStatus: "applied",
				resultingRevision: 2,
				cacheInvalidatedAt: expect.any(String),
			},
		});
		expect(applied.item.transactionId).toBe(applied.transactionId);
		expect(applied.feedback.transactionId).toBe(applied.transactionId);
		expect(await readFile(indexPath, "utf8")).toContain("zh-CN");

		const corrected = await retrievePersonalMemory(profileRoot, retrievalQuery({ now: applied.item.validFrom }));
		expect(corrected).toMatchObject({
			status: "applied",
			cacheStatus: "rebuilt",
			items: [{ memoryId: "memory-language", revision: 2, value: "en-US" }],
		});
		expect(corrected.context).not.toContain("zh-CN");
		expect(corrected.context).toContain("en-US");

		const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") throw new Error("expected writable corrected profile");
		expect(opened.profile).toMatchObject({ revision: 2, lastTransactionId: applied.transactionId });
		expect(opened.counts).toMatchObject({ items: 2, feedback: 1 });
		expect(opened.activeItems).toMatchObject([{ memoryId: "memory-language", revision: 2, value: "en-US" }]);

		await expect(
			applyMemoryFeedback(
				profileRoot,
				{
					feedbackId: "feedback-stale-correction",
					target: { memoryId: "memory-language", revision: 1 },
					action: "correct",
					correction: { key: "language", value: "fr-FR" },
					sourceRef: { kind: "session", locator: "session:correction-stale", dataClass: "public" },
					reasonCode: "stale-target",
					requestedAt: "2026-08-08T12:00:02.000Z",
				},
				{ expectedProfileRevision: 2 },
			),
		).rejects.toThrow("exact latest memory revision");
		const afterRejected = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (afterRejected.mode !== "read-write") throw new Error("expected writable profile after rejected correction");
		expect(afterRejected.profile).toEqual(opened.profile);
		expect(afterRejected.counts).toEqual(opened.counts);
	});

	it("forgets and explicitly restores without exposing the forgotten revision", async () => {
		const forgotten = await applyMemoryFeedback(
			profileRoot,
			{
				feedbackId: "feedback-forget-language",
				target: { memoryId: "memory-language", revision: 1 },
				action: "forget",
				correction: null,
				sourceRef: { kind: "session", locator: "session:forget-1", dataClass: "public" },
				reasonCode: "user-forgot",
				requestedAt: "2026-08-08T12:00:01.000Z",
			},
			{ expectedProfileRevision: 1 },
		);
		expect(forgotten.item).toMatchObject({ revision: 2, status: "forgotten", value: null });
		expect(
			await retrievePersonalMemory(profileRoot, retrievalQuery({ now: forgotten.item.validFrom })),
		).toMatchObject({
			status: "empty",
			code: "no_eligible_items",
			items: [],
			context: "",
		});

		const restored = await applyMemoryFeedback(
			profileRoot,
			{
				feedbackId: "feedback-restore-language",
				target: { memoryId: "memory-language", revision: 2 },
				action: "restore",
				correction: null,
				sourceRef: { kind: "session", locator: "session:restore-1", dataClass: "public" },
				reasonCode: "user-restored",
				requestedAt: "2026-08-08T12:00:02.000Z",
			},
			{ expectedProfileRevision: 2 },
		);
		expect(restored.item).toMatchObject({ revision: 3, status: "active", value: "zh-CN", origin: "explicit" });
		const retrieval = await retrievePersonalMemory(profileRoot, retrievalQuery({ now: restored.item.validFrom }));
		expect(retrieval).toMatchObject({
			status: "applied",
			items: [{ memoryId: "memory-language", revision: 3, value: "zh-CN" }],
		});
		expect(canonicalStringify(retrieval)).not.toContain('"revision":2');
	});

	it("applies deterministic reinforce and downrank revisions", async () => {
		const reinforced = await applyMemoryFeedback(
			profileRoot,
			{
				feedbackId: "feedback-reinforce-language",
				target: { memoryId: "memory-language", revision: 1 },
				action: "reinforce",
				correction: null,
				sourceRef: { kind: "receipt", locator: "receipt:language-1", dataClass: "public" },
				reasonCode: "user-confirmed",
				requestedAt: "2026-08-08T12:00:01.000Z",
			},
			{ expectedProfileRevision: 1 },
		);
		expect(reinforced.item).toMatchObject({
			revision: 2,
			confidence: 1,
			supportCount: 4,
			independentSupportCount: 3,
		});

		const downranked = await applyMemoryFeedback(
			profileRoot,
			{
				feedbackId: "feedback-downrank-language",
				target: { memoryId: "memory-language", revision: 2 },
				action: "downrank",
				correction: null,
				sourceRef: { kind: "session", locator: "session:downrank-1", dataClass: "public" },
				reasonCode: "less-important",
				requestedAt: "2026-08-08T12:00:02.000Z",
			},
			{ expectedProfileRevision: 2 },
		);
		expect(downranked.item).toMatchObject({ revision: 3, confidence: 0.8, status: "active" });
	});

	it("allows explicit rejection only for inferred memory", async () => {
		await appendMemoryItem(
			profileRoot,
			itemDraft("profile-1", "memory-method", {
				category: "method",
				key: "preferred_method_ids",
				value: ["did"],
				allowedEffects: ["ranking"],
				origin: "inferred",
				confidence: 0.9,
			}),
			{ expectedProfileRevision: 1 },
		);
		const rejected = await applyMemoryFeedback(
			profileRoot,
			{
				feedbackId: "feedback-reject-method",
				target: { memoryId: "memory-method", revision: 1 },
				action: "reject",
				correction: null,
				sourceRef: { kind: "session", locator: "session:reject-1", dataClass: "public" },
				reasonCode: "incorrect-inference",
				requestedAt: "2026-08-08T12:00:01.000Z",
			},
			{ expectedProfileRevision: 2 },
		);
		expect(rejected.item).toMatchObject({ memoryId: "memory-method", revision: 2, status: "forgotten", value: null });
		await expect(
			applyMemoryFeedback(
				profileRoot,
				{
					feedbackId: "feedback-reject-explicit",
					target: { memoryId: "memory-language", revision: 1 },
					action: "reject",
					correction: null,
					sourceRef: { kind: "session", locator: "session:reject-2", dataClass: "public" },
					reasonCode: "invalid-action",
					requestedAt: "2026-08-08T12:00:02.000Z",
				},
				{ expectedProfileRevision: 3 },
			),
		).rejects.toThrow("reject applies only to inferred memory");
	});
});
