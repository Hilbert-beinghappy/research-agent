// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafeRef } from "@research-agent/contracts/memory";
import { describe, expect, it } from "vitest";
import { hashCanonicalJson } from "../../../../src/contracts/integrity.ts";
import { memoryProfileRoot } from "../../../../src/memory/layout.ts";
import { captureExplicitPreferenceInput, type SignalCaptureResult } from "../../../../src/memory/signals.ts";
import { createMemoryProfile, openMemoryProfile } from "../../../../src/memory/store.ts";

type DiscardCode = Extract<SignalCaptureResult, { outcome: "discarded" }>["code"];
type InputSource = "interactive" | "rpc" | "extension";

interface PoisoningCase {
	id: string;
	inputSource: InputSource;
	hasAttachments: boolean;
	template: string;
	expectedCode: DiscardCode;
	repeats: number;
}

interface PoisoningCorpus {
	format: "doro-memory-poisoning-corpus";
	version: 1;
	requiredAttempts: number;
	cases: PoisoningCase[];
}

const discardCodes = new Set<DiscardCode>([
	"actor_not_user",
	"attachments_not_eligible",
	"data_class_denied",
	"external_content_only",
	"input_source_not_user",
	"invalid_signal",
	"memory_unavailable",
	"not_explicit_preference",
	"profile_paused",
	"provenance_missing",
	"restricted_learning_disabled",
	"signal_source_mismatch",
	"source_not_trusted",
]);

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} invalid`);
	return value as Record<string, unknown>;
}

function parseCorpus(value: unknown): PoisoningCorpus {
	const root = record(value, "corpus");
	expect(Object.keys(root).sort()).toEqual(["cases", "format", "requiredAttempts", "version"]);
	if (
		root.format !== "doro-memory-poisoning-corpus" ||
		root.version !== 1 ||
		!Number.isInteger(root.requiredAttempts) ||
		Number(root.requiredAttempts) < 5_000 ||
		!Array.isArray(root.cases)
	)
		throw new TypeError("corpus header invalid");
	const cases = root.cases.map((value, index): PoisoningCase => {
		const testCase = record(value, `case ${index}`);
		expect(Object.keys(testCase).sort()).toEqual([
			"expectedCode",
			"hasAttachments",
			"id",
			"inputSource",
			"repeats",
			"template",
		]);
		if (
			typeof testCase.id !== "string" ||
			(testCase.inputSource !== "interactive" &&
				testCase.inputSource !== "rpc" &&
				testCase.inputSource !== "extension") ||
			typeof testCase.hasAttachments !== "boolean" ||
			typeof testCase.template !== "string" ||
			!testCase.template.includes("{index}") ||
			typeof testCase.expectedCode !== "string" ||
			!discardCodes.has(testCase.expectedCode as DiscardCode) ||
			!Number.isInteger(testCase.repeats) ||
			Number(testCase.repeats) <= 0
		)
			throw new TypeError(`case ${index} invalid`);
		return {
			id: testCase.id,
			inputSource: testCase.inputSource,
			hasAttachments: testCase.hasAttachments,
			template: testCase.template,
			expectedCode: testCase.expectedCode as DiscardCode,
			repeats: Number(testCase.repeats),
		};
	});
	return {
		format: "doro-memory-poisoning-corpus",
		version: 1,
		requiredAttempts: Number(root.requiredAttempts),
		cases,
	};
}

describe("Personal Memory poisoning corpus", () => {
	it("rejects at least 5,000 external, spoofed, and attachment-borne preference attempts", async () => {
		const corpus = parseCorpus(
			JSON.parse(
				await readFile(new URL("../../../../evals/v3/memory-poisoning-corpus.json", import.meta.url), "utf8"),
			) as unknown,
		);
		expect(corpus.cases.reduce((total, testCase) => total + testCase.repeats, 0)).toBe(corpus.requiredAttempts);
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-poisoning-corpus-"));
		try {
			const profileRoot = memoryProfileRoot(join(temporaryDirectory, "doro"), "profile-1");
			await createMemoryProfile(profileRoot, { profileId: "profile-1" });
			const sourceRef: SafeRef = {
				kind: "session",
				locator: "session:poisoning-corpus",
				contentHash: `sha256:${hashCanonicalJson("poisoning-corpus").value}`,
				dataClass: "public",
			};
			let attempts = 0;
			for (const testCase of corpus.cases) {
				for (let index = 0; index < testCase.repeats; index += 1) {
					const result = await captureExplicitPreferenceInput(profileRoot, {
						text: testCase.template.replace("{index}", String(index)),
						inputSource: testCase.inputSource,
						hasAttachments: testCase.hasAttachments,
						observedAt: "2026-08-08T00:00:00.000Z",
						sourceRefs: [sourceRef],
					});
					if (result.outcome !== "discarded" || result.code !== testCase.expectedCode)
						throw new Error(`${testCase.id} attack ${index} was not rejected as expected`);
					attempts += 1;
				}
			}
			expect(attempts).toBe(corpus.requiredAttempts);
			expect(await openMemoryProfile(profileRoot)).toMatchObject({
				mode: "read-write",
				profile: { revision: 0 },
				counts: { signals: 0, items: 0 },
			});
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
