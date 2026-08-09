// SPDX-License-Identifier: Apache-2.0

import type {
	MemoryCandidateDraftV1,
	MemoryItemV1,
	PreferenceSignalV1,
	ResearcherProfileV1,
	SafeRef,
} from "@research-agent/contracts/memory";
import { describe, expect, it } from "vitest";
import { hashCanonicalJson } from "../../../../src/contracts/integrity.ts";
import { evaluateCandidatePromotion } from "../../../../src/memory/consolidation.ts";

const policy: ResearcherProfileV1["learningPolicy"] = {
	mode: "active",
	explicitAutoActivation: true,
	inferredLowRiskThreshold: 0.85,
	inferredResearchThreshold: 0.9,
	minimumIndependentSignals: 3,
	maxItemsPerTask: 8,
	maxContextTokens: 800,
	criticalDecisionMode: "never_auto",
};

function hash(value: unknown): `sha256:${string}` {
	return `sha256:${hashCanonicalJson(value).value}`;
}

function ref(kind: SafeRef["kind"], id: string, revision?: number): SafeRef {
	return {
		kind,
		locator: `${kind}:${id}`,
		...(revision === undefined ? {} : { revision }),
		contentHash: hash({ kind, id, revision: revision ?? null }),
		dataClass: "public",
	};
}

function behavioralSignal(
	id: string,
	options: {
		session: string;
		day: string;
		value?: PreferenceSignalV1["normalizedValue"];
		type?: PreferenceSignalV1["signalType"];
		project?: string;
		category?: PreferenceSignalV1["category"];
		key?: string;
	},
): PreferenceSignalV1 {
	const signalType = options.type ?? "edit_diff";
	const category = options.category ?? "writing";
	const key = options.key ?? "representation";
	const targetKind = signalType === "tool_choice" ? "operation" : signalType === "reject" ? "memory" : "artifact";
	const sourceRefs = [ref("session", options.session), ref(targetKind, id, 1)];
	if (options.project !== undefined) sourceRefs.push(ref("project", options.project, 1));
	const observedAt = `${options.day}T12:00:00.000Z`;
	return {
		format: "doro-preference-signal",
		schemaVersion: "1.0.0",
		signalId: `signal-${id}`,
		profileId: "profile-1",
		signalType,
		actor: "user",
		observedAt,
		category,
		normalizedKey: key,
		normalizedValue: options.value ?? "table",
		scopeCandidate: { level: "global" },
		baseWeight: signalType === "accept" ? 0.45 : signalType === "tool_choice" ? 0.25 : 0.6,
		dedupeKey: hash({ id }),
		dataClass: "public",
		sourceRefs,
		sourceContentHash: hash({ source: id }),
		captureMethod: { type: "deterministic", ruleVersion: "host-signal-v1" },
		trustState: "captured",
		rejectionCode: null,
		createdAt: observedAt,
	};
}

function candidate(
	source: PreferenceSignalV1,
	overrides: Partial<MemoryCandidateDraftV1> = {},
): MemoryCandidateDraftV1 {
	return {
		format: "doro-memory-candidate-draft",
		schemaVersion: "1.0.0",
		candidateId: "candidate-1",
		profileId: source.profileId,
		category: source.category,
		key: source.normalizedKey,
		value: source.normalizedValue,
		proposedScope: source.scopeCandidate,
		sourceSignalRefs: [{ signalId: source.signalId, contentHash: hash(source) }],
		proposedEffects: source.category === "writing" ? ["formatting"] : ["ranking"],
		rationaleCodes: ["repeated-user-behavior"],
		generatedBy: {
			type: "model",
			version: "test-v1",
			modelRef: "local-test-model",
			promptHash: hash("prompt"),
			outputSchemaHash: hash("schema"),
		},
		createdAt: "2026-08-08T12:00:00.000Z",
		...overrides,
	};
}

function explicitItem(value: string): MemoryItemV1 {
	const now = "2026-08-08T12:00:00.000Z";
	return {
		format: "doro-memory-item",
		schemaVersion: "1.0.0",
		profileId: "profile-1",
		memoryId: "memory-explicit-language",
		revision: 1,
		previousRevision: null,
		status: "active",
		category: "writing",
		key: "representation",
		value,
		origin: "explicit",
		scope: { level: "global" },
		confidence: 1,
		supportCount: 1,
		independentSupportCount: 1,
		contradictionCount: 0,
		dataClass: "public",
		allowedEffects: ["formatting"],
		criticalDecisionPolicy: "format_only",
		sourceSignalRefs: [{ signalId: "signal-explicit", contentHash: hash("explicit") }],
		supersedes: [],
		generator: { type: "rule", version: "test-v1", schemaHash: hash("item-schema") },
		provenanceHash: hash({ value }),
		validFrom: now,
		validUntil: null,
		lastSupportedAt: now,
		lastUsedAt: null,
		decay: { halfLifeDays: 180 },
		createdAt: now,
		transactionId: "tx_00000000-0000-4000-8000-000000000000",
	};
}

describe("Personal Memory promotion support thresholds", () => {
	it("keeps one-off behavior and same-Session repetition as candidates", () => {
		const oneOff = behavioralSignal("one", {
			session: "s1",
			day: "2026-08-01",
			type: "accept",
		});
		expect(evaluateCandidatePromotion(candidate(oneOff), [oneOff], [], policy)).toMatchObject({
			disposition: "candidate",
			supportCount: 1,
			independentSessionCount: 1,
		});

		const repeated = [
			behavioralSignal("repeat-1", { session: "s1", day: "2026-08-01" }),
			behavioralSignal("repeat-2", { session: "s1", day: "2026-08-02" }),
			behavioralSignal("repeat-3", { session: "s1", day: "2026-08-03" }),
		];
		expect(
			evaluateCandidatePromotion(candidate(repeated[0] as PreferenceSignalV1), repeated, [], policy),
		).toMatchObject({
			disposition: "candidate",
			supportCount: 3,
			independentSessionCount: 1,
		});

		const untrusted = [
			behavioralSignal("untrusted-1", { session: "s1", day: "2026-08-01" }),
			behavioralSignal("untrusted-2", { session: "s2", day: "2026-08-02" }),
			behavioralSignal("untrusted-3", { session: "s3", day: "2026-08-03" }),
		].map((signal) => ({ ...signal, trustState: "quarantined" as const, rejectionCode: "untrusted" }));
		expect(
			evaluateCandidatePromotion(candidate(untrusted[0] as PreferenceSignalV1), untrusted, [], policy),
		).toMatchObject({ disposition: "candidate", supportCount: 0, independentSupportCount: 0 });
	});

	it("marks low-risk inference eligible only after three signals, two Sessions, two days, and no contradiction", () => {
		const signals = [
			behavioralSignal("support-1", { session: "s1", day: "2026-08-01" }),
			behavioralSignal("support-2", { session: "s1", day: "2026-08-02" }),
			behavioralSignal("support-3", { session: "s2", day: "2026-08-02" }),
		];
		const duplicateEvidence = {
			...(signals[1] as PreferenceSignalV1),
			dedupeKey: (signals[0] as PreferenceSignalV1).dedupeKey,
		};
		expect(
			evaluateCandidatePromotion(
				candidate(signals[0] as PreferenceSignalV1),
				[signals[0] as PreferenceSignalV1, duplicateEvidence, signals[2] as PreferenceSignalV1],
				[],
				policy,
			),
		).toMatchObject({ disposition: "candidate", supportCount: 3, independentSupportCount: 2 });
		expect(
			evaluateCandidatePromotion(candidate(signals[0] as PreferenceSignalV1), signals, [], policy),
		).toMatchObject({
			disposition: "eligible",
			supportCount: 3,
			independentSupportCount: 3,
			independentSessionCount: 2,
			distinctDayCount: 2,
			contradictionCount: 0,
			confidence: 1,
		});

		const contradiction = behavioralSignal("reject", {
			session: "s3",
			day: "2026-08-03",
			type: "reject",
		});
		expect(
			evaluateCandidatePromotion(
				candidate(signals[0] as PreferenceSignalV1),
				[...signals, contradiction],
				[],
				policy,
			),
		).toMatchObject({ disposition: "quarantined", contradictionCount: 1 });
		expect(
			evaluateCandidatePromotion(
				candidate(signals[0] as PreferenceSignalV1),
				signals,
				[explicitItem("prose")],
				policy,
			),
		).toMatchObject({ disposition: "quarantined", reasonCodes: ["explicit_item_conflict"] });
	});

	it("requires five supporting signals and three Projects for research-ranking eligibility", () => {
		const signals = [
			behavioralSignal("method-1", {
				session: "s1",
				project: "p1",
				day: "2026-08-01",
				type: "tool_choice",
				category: "method",
				key: "preferred_method_ids",
				value: ["did"],
			}),
			behavioralSignal("method-2", {
				session: "s2",
				project: "p1",
				day: "2026-08-01",
				type: "tool_choice",
				category: "method",
				key: "preferred_method_ids",
				value: ["did"],
			}),
			behavioralSignal("method-3", {
				session: "s3",
				project: "p2",
				day: "2026-08-02",
				type: "tool_choice",
				category: "method",
				key: "preferred_method_ids",
				value: ["did"],
			}),
			behavioralSignal("method-4", {
				session: "s4",
				project: "p2",
				day: "2026-08-02",
				type: "tool_choice",
				category: "method",
				key: "preferred_method_ids",
				value: ["did"],
			}),
			behavioralSignal("method-5", {
				session: "s5",
				project: "p3",
				day: "2026-08-03",
				type: "tool_choice",
				category: "method",
				key: "preferred_method_ids",
				value: ["did"],
			}),
		];
		const methodCandidate = candidate(signals[0] as PreferenceSignalV1, {
			category: "method",
			key: "preferred_method_ids",
			value: ["did"],
			proposedEffects: ["ranking"],
		});
		expect(evaluateCandidatePromotion(methodCandidate, signals.slice(0, 4), [], policy)).toMatchObject({
			disposition: "candidate",
			supportCount: 4,
			independentProjectCount: 2,
		});
		expect(evaluateCandidatePromotion(methodCandidate, signals, [], policy)).toMatchObject({
			disposition: "eligible",
			supportCount: 5,
			independentProjectCount: 3,
			confidence: 1,
		});
	});

	it("does not count an ambiguously attributed signal as multiple independent Sessions", () => {
		const signals = [
			behavioralSignal("session-1", { session: "s1", day: "2026-08-01" }),
			behavioralSignal("session-2", { session: "s1", day: "2026-08-02" }),
			behavioralSignal("session-3", { session: "s1", day: "2026-08-03" }),
		];
		const ambiguous = signals[2] as PreferenceSignalV1;
		signals[2] = { ...ambiguous, sourceRefs: [...ambiguous.sourceRefs, ref("session", "s2")] };

		expect(
			evaluateCandidatePromotion(candidate(signals[0] as PreferenceSignalV1), signals, [], policy),
		).toMatchObject({
			disposition: "candidate",
			independentSessionCount: 1,
		});
	});

	it("does not count an ambiguously attributed signal as multiple independent Projects", () => {
		const signals = Array.from({ length: 5 }, (_, index) =>
			behavioralSignal(`project-${index + 1}`, {
				session: `s${index + 1}`,
				project: "p1",
				day: `2026-08-0${index + 1}`,
				type: "tool_choice",
				category: "method",
				key: "preferred_method_ids",
				value: ["did"],
			}),
		);
		const ambiguous = signals[4] as PreferenceSignalV1;
		signals[4] = {
			...ambiguous,
			sourceRefs: [...ambiguous.sourceRefs, ref("project", "p2", 1), ref("project", "p3", 1)],
		};
		const methodCandidate = candidate(signals[0] as PreferenceSignalV1, {
			category: "method",
			key: "preferred_method_ids",
			value: ["did"],
			proposedEffects: ["ranking"],
		});

		expect(evaluateCandidatePromotion(methodCandidate, signals, [], policy)).toMatchObject({
			disposition: "candidate",
			independentProjectCount: 1,
		});
	});
});
