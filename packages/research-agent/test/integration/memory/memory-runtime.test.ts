// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalStringify } from "../../../src/contracts/canonical-json.ts";
import { registerMemorySignalCapture } from "../../../src/extension/memory-capture.ts";
import { memoryProfileRoot } from "../../../src/memory/layout.ts";
import { createMemoryProfile, loadCanonicalMemoryState, openMemoryProfile } from "../../../src/memory/store.ts";
import { initializeProject } from "../../../src/project/init.ts";
import { openProject } from "../../../src/project/open.ts";
import { commitProjectTransaction } from "../../../src/project/transactions.ts";

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

function runtimeHarness(cwd: string) {
	const handlers = new Map<string, EventHandler[]>();
	const setStatus = vi.fn();
	const pi = {
		on(event: string, handler: EventHandler): void {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;
	registerMemorySignalCapture(pi);
	const context = {
		cwd,
		model: {
			id: "test-model",
			provider: "openai",
			baseUrl: "https://api.example.test/v1",
			contextWindow: 20_000,
		},
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 20_000, percent: 5 }),
		sessionManager: {
			getSessionId: () => "pi-session-1",
			getLeafId: () => "user-turn-1",
		},
		ui: { setStatus },
	} as unknown as ExtensionContext;
	return {
		context,
		setStatus,
		emit: async (event: string, value: Record<string, unknown>) => {
			const results = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(value, context));
			return results;
		},
	};
}

describe("Personal Memory runtime", () => {
	let temporaryDirectory: string;
	let profileRoot: string;

	beforeEach(async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-memory-runtime-"));
		const doroHome = join(temporaryDirectory, "doro");
		profileRoot = memoryProfileRoot(doroHome, "profile-1");
		await createMemoryProfile(profileRoot, { profileId: "profile-1" });
		vi.stubEnv("DORO_HOME", doroHome);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(temporaryDirectory, { recursive: true, force: true });
	});

	it("activates an allowlisted explicit preference and applies it with an exact-revision receipt", async () => {
		const harness = runtimeHarness(temporaryDirectory);
		await harness.emit("input", {
			type: "input",
			text: "请记住我的长期偏好：默认用中文",
			source: "interactive",
		});
		const activated = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (activated.mode !== "read-write") throw new Error("expected writable profile");
		expect(activated).toMatchObject({
			profile: { revision: 2 },
			counts: { signals: 1, items: 1, receipts: 0 },
			activeItems: [{ revision: 1, category: "writing", key: "language", value: "zh-CN" }],
		});

		const results = await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "Draft the findings.",
			systemPrompt: "base",
			systemPromptOptions: {},
		});
		expect(results).toMatchObject([
			{
				systemPrompt: expect.stringContaining('writing.language="zh-CN"'),
			},
		]);

		const applied = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (applied.mode !== "read-write") throw new Error("expected writable profile");
		const state = await loadCanonicalMemoryState(profileRoot, applied.profile);
		expect(applied.profile.revision).toBe(3);
		expect(state.receipts).toMatchObject([
			{
				effect: "formatting",
				itemRefs: [{ memoryId: activated.activeItems[0]?.memoryId, revision: 1 }],
				explanationCodes: ["memory.preference_applied"],
				criticalResearchDecisionTouched: false,
			},
		]);
		expect(JSON.stringify(state.receipts)).not.toContain("Draft the findings.");
		expect(JSON.stringify(state.receipts)).not.toContain("pi-session-1");
		expect(harness.setStatus).toHaveBeenLastCalledWith("research-memory", "memory: active");
	});

	it("fails closed to the unchanged system prompt when canonical memory is corrupt", async () => {
		const harness = runtimeHarness(temporaryDirectory);
		await harness.emit("input", {
			type: "input",
			text: "请记住我的长期偏好：默认用中文",
			source: "interactive",
		});
		const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") throw new Error("expected writable profile");
		const item = opened.activeItems[0];
		if (item === undefined) throw new Error("expected active item");
		await writeFile(join(profileRoot, "items", item.category, item.memoryId, `${item.revision}.json`), "{\n");

		const results = await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "continue",
			systemPrompt: "base",
			systemPromptOptions: {},
		});
		expect(results).toEqual([undefined]);
		expect(harness.setStatus).toHaveBeenLastCalledWith("research-memory", "memory: degraded");
	});

	it("supersedes the active revision when the user states a different explicit value", async () => {
		const harness = runtimeHarness(temporaryDirectory);
		for (const text of ["请记住我的长期偏好：默认用中文", "请记住我的长期偏好：默认用英文"]) {
			await harness.emit("input", { type: "input", text, source: "interactive" });
		}
		const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") throw new Error("expected writable profile");
		expect(opened).toMatchObject({
			profile: { revision: 4 },
			counts: { signals: 2, items: 2 },
			activeItems: [
				{
					revision: 2,
					previousRevision: 1,
					value: "en",
					supersedes: [{ revision: 1 }],
				},
			],
		});
	});

	it("does not apply or receipt memory when project policy blocks external model egress", async () => {
		const captureHarness = runtimeHarness(temporaryDirectory);
		await captureHarness.emit("input", {
			type: "input",
			text: "请记住我的长期偏好：默认用中文",
			source: "interactive",
		});
		const projectRoot = join(temporaryDirectory, "project");
		const initialized = await initializeProject(projectRoot, { title: "Memory egress fixture" });
		if (initialized.compatibility !== "current") throw new Error("expected current project");
		await commitProjectTransaction(projectRoot, {
			expectedRevision: initialized.manifest.revision,
			writes: [],
			manifest: {
				...initialized.manifest,
				policy: { ...initialized.manifest.policy, modelEgressAllowed: false },
				revision: initialized.manifest.revision + 1,
				updatedAt: new Date().toISOString(),
			},
		});
		const projectBefore = await openProject(projectRoot);
		const harness = runtimeHarness(projectRoot);
		const results = await harness.emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "continue",
			systemPrompt: "base",
			systemPromptOptions: {},
		});
		expect(results).toEqual([undefined]);
		const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") throw new Error("expected writable profile");
		expect(opened.counts.receipts).toBe(0);
		expect(canonicalStringify((await openProject(projectRoot)).manifest)).toBe(
			canonicalStringify(projectBefore.manifest),
		);
	});
});
