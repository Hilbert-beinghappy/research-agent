// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consolidateMemorySignals } from "../../../../src/memory/consolidation.ts";
import { createMemoryProfile, openMemoryProfile } from "../../../../src/memory/store.ts";
import {
	candidateForRequest,
	captureTestSignal,
	consolidationInput,
	reservationLedger,
} from "./consolidation-fixtures.ts";

let temporaryDirectory: string;
let profileRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-model-authority-"));
	profileRoot = join(temporaryDirectory, "profile");
	await createMemoryProfile(profileRoot, { profileId: "profile-1" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Personal Memory model write authority", () => {
	it("rejects model-authored item fields without exposing a profile path", async () => {
		const signal = await captureTestSignal(profileRoot, { sessionId: "source-session" });
		const ledger = reservationLedger();
		const invoke = vi.fn(async (request) => {
			const visible = JSON.stringify(request);
			expect(visible).not.toContain(profileRoot);
			expect(visible).not.toContain("sourceRefs");
			return {
				text: JSON.stringify({ ...candidateForRequest(request), memoryItem: { status: "active" } }),
				costUsd: 0.01,
			};
		});
		const result = await consolidateMemorySignals(
			consolidationInput(profileRoot, signal, "inference-session", invoke, ledger.reserve),
		);
		expect(result).toMatchObject({ outcome: "rejected", code: "invalid_schema" });
		expect(invoke).toHaveBeenCalledTimes(1);
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({ mode: "read-write", counts: { candidates: 0, items: 0 }, activeItems: [] });
	});

	it("persists a valid model draft only as a non-active candidate", async () => {
		const signal = await captureTestSignal(profileRoot, { sessionId: "source-session" });
		const ledger = reservationLedger();
		const result = await consolidateMemorySignals(
			consolidationInput(
				profileRoot,
				signal,
				"inference-session",
				async (request) => ({ text: JSON.stringify(candidateForRequest(request)), costUsd: 0.01 }),
				ledger.reserve,
			),
		);
		expect(result).toMatchObject({
			outcome: "persisted",
			candidate: { format: "doro-memory-candidate-draft" },
			promotion: { disposition: "candidate", supportCount: 1 },
		});
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({
			mode: "read-write",
			counts: { candidates: 1, items: 0 },
			activeItems: [],
			profile: { preferenceRefs: {} },
		});
	});

	it("reserves one attempt before invocation and hard-blocks repeats, budget excess, and timeout", async () => {
		const signal = await captureTestSignal(profileRoot, { sessionId: "source-session" });
		const ledger = reservationLedger();
		const invoke = vi.fn(
			async (_request, abortSignal): Promise<{ text: string; costUsd: number }> =>
				new Promise((_resolve, reject) => {
					abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const firstInput = consolidationInput(profileRoot, signal, "one-call-session", invoke, ledger.reserve);
		firstInput.timeoutMs = 10;
		expect(await consolidateMemorySignals(firstInput)).toMatchObject({ outcome: "failed", code: "model_timeout" });
		expect(ledger.ids.size).toBe(1);
		expect(invoke).toHaveBeenCalledTimes(1);

		const repeated = consolidationInput(profileRoot, signal, "one-call-session", invoke, ledger.reserve);
		repeated.sessionRef = { ...repeated.sessionRef, revision: 1 };
		expect(await consolidateMemorySignals(repeated)).toMatchObject({
			outcome: "skipped",
			code: "inference_already_attempted",
		});
		expect(invoke).toHaveBeenCalledTimes(1);

		const overBudget = consolidationInput(profileRoot, signal, "budget-session", invoke, ledger.reserve);
		overBudget.estimatedCostUsd = 0.051;
		expect(await consolidateMemorySignals(overBudget)).toMatchObject({ outcome: "skipped", code: "budget_exceeded" });
		expect(ledger.ids.size).toBe(1);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid JSON, extra fields, missing provenance, and scope expansion", async () => {
		const signal = await captureTestSignal(profileRoot, { sessionId: "source-session" });
		const outputs = [
			(_request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) => "{",
			(request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
				JSON.stringify({ ...candidateForRequest(request), unexpected: true }),
			(request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
				JSON.stringify(candidateForRequest(request, { sourceSignalRefs: [] })),
			(request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
				JSON.stringify(
					candidateForRequest(request, {
						proposedScope: { level: "project", projectId: "invented-project" },
					}),
				),
			(request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
				JSON.stringify(candidateForRequest(request, { proposedEffects: ["recommendation"] })),
		];
		const expectedCodes = ["invalid_json", "invalid_schema", "invalid_schema", "scope_violation", "effect_violation"];
		for (const [index, output] of outputs.entries()) {
			const ledger = reservationLedger();
			const result = await consolidateMemorySignals(
				consolidationInput(
					profileRoot,
					signal,
					`invalid-session-${index}`,
					async (request) => ({ text: output(request), costUsd: 0.01 }),
					ledger.reserve,
				),
			);
			expect(result).toMatchObject({ outcome: "rejected", code: expectedCodes[index] });
		}
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({ mode: "read-write", counts: { candidates: 0, items: 0 } });
	});
});
