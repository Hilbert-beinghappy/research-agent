// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../../../src/contracts/canonical-json.ts";
import { retrievePersonalMemory } from "../../../../src/memory/retrieval.ts";
import { appendMemoryItem, createMemoryProfile } from "../../../../src/memory/store.ts";
import { initializeProject } from "../../../../src/project/init.ts";
import { openProject } from "../../../../src/project/open.ts";
import { itemDraft, retrievalQuery } from "./retrieval-fixtures.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-memory-project-isolation-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Project independent of Personal Memory" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Personal Memory failure isolation from Research Project", () => {
	it("degrades missing and corrupt memory to empty context while Project state remains unchanged", async () => {
		const before = await openProject(projectRoot);
		if (before.mode !== "read-write") throw new Error("expected writable project");
		const missingRoot = join(temporaryDirectory, "private-missing-profile");
		const missing = await retrievePersonalMemory(missingRoot, retrievalQuery());
		expect(missing).toMatchObject({
			status: "unavailable",
			code: "memory_unavailable",
			items: [],
			context: "",
		});
		expect(JSON.stringify(missing)).not.toContain(missingRoot);

		const profileRoot = join(temporaryDirectory, "profile");
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
		await writeFile(join(profileRoot, "items", "writing", "memory-language", "1.json"), "{\n");
		const corrupt = await retrievePersonalMemory(profileRoot, retrievalQuery());
		expect(corrupt).toMatchObject({
			status: "unavailable",
			code: "memory_unavailable",
			items: [],
			context: "",
		});
		expect(JSON.stringify(corrupt)).not.toContain(profileRoot);

		const after = await openProject(projectRoot);
		if (after.mode !== "read-write") throw new Error("expected writable project");
		expect(canonicalStringify(after.manifest)).toBe(canonicalStringify(before.manifest));
	});
});
