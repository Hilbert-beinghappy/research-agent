// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataClass, MemoryItemV1 } from "@research-agent/contracts/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../../../src/contracts/canonical-json.ts";
import { hashBytes } from "../../../../src/contracts/integrity.ts";
import {
	MEMORY_CONTEXT_LABEL,
	MEMORY_RETRIEVAL_INDEX_HASH_PATH,
	MEMORY_RETRIEVAL_INDEX_PATH,
	rankActiveMemoryItems,
	retrievePersonalMemory,
} from "../../../../src/memory/retrieval.ts";
import { appendMemoryItem, createMemoryProfile } from "../../../../src/memory/store.ts";
import { itemDraft, retrievalQuery } from "./retrieval-fixtures.ts";

let temporaryDirectory: string;
let profileRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-retrieval-isolation-"));
	profileRoot = join(temporaryDirectory, "profile");
	const created = await createMemoryProfile(profileRoot, { profileId: "profile-1" });
	if (created.mode !== "read-write") throw new Error("expected writable profile");
	const items = [
		itemDraft(created.profile.profileId, "memory-global-language", {
			category: "writing",
			key: "language",
			value: "zh-CN",
			allowedEffects: ["formatting", "prompt_context"],
		}),
		itemDraft(created.profile.profileId, "memory-project-a", {
			category: "output",
			key: "presentation_style",
			value: "project-a-secret-format",
			scope: { level: "project", projectId: "project-a" },
			dataClass: "internal",
			allowedEffects: ["formatting"],
		}),
		itemDraft(created.profile.profileId, "memory-project-b", {
			category: "output",
			key: "presentation_style",
			value: "project-b-safe-format",
			scope: { level: "project", projectId: "project-b" },
			dataClass: "internal",
			allowedEffects: ["formatting"],
		}),
	];
	for (const [index, item] of items.entries()) {
		await appendMemoryItem(profileRoot, item, { expectedProfileRevision: index });
	}
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Personal Memory restricted cross-project isolation", () => {
	it("rechecks canonical scope after cache lookup and never injects another Project's value", async () => {
		const first = await retrievePersonalMemory(profileRoot, retrievalQuery({ projectId: "project-b" }));
		expect(first).toMatchObject({
			status: "applied",
			code: "ok",
			cacheStatus: "rebuilt",
			items: [
				{ memoryId: "memory-project-b", scope: "project", authority: "preference_only" },
				{ memoryId: "memory-global-language", scope: "global", authority: "preference_only" },
			],
		});
		expect(first.context.startsWith(MEMORY_CONTEXT_LABEL)).toBe(true);
		expect(first.context).toContain("project-b-safe-format");
		expect(first.context).not.toContain("project-a-secret-format");

		const indexPath = join(profileRoot, ...MEMORY_RETRIEVAL_INDEX_PATH.split("/"));
		const index = JSON.parse(await readFile(indexPath, "utf8")) as { items: Array<Record<string, unknown>> };
		const projectB = index.items.find(({ memoryId }) => memoryId === "memory-project-b");
		if (projectB === undefined) throw new Error("missing project B cache entry");
		projectB.value = "project-a-secret-format";
		await writeFile(indexPath, `${canonicalStringify(index)}\n`);

		const rebuilt = await retrievePersonalMemory(profileRoot, retrievalQuery({ projectId: "project-b" }));
		expect(rebuilt).toMatchObject({ status: "applied", cacheStatus: "rebuilt" });
		expect(rebuilt.context).toContain("project-b-safe-format");
		expect(rebuilt.context).not.toContain("project-a-secret-format");

		const maliciousIndex = JSON.parse(await readFile(indexPath, "utf8")) as {
			items: Array<Record<string, unknown>>;
		};
		const maliciousProjectB = maliciousIndex.items.find(({ memoryId }) => memoryId === "memory-project-b");
		if (maliciousProjectB === undefined) throw new Error("missing project B cache entry");
		maliciousProjectB.value = "project-a-secret-format";
		const maliciousText = `${canonicalStringify(maliciousIndex)}\n`;
		await writeFile(indexPath, maliciousText);
		await writeFile(
			join(profileRoot, ...MEMORY_RETRIEVAL_INDEX_HASH_PATH.split("/")),
			`sha256:${hashBytes(maliciousText).value}\n`,
		);

		const rejected = await retrievePersonalMemory(profileRoot, retrievalQuery({ projectId: "project-b" }));
		expect(rejected).toMatchObject({
			status: "unavailable",
			code: "canonical_recheck_failed",
			items: [],
			context: "",
		});
		expect(JSON.stringify(rejected)).not.toContain("project-a-secret-format");
	});

	it("covers 100,000 deterministic scope and data-class combinations with zero leakage", () => {
		const template = itemDraft("profile-1", "memory-template", {
			category: "output",
			key: "presentation_style",
			value: "table",
			scope: { level: "project", projectId: "project-0" },
			allowedEffects: ["formatting"],
		}) as MemoryItemV1;
		const classes: DataClass[] = ["public", "internal", "restricted"];
		let state = 1_592_598_566;
		let failures = 0;
		for (let index = 0; index < 100_000; index += 1) {
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
			const itemProject = `project-${state % 64}`;
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
			const queryProject = `project-${state % 64}`;
			const dataClass = classes[(state >>> 8) % classes.length] as DataClass;
			const allowedDataClasses = classes.filter((_value, classIndex) => ((state >>> classIndex) & 1) === 1);
			if (allowedDataClasses.length === 0) allowedDataClasses.push("public");
			const item: MemoryItemV1 = {
				...template,
				memoryId: `memory-${index}`,
				scope: { level: "project", projectId: itemProject },
				dataClass,
			};
			const selected = rankActiveMemoryItems(
				[item],
				retrievalQuery({ projectId: queryProject, allowedDataClasses }),
			);
			const expected = itemProject === queryProject && allowedDataClasses.includes(dataClass);
			if ((selected.length === 1) !== expected) failures += 1;
		}
		expect(failures).toBe(0);
	});
});
