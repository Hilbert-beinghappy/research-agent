// SPDX-License-Identifier: Apache-2.0

import type {
	MemoryCandidateDraftV1,
	MemoryEffect,
	PreferenceSignalV1,
	SafeRef,
	SignalContentRef,
} from "@research-agent/contracts/memory";
import { hashCanonicalJson } from "../../../../src/contracts/integrity.ts";
import type { ConsolidationInput, SanitizedConsolidationRequest } from "../../../../src/memory/consolidation.ts";
import { capturePreferenceSignal } from "../../../../src/memory/signals.ts";

export function hash(value: unknown): `sha256:${string}` {
	return `sha256:${hashCanonicalJson(value).value}`;
}

export function sessionRef(sessionId: string): SafeRef {
	return {
		kind: "session",
		locator: `session:${sessionId}`,
		contentHash: hash({ sessionId }),
		dataClass: "public",
	};
}

export function signalContentRef(signal: PreferenceSignalV1): SignalContentRef {
	return { signalId: signal.signalId, contentHash: hash(signal) };
}

export async function captureTestSignal(
	profileRoot: string,
	options: {
		sessionId: string;
		observedAt?: string;
		category?: PreferenceSignalV1["category"];
		key?: string;
		value?: PreferenceSignalV1["normalizedValue"];
	} = { sessionId: "session-1" },
): Promise<PreferenceSignalV1> {
	const source = sessionRef(options.sessionId);
	const result = await capturePreferenceSignal(profileRoot, {
		actor: "user",
		source: "user_input",
		signalType: "explicit_statement",
		observedAt: options.observedAt ?? new Date().toISOString(),
		category: options.category ?? "writing",
		normalizedKey: options.key ?? "language",
		normalizedValue: options.value ?? "zh-CN",
		scopeCandidate: { level: "global" },
		sourceRefs: [source],
		sourceContentHash: hash({ statement: options.value ?? "zh-CN" }),
	});
	if (result.outcome !== "persisted") throw new Error(`signal was not persisted: ${result.outcome}`);
	return result.signal;
}

function effects(category: PreferenceSignalV1["category"]): MemoryEffect[] {
	switch (category) {
		case "writing":
		case "output":
			return ["formatting"];
		case "workflow":
			return ["routing"];
		case "tool":
			return ["tool_order"];
		case "domain":
		case "theory":
		case "method":
		case "evidence":
			return ["ranking"];
	}
}

export function candidateForRequest(
	request: SanitizedConsolidationRequest,
	overrides: Partial<MemoryCandidateDraftV1> = {},
): MemoryCandidateDraftV1 {
	const source = request.signals[0];
	if (source === undefined) throw new Error("request has no signals");
	return {
		format: "doro-memory-candidate-draft",
		schemaVersion: "1.0.0",
		candidateId: request.candidateId,
		profileId: request.profileId,
		category: source.category,
		key: source.key,
		value: source.value,
		proposedScope: source.scope,
		sourceSignalRefs: [{ signalId: source.signalId, contentHash: source.contentHash }],
		proposedEffects: effects(source.category),
		rationaleCodes: ["explicit-user-preference"],
		generatedBy: { ...request.generatedBy },
		createdAt: request.createdAt,
		...overrides,
	};
}

export function reservationLedger(): {
	ids: Set<string>;
	reserve: ConsolidationInput["reserveAttempt"];
} {
	const ids = new Set<string>();
	return {
		ids,
		reserve: async ({ attemptId }) => {
			if (ids.has(attemptId)) return "already_reserved";
			ids.add(attemptId);
			return "reserved";
		},
	};
}

export function consolidationInput(
	profileRoot: string,
	signal: PreferenceSignalV1,
	sessionId: string,
	invokeModel: ConsolidationInput["invokeModel"],
	reserveAttempt: ConsolidationInput["reserveAttempt"],
): ConsolidationInput {
	return {
		profileRoot,
		sessionRef: sessionRef(sessionId),
		trigger: "explicit",
		signalRefs: [signalContentRef(signal)],
		priorUsage: { calls: 0, costUsd: 0 },
		priorSecurityViolations: 0,
		estimatedCostUsd: 0.01,
		model: {
			modelRef: "local-test-model",
			version: "test-v1",
			promptHash: hash("consolidation-prompt"),
			outputSchemaHash: hash("memory-candidate-schema"),
			local: true,
			allowedDataClasses: ["public", "internal"],
		},
		timeoutMs: 1_000,
		reserveAttempt,
		invokeModel,
	};
}
