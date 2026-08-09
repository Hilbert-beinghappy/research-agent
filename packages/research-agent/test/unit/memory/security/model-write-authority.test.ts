// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreferenceSignalV1 } from "@research-agent/contracts/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consolidateMemorySignals } from "../../../../src/memory/consolidation.ts";
import { retrievePersonalMemory } from "../../../../src/memory/retrieval.ts";
import { captureExplicitPreferenceInput } from "../../../../src/memory/signals.ts";
import { createMemoryProfile, openMemoryProfile } from "../../../../src/memory/store.ts";
import {
	candidateForRequest,
	captureTestSignal,
	consolidationInput,
	hash,
	reservationLedger,
	sessionRef,
	signalContentRef,
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

async function capturePromotionSignals(value: "table" | "prose"): Promise<PreferenceSignalV1[]> {
	const signals: PreferenceSignalV1[] = [];
	for (const [sessionId, observedAt] of [
		["support-1", "2026-08-01T12:00:00.000Z"],
		["support-2", "2026-08-02T12:00:00.000Z"],
		["support-3", "2026-08-02T13:00:00.000Z"],
	] as const) {
		signals.push(await captureTestSignal(profileRoot, { sessionId, observedAt, key: "representation", value }));
	}
	return signals;
}

async function consolidateCandidate(signal: PreferenceSignalV1, sessionId: string, beforeModel?: () => Promise<void>) {
	const ledger = reservationLedger();
	return consolidateMemorySignals(
		consolidationInput(
			profileRoot,
			signal,
			sessionId,
			async (request) => {
				await beforeModel?.();
				return { text: JSON.stringify(candidateForRequest(request)), costUsd: 0.01 };
			},
			ledger.reserve,
		),
	);
}

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
		const result = await consolidateCandidate(signal, "inference-session");
		expect(result).toMatchObject({
			outcome: "persisted",
			candidate: { format: "doro-memory-candidate-draft" },
			promotion: { disposition: "candidate", supportCount: 1 },
			item: null,
		});
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({
			mode: "read-write",
			counts: { candidates: 1, items: 0 },
			activeItems: [],
			profile: { preferenceRefs: {} },
		});
	});

	it("atomically activates eligible inferred memory and continues its revision chain", async () => {
		const signals = await capturePromotionSignals("table");
		const first = await consolidateCandidate(signals[0], "inference-1");
		expect(first).toMatchObject({
			outcome: "persisted",
			promotion: { disposition: "eligible", supportCount: 3, contradictionCount: 0 },
			item: {
				revision: 1,
				previousRevision: null,
				status: "active",
				origin: "inferred",
				supportCount: 3,
				independentSupportCount: 3,
			},
		});
		if (first.outcome !== "persisted" || first.item === null) throw new Error("eligible memory was not activated");
		expect(first.item.transactionId).toBe(first.transactionId);
		expect(first.item.sourceSignalRefs).toHaveLength(3);

		const additional = await captureTestSignal(profileRoot, {
			sessionId: "support-4",
			observedAt: "2026-08-03T12:00:00.000Z",
			key: "representation",
			value: "table",
		});
		const second = await consolidateCandidate(additional, "inference-2");
		expect(second).toMatchObject({
			outcome: "persisted",
			promotion: { disposition: "eligible", supportCount: 4 },
			item: {
				memoryId: first.item.memoryId,
				revision: 2,
				previousRevision: 1,
				supersedes: [{ memoryId: first.item.memoryId, revision: 1 }],
			},
		});
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({
			mode: "read-write",
			counts: { candidates: 2, items: 2 },
			activeItems: [{ memoryId: first.item.memoryId, revision: 2, origin: "inferred" }],
			profile: { preferenceRefs: { writing: [{ memoryId: first.item.memoryId, revision: 2 }] } },
		});
	});

	it("atomically quarantines active inferred memory when canonical evidence contradicts it", async () => {
		const signals = await capturePromotionSignals("table");
		const activated = await consolidateCandidate(signals[0], "activation-inference");
		if (activated.outcome !== "persisted" || activated.item === null) {
			throw new Error("eligible memory was not activated");
		}
		const contradiction = await captureTestSignal(profileRoot, {
			sessionId: "contradiction",
			observedAt: "2026-08-03T12:00:00.000Z",
			key: "representation",
			value: "prose",
		});
		const result = await consolidateCandidate(contradiction, "contradiction-inference");
		expect(result).toMatchObject({
			outcome: "persisted",
			promotion: { disposition: "quarantined", supportCount: 1, contradictionCount: 3 },
			item: {
				memoryId: activated.item.memoryId,
				revision: 2,
				previousRevision: 1,
				status: "quarantined",
				value: "table",
				allowedEffects: [],
				supportCount: 3,
				contradictionCount: 1,
			},
		});
		if (result.outcome !== "persisted" || result.item === null) throw new Error("inferred item was not quarantined");
		expect(result.item.transactionId).toBe(result.transactionId);
		expect(result.item.provenanceHash).toBe(
			hash({
				previousProvenanceHash: activated.item.provenanceHash,
				candidateHash: hash(result.candidate),
				contradictionSignalRefs: [signalContentRef(contradiction)],
				memoryId: result.item.memoryId,
				revision: result.item.revision,
				value: result.item.value,
				scope: result.item.scope,
				dataClass: result.item.dataClass,
				allowedEffects: result.item.allowedEffects,
				sourceSignalRefs: result.item.sourceSignalRefs,
				generator: result.item.generator,
			}),
		);
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({
			mode: "read-write",
			counts: { candidates: 2, items: 2 },
			activeItems: [],
			profile: { preferenceRefs: {}, lastTransactionId: result.transactionId },
		});
		expect(
			await retrievePersonalMemory(profileRoot, {
				taskCategories: ["writing"],
				keywords: ["representation"],
				effect: "formatting",
				allowedDataClasses: ["public", "internal"],
				criticalDecision: false,
				availableContextTokens: 20_000,
				requestedMaxTokens: 800,
				now: "2026-08-04T12:00:00.000Z",
			}),
		).toMatchObject({ status: "empty", code: "no_eligible_items", items: [] });
	});

	it("quarantines inferred memory after its historical support signals leave canonical state", async () => {
		const historicalSignals = await capturePromotionSignals("table");
		const activated = await consolidateCandidate(historicalSignals[0], "historical-activation");
		if (activated.outcome !== "persisted" || activated.item === null) {
			throw new Error("eligible memory was not activated");
		}
		await Promise.all(
			historicalSignals.map((signal) =>
				rm(
					join(
						profileRoot,
						"signals",
						signal.createdAt.slice(0, 4),
						signal.createdAt.slice(5, 7),
						`${signal.signalId}.json`,
					),
				),
			),
		);

		const currentSignals = await capturePromotionSignals("prose");
		const result = await consolidateCandidate(currentSignals[0], "retention-contradiction");
		expect(result).toMatchObject({
			outcome: "persisted",
			promotion: {
				disposition: "quarantined",
				supportCount: 3,
				contradictionCount: 0,
				reasonCodes: expect.arrayContaining(["inferred_item_conflict"]),
			},
			item: {
				memoryId: activated.item.memoryId,
				revision: 2,
				status: "quarantined",
				value: "table",
				supportCount: 3,
				independentSupportCount: 3,
				contradictionCount: 3,
				confidence: 0,
				allowedEffects: [],
				sourceSignalRefs: expect.arrayContaining(activated.item.sourceSignalRefs),
			},
		});
		if (result.outcome !== "persisted" || result.item === null) throw new Error("inferred item was not quarantined");
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({
			mode: "read-write",
			counts: { candidates: 2, items: 2 },
			activeItems: [],
			profile: { preferenceRefs: {}, lastTransactionId: result.transactionId },
		});
	});

	it("keeps an eligible same-value candidate subordinate to active explicit memory", async () => {
		const explicit = await captureExplicitPreferenceInput(profileRoot, {
			text: "请记住我的长期偏好: 默认用表格",
			inputSource: "interactive",
			hasAttachments: false,
			observedAt: "2026-08-01T09:00:00.000Z",
			sourceRefs: [sessionRef("explicit-source")],
		});
		expect(explicit.outcome).toBe("persisted");
		const signals = await capturePromotionSignals("table");
		const result = await consolidateCandidate(signals[0], "same-explicit-inference");
		expect(result).toMatchObject({
			outcome: "persisted",
			promotion: { disposition: "candidate", reasonCodes: expect.arrayContaining(["explicit_item_already_active"]) },
			item: null,
		});
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({
			mode: "read-write",
			counts: { candidates: 1, items: 1 },
			activeItems: [{ origin: "explicit", value: "table", revision: 1 }],
		});
	});

	it("rechecks canonical state under the writer lease before activation", async () => {
		const signals = await capturePromotionSignals("prose");
		const result = await consolidateCandidate(signals[0], "concurrent-explicit-inference", async () => {
			const explicit = await captureExplicitPreferenceInput(profileRoot, {
				text: "请记住我的长期偏好: 默认用表格",
				inputSource: "interactive",
				hasAttachments: false,
				observedAt: "2026-08-03T09:00:00.000Z",
				sourceRefs: [sessionRef("concurrent-explicit")],
			});
			expect(explicit.outcome).toBe("persisted");
		});
		expect(result).toMatchObject({
			outcome: "persisted",
			promotion: {
				disposition: "quarantined",
				reasonCodes: expect.arrayContaining(["contradiction_present", "explicit_item_conflict"]),
			},
			item: null,
		});
		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({
			mode: "read-write",
			counts: { candidates: 1, items: 1 },
			activeItems: [{ origin: "explicit", value: "table" }],
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
