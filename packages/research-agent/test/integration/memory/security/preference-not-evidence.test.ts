// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../../../src/contracts/canonical-json.ts";
import { MEMORY_CONTEXT_LABEL, retrievePersonalMemory } from "../../../../src/memory/retrieval.ts";
import { appendMemoryItem, createMemoryProfile } from "../../../../src/memory/store.ts";
import { initializeProject } from "../../../../src/project/init.ts";
import { openProject } from "../../../../src/project/open.ts";
import { itemDraft, retrievalQuery } from "./retrieval-fixtures.ts";

let temporaryDirectory: string;
let profileRoot: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-preference-not-evidence-"));
	profileRoot = join(temporaryDirectory, "profile");
	projectRoot = join(temporaryDirectory, "project");
	const created = await createMemoryProfile(profileRoot, { profileId: "profile-1" });
	if (created.mode !== "read-write") throw new Error("expected writable profile");
	await appendMemoryItem(
		profileRoot,
		itemDraft(created.profile.profileId, "memory-method-ranking", {
			category: "method",
			key: "preferred_method_ids",
			value: ["did"],
			allowedEffects: ["ranking", "recommendation"],
			confidence: 0.95,
		}),
		{ expectedProfileRevision: 0 },
	);
	await initializeProject(projectRoot, { title: "Independent research project" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Personal Memory preference-not-evidence boundary", () => {
	it("blocks executable critical-decision defaults and emits only labelled rank-only context", async () => {
		const before = await openProject(projectRoot);
		if (before.mode !== "read-write") throw new Error("expected writable project");
		const denied = await retrievePersonalMemory(
			profileRoot,
			retrievalQuery({
				projectId: before.manifest.projectId,
				taskCategories: ["method"],
				effect: "recommendation",
				criticalDecision: true,
			}),
		);
		expect(denied).toMatchObject({
			status: "blocked",
			code: "critical_decision_memory_denied",
			items: [],
			context: "",
		});

		const ranked = await retrievePersonalMemory(
			profileRoot,
			retrievalQuery({
				projectId: before.manifest.projectId,
				taskCategories: ["method"],
				effect: "ranking",
				criticalDecision: true,
			}),
		);
		expect(ranked).toMatchObject({
			status: "applied",
			code: "ok",
			items: [
				{
					memoryId: "memory-method-ranking",
					category: "method",
					effect: "ranking",
					authority: "preference_only",
					evidenceUse: "forbidden",
					decisionUse: "rank_only",
				},
			],
		});
		expect(ranked.context.startsWith(MEMORY_CONTEXT_LABEL)).toBe(true);
		expect(ranked.context).toContain('method.preferred_method_ids=["did"]');
		expect(ranked.context).not.toContain("evidenceLevel");
		expect(ranked.context).not.toContain("sourceSignalRefs");
		expect(ranked.estimatedTokens).toBeLessThanOrEqual(ranked.tokenBudget);

		const after = await openProject(projectRoot);
		if (after.mode !== "read-write") throw new Error("expected writable project");
		expect(canonicalStringify(after.manifest)).toBe(canonicalStringify(before.manifest));
	});
});
