// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SafeRef } from "@research-agent/contracts/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalStringify } from "../../../../src/contracts/canonical-json.ts";
import { hashCanonicalJson } from "../../../../src/contracts/integrity.ts";
import { registerMemorySignalCapture } from "../../../../src/extension/memory-capture.ts";
import { memoryProfileRoot } from "../../../../src/memory/layout.ts";
import { captureExplicitPreferenceInput } from "../../../../src/memory/signals.ts";
import { createMemoryProfile, loadCanonicalMemoryState, openMemoryProfile } from "../../../../src/memory/store.ts";
import { initializeProject } from "../../../../src/project/init.ts";
import { openProject } from "../../../../src/project/open.ts";

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
		sessionManager: { getSessionId: () => "no-memory-session", getLeafId: () => "turn-1" },
		ui: { setStatus },
	} as unknown as ExtensionContext;
	return {
		setStatus,
		emit: async () => {
			const event = {
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: "v2.0.1-system-prompt",
				systemPromptOptions: {},
			};
			const results = [];
			for (const handler of handlers.get("before_agent_start") ?? []) results.push(await handler(event, context));
			return results;
		},
	};
}

afterEach(() => vi.unstubAllEnvs());

describe("no-memory runtime regression", () => {
	it("makes off and invalid modes equivalent to an absent profile without changing Project or Memory state", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-no-memory-"));
		try {
			const doroHome = join(temporaryDirectory, "doro");
			const profileRoot = memoryProfileRoot(doroHome, "profile-1");
			await createMemoryProfile(profileRoot, { profileId: "profile-1" });
			const sourceRef: SafeRef = {
				kind: "session",
				locator: "session:no-memory-fixture",
				contentHash: `sha256:${hashCanonicalJson("no-memory-fixture").value}`,
				dataClass: "public",
			};
			const captured = await captureExplicitPreferenceInput(profileRoot, {
				text: "请记住我的长期偏好：默认用中文",
				inputSource: "interactive",
				hasAttachments: false,
				observedAt: "2026-08-08T00:00:00.000Z",
				sourceRefs: [sourceRef],
			});
			expect(captured.outcome).toBe("persisted");

			const projectRoot = join(temporaryDirectory, "project");
			await initializeProject(projectRoot, { title: "No-memory regression" });
			const projectBefore = await openProject(projectRoot);
			const memoryBefore = await openMemoryProfile(profileRoot, { rebuildCache: false });
			if (memoryBefore.mode !== "read-write") throw new Error("expected writable profile");
			const canonicalMemoryBefore = canonicalStringify({
				profile: memoryBefore.profile,
				state: await loadCanonicalMemoryState(profileRoot, memoryBefore.profile),
			});
			const harness = runtimeHarness(projectRoot);

			vi.stubEnv("DORO_HOME", doroHome);
			vi.stubEnv("DORO_MEMORY_MODE", "off");
			const off = await harness.emit();
			vi.stubEnv("DORO_MEMORY_MODE", "unexpected");
			const invalid = await harness.emit();
			vi.stubEnv("DORO_HOME", join(temporaryDirectory, "absent-doro"));
			vi.stubEnv("DORO_MEMORY_MODE", "on");
			const absent = await harness.emit();

			expect(off).toEqual([undefined]);
			expect(invalid).toEqual(absent);
			expect(harness.setStatus).not.toHaveBeenCalled();
			expect(canonicalStringify((await openProject(projectRoot)).manifest)).toBe(
				canonicalStringify(projectBefore.manifest),
			);
			const memoryAfter = await openMemoryProfile(profileRoot, { rebuildCache: false });
			if (memoryAfter.mode !== "read-write") throw new Error("expected writable profile");
			expect(
				canonicalStringify({
					profile: memoryAfter.profile,
					state: await loadCanonicalMemoryState(profileRoot, memoryAfter.profile),
				}),
			).toBe(canonicalMemoryBefore);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
