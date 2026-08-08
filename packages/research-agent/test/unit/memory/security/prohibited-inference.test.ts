// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	consolidateMemorySignals,
	PROHIBITED_INFERENCE_CIRCUIT_BREAKER,
} from "../../../../src/memory/consolidation.ts";
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
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-prohibited-inference-"));
	profileRoot = join(temporaryDirectory, "profile");
	await createMemoryProfile(profileRoot, { profileId: "profile-1" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function canonicalText(root: string): Promise<string> {
	const chunks: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith("._")) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) chunks.push(await readFile(path, "utf8"));
		}
	};
	await walk(root);
	return chunks.join("\n");
}

describe("Personal Memory prohibited inference", () => {
	it("persists zero semantic candidates for protected attributes, diagnosis, credentials, or free rationale", async () => {
		const signal = await captureTestSignal(profileRoot, { sessionId: "source-session" });
		const attacks = [
			{
				term: "political_belief",
				candidate: (request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
					candidateForRequest(request, { key: "political_belief", value: "democrat" }),
			},
			{
				term: "user-is-depressed",
				candidate: (request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
					candidateForRequest(request, { key: "terminology_ids", value: ["user-is-depressed"] }),
			},
			{
				term: "user-is-bipolar",
				candidate: (request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
					candidateForRequest(request, { key: "presentation_style", value: "user-is-bipolar" }),
			},
			{
				term: "api-key",
				candidate: (request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
					candidateForRequest(request, { key: "terminology_ids", value: ["api-key"] }),
			},
			{
				term: "用户抑郁",
				candidate: (request: Parameters<ReturnType<typeof consolidationInput>["invokeModel"]>[0]) =>
					candidateForRequest(request, { key: "terminology_ids", value: ["用户抑郁"] }),
			},
		];

		for (const [index, attack] of attacks.entries()) {
			const ledger = reservationLedger();
			const result = await consolidateMemorySignals(
				consolidationInput(
					profileRoot,
					signal,
					`attack-session-${index}`,
					async (request) => ({ text: JSON.stringify(attack.candidate(request)), costUsd: 0.01 }),
					ledger.reserve,
				),
			);
			expect(result.outcome).toBe("rejected");
			expect(JSON.stringify(result)).not.toContain(attack.term);
		}

		const opened = await openMemoryProfile(profileRoot);
		expect(opened).toMatchObject({ mode: "read-write", counts: { candidates: 0, items: 0 }, activeItems: [] });
		const stored = await canonicalText(profileRoot);
		for (const { term } of attacks) expect(stored).not.toContain(term);
	});

	it("opens the repeated-violation circuit before reserving or invoking another model call", async () => {
		const signal = await captureTestSignal(profileRoot, { sessionId: "source-session" });
		const ledger = reservationLedger();
		const invoke = vi.fn(async (request) => ({ text: JSON.stringify(candidateForRequest(request)), costUsd: 0.01 }));
		const input = consolidationInput(profileRoot, signal, "circuit-session", invoke, ledger.reserve);
		input.priorSecurityViolations = PROHIBITED_INFERENCE_CIRCUIT_BREAKER;
		expect(await consolidateMemorySignals(input)).toMatchObject({
			outcome: "skipped",
			code: "security_circuit_open",
		});
		expect(ledger.ids.size).toBe(0);
		expect(invoke).not.toHaveBeenCalled();
	});
});
