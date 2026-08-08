// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import type {
	DataClass,
	MemoryCandidateDraftV1,
	MemoryItemV1,
	MemoryScope,
	PreferenceSignalV1,
	ResearcherProfileV1,
	SafeRef,
	SignalContentRef,
} from "@research-agent/contracts/memory";
import { MEMORY_LOGICAL_LOCATOR_PATTERN } from "@research-agent/contracts/memory";
import { validateMemoryCandidateDraftV1 } from "@research-agent/contracts/memory-validators";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../contracts/integrity.ts";
import { readCanonicalPreferenceSignals } from "./signals.ts";
import { appendMemoryRecord, openMemoryProfile } from "./store.ts";

export const CONSOLIDATION_RATIONALE_CODES = [
	"consistent-delivery-choice",
	"consistent-format-choice",
	"consistent-tool-choice",
	"cross-session-support",
	"explicit-user-preference",
	"repeated-user-behavior",
] as const;
export const PROHIBITED_INFERENCE_CIRCUIT_BREAKER = 3;

type ConsolidationRationaleCode = (typeof CONSOLIDATION_RATIONALE_CODES)[number];

export interface SanitizedConsolidationSignal {
	signalId: string;
	contentHash: PreferenceSignalV1["dedupeKey"];
	signalType: PreferenceSignalV1["signalType"];
	observedAt: string;
	category: PreferenceSignalV1["category"];
	key: string;
	value: PreferenceSignalV1["normalizedValue"];
	scope: MemoryScope;
	baseWeight: number;
	dataClass: Exclude<DataClass, "restricted">;
}

export interface SanitizedConsolidationRequest {
	format: "doro-memory-consolidation-request";
	version: 1;
	profileId: string;
	candidateId: string;
	createdAt: string;
	generatedBy: {
		type: "model";
		version: string;
		modelRef: string;
		promptHash: PreferenceSignalV1["dedupeKey"];
		outputSchemaHash: PreferenceSignalV1["dedupeKey"];
	};
	signals: SanitizedConsolidationSignal[];
	constraints: {
		allowedRationaleCodes: readonly ConsolidationRationaleCode[];
		maximumCandidates: 1;
		memoryItemsForbidden: true;
	};
}

export interface ConsolidationAttemptReservation {
	format: "doro-memory-consolidation-attempt";
	version: 1;
	attemptId: string;
	profileId: string;
	sessionRef: SafeRef;
	modelRef: string;
	promptHash: PreferenceSignalV1["dedupeKey"];
	inputHash: PreferenceSignalV1["dedupeKey"];
	estimatedCostUsd: number;
	createdAt: string;
}

export interface PromotionEvaluation {
	disposition: "candidate" | "quarantined" | "eligible";
	supportCount: number;
	independentSupportCount: number;
	independentSessionCount: number;
	independentProjectCount: number;
	distinctDayCount: number;
	contradictionCount: number;
	confidence: number;
	reasonCodes: string[];
}

export interface ConsolidationInput {
	profileRoot: string;
	sessionRef: SafeRef;
	trigger: "session_end" | "explicit" | "signal_threshold";
	signalRefs: readonly SignalContentRef[];
	priorUsage: { calls: number; costUsd: number };
	priorSecurityViolations: number;
	estimatedCostUsd: number;
	model: {
		modelRef: string;
		version: string;
		promptHash: PreferenceSignalV1["dedupeKey"];
		outputSchemaHash: PreferenceSignalV1["dedupeKey"];
		local: boolean;
		allowedDataClasses: readonly DataClass[];
	};
	timeoutMs: number;
	reserveAttempt: (reservation: ConsolidationAttemptReservation) => Promise<"reserved" | "already_reserved">;
	invokeModel: (
		request: SanitizedConsolidationRequest,
		signal: AbortSignal,
	) => Promise<{ text: string; costUsd: number }>;
}

type ConsolidationFailureCode =
	| "actual_cost_exceeded"
	| "attempt_reservation_failed"
	| "budget_exceeded"
	| "candidate_exists"
	| "candidate_identity_mismatch"
	| "effect_violation"
	| "inference_already_attempted"
	| "invalid_input"
	| "invalid_json"
	| "invalid_schema"
	| "memory_unavailable"
	| "model_data_class_denied"
	| "model_error"
	| "model_timeout"
	| "output_too_large"
	| "profile_paused"
	| "prohibited_inference"
	| "provenance_missing"
	| "scope_violation"
	| "security_circuit_open"
	| "signal_threshold_not_met"
	| "unsupported_inference"
	| "unsupported_rationale";

export type ConsolidationResult =
	| {
			outcome: "skipped" | "rejected" | "failed";
			code: ConsolidationFailureCode;
			attemptId: string | null;
			outputHash: PreferenceSignalV1["dedupeKey"] | null;
	  }
	| {
			outcome: "persisted";
			attemptId: string;
			transactionId: string;
			candidate: MemoryCandidateDraftV1;
			promotion: PromotionEvaluation;
			costUsd: number;
	  };

const rationaleCodes = new Set<string>(CONSOLIDATION_RATIONALE_CODES);
const lowRiskCategories = new Set<PreferenceSignalV1["category"]>(["writing", "workflow", "tool", "output"]);
const researchCategories = new Set<PreferenceSignalV1["category"]>(["domain", "theory", "method", "evidence"]);
const consolidationTriggers = new Set<ConsolidationInput["trigger"]>(["session_end", "explicit", "signal_threshold"]);
const dataClasses = new Set<DataClass>(["public", "internal", "restricted"]);
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const logicalLocatorPattern = new RegExp(MEMORY_LOGICAL_LOCATOR_PATTERN, "u");
const prohibitedExactTokens = new Set([
	"bipolar",
	"credential",
	"democrat",
	"gay",
	"lesbian",
	"password",
	"pregnant",
	"republican",
	"schizophrenic",
	"transgender",
]);
const prohibitedPhrases = [
	"api-key",
	"health-status",
	"mental-health-status",
	"personality-diagnosis",
	"political-belief",
	"private-key",
	"religious-belief",
	"secret-token",
	"sexual-orientation",
	"user-is-",
	"人格诊断",
	"健康状况",
	"凭据",
	"密码",
	"密钥",
	"心理诊断",
	"性取向",
	"政治倾向",
	"用户抑郁",
	"用户焦虑",
	"宗教信仰",
] as const;

function hash(value: unknown): PreferenceSignalV1["dedupeKey"] {
	return `sha256:${hashCanonicalJson(value).value}`;
}

function textHash(value: string): PreferenceSignalV1["dedupeKey"] {
	return `sha256:${hashBytes(value).value}`;
}

function same(left: unknown, right: unknown): boolean {
	return canonicalStringify(left) === canonicalStringify(right);
}

function failure(
	outcome: "skipped" | "rejected" | "failed",
	code: ConsolidationFailureCode,
	attemptId: string | null = null,
	outputHash: PreferenceSignalV1["dedupeKey"] | null = null,
): ConsolidationResult {
	return { outcome, code, attemptId, outputHash };
}

function safeSessionRef(ref: SafeRef | null | undefined): boolean {
	return (
		ref !== null &&
		ref !== undefined &&
		ref.kind === "session" &&
		logicalLocatorPattern.test(ref.locator) &&
		ref.locator.startsWith("session:") &&
		ref.dataClass !== "restricted" &&
		(ref.revision === undefined || (Number.isInteger(ref.revision) && ref.revision >= 0)) &&
		(ref.contentHash === undefined || hashPattern.test(ref.contentHash))
	);
}

function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value === null || typeof value !== "object") return [];
	return Object.values(value).flatMap(strings);
}

function containsProhibitedInference(candidate: MemoryCandidateDraftV1): boolean {
	for (const value of strings({
		key: candidate.key,
		value: candidate.value,
		rationaleCodes: candidate.rationaleCodes,
	})) {
		const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
		if (prohibitedPhrases.some((phrase) => normalized.includes(phrase))) return true;
		if (normalized.split(/[^\p{L}\p{N}]+/u).some((token) => prohibitedExactTokens.has(token))) return true;
	}
	return false;
}

function signalRef(signal: PreferenceSignalV1): SignalContentRef {
	return { signalId: signal.signalId, contentHash: hash(signal) };
}

function eligiblePromotionSignal(signal: PreferenceSignalV1): boolean {
	return (
		signal.captureMethod.type === "deterministic" &&
		signal.captureMethod.ruleVersion === "host-signal-v1" &&
		(signal.trustState === "captured" || signal.trustState === "accepted") &&
		signal.dataClass !== "restricted" &&
		signal.sourceRefs.some(({ kind }) => kind === "session") &&
		signal.sourceRefs.every(({ dataClass }) => dataClass !== "restricted")
	);
}

function usableSignal(signal: PreferenceSignalV1, profile: ResearcherProfileV1): boolean {
	return eligiblePromotionSignal(signal) && profile.sensitivityPolicy.allowedDataClasses.includes(signal.dataClass);
}

function supportingSignals(
	candidate: MemoryCandidateDraftV1,
	signals: readonly PreferenceSignalV1[],
): { support: PreferenceSignalV1[]; contradictions: PreferenceSignalV1[] } {
	const relevant = signals.filter(
		(signal) =>
			eligiblePromotionSignal(signal) &&
			signal.category === candidate.category &&
			signal.normalizedKey === candidate.key &&
			same(signal.scopeCandidate, candidate.proposedScope),
	);
	return {
		support: relevant.filter(
			(signal) => signal.signalType !== "reject" && same(signal.normalizedValue, candidate.value),
		),
		contradictions: relevant.filter(
			(signal) => signal.signalType === "reject" || !same(signal.normalizedValue, candidate.value),
		),
	};
}

export function evaluateCandidatePromotion(
	candidate: MemoryCandidateDraftV1,
	signals: readonly PreferenceSignalV1[],
	activeItems: readonly MemoryItemV1[],
	policy: ResearcherProfileV1["learningPolicy"],
): PromotionEvaluation {
	const { support, contradictions } = supportingSignals(candidate, signals);
	const sessions = new Set(
		support.flatMap((signal) =>
			signal.sourceRefs.filter(({ kind }) => kind === "session").map(({ locator }) => locator),
		),
	);
	const projects = new Set(
		support.flatMap((signal) =>
			signal.sourceRefs.filter(({ kind }) => kind === "project").map(({ locator }) => locator),
		),
	);
	const days = new Set(support.map(({ observedAt }) => observedAt.slice(0, 10)));
	const independentSupportCount = new Set(support.map(({ dedupeKey }) => dedupeKey)).size;
	const supportWeight = support.reduce((total, signal) => total + signal.baseWeight, 0);
	const contradictionWeight = contradictions.reduce((total, signal) => total + signal.baseWeight, 0);
	const confidence =
		supportWeight === 0 ? 0 : Number((supportWeight / (supportWeight + contradictionWeight)).toFixed(6));
	const explicitConflict = activeItems.some(
		(item) =>
			item.origin === "explicit" &&
			item.status === "active" &&
			item.category === candidate.category &&
			item.key === candidate.key &&
			(!same(item.value, candidate.value) || !same(item.scope, candidate.proposedScope)),
	);
	const reasonCodes: string[] = [];
	let disposition: PromotionEvaluation["disposition"] = "candidate";
	if (contradictions.length > 0) reasonCodes.push("contradiction_present");
	if (explicitConflict) reasonCodes.push("explicit_item_conflict");
	if (contradictions.length > 0 || explicitConflict) {
		disposition = "quarantined";
	} else if (
		lowRiskCategories.has(candidate.category) &&
		independentSupportCount >= policy.minimumIndependentSignals &&
		sessions.size >= 2 &&
		days.size >= 2 &&
		confidence >= policy.inferredLowRiskThreshold
	) {
		disposition = "eligible";
		reasonCodes.push("low_risk_threshold_met");
	} else if (
		researchCategories.has(candidate.category) &&
		independentSupportCount >= Math.max(5, policy.minimumIndependentSignals) &&
		projects.size >= 3 &&
		confidence >= policy.inferredResearchThreshold
	) {
		disposition = "eligible";
		reasonCodes.push("research_rank_threshold_met");
	} else {
		reasonCodes.push("support_threshold_not_met");
	}
	return {
		disposition,
		supportCount: support.length,
		independentSupportCount,
		independentSessionCount: sessions.size,
		independentProjectCount: projects.size,
		distinctDayCount: days.size,
		contradictionCount: contradictions.length,
		confidence,
		reasonCodes,
	};
}

function strictCandidate(
	text: string,
	expected: SanitizedConsolidationRequest,
	resolvedSignals: readonly PreferenceSignalV1[],
): { candidate: MemoryCandidateDraftV1; sourceSignals: PreferenceSignalV1[] } | ConsolidationFailureCode {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "invalid_json";
	}
	const validation = validateMemoryCandidateDraftV1(parsed);
	if (!validation.ok) return "invalid_schema";
	const candidate = validation.value;
	if (
		candidate.candidateId !== expected.candidateId ||
		candidate.profileId !== expected.profileId ||
		candidate.createdAt !== expected.createdAt ||
		candidate.generatedBy.type !== "model" ||
		candidate.generatedBy.version !== expected.generatedBy.version ||
		candidate.generatedBy.modelRef !== expected.generatedBy.modelRef ||
		candidate.generatedBy.promptHash !== expected.generatedBy.promptHash ||
		candidate.generatedBy.outputSchemaHash !== expected.generatedBy.outputSchemaHash
	) {
		return "candidate_identity_mismatch";
	}
	if (candidate.rationaleCodes.some((code) => !rationaleCodes.has(code))) return "unsupported_rationale";
	if (containsProhibitedInference(candidate)) return "prohibited_inference";
	if (
		candidate.proposedEffects.includes("recommendation") ||
		(researchCategories.has(candidate.category) && candidate.proposedEffects.some((effect) => effect !== "ranking"))
	) {
		return "effect_violation";
	}

	const byId = new Map(resolvedSignals.map((signal) => [signal.signalId, signal]));
	const sourceSignals: PreferenceSignalV1[] = [];
	for (const ref of candidate.sourceSignalRefs) {
		const signal = byId.get(ref.signalId);
		if (signal === undefined || signalRef(signal).contentHash !== ref.contentHash) return "provenance_missing";
		sourceSignals.push(signal);
	}
	if (sourceSignals.some((signal) => !same(signal.scopeCandidate, candidate.proposedScope))) {
		return "scope_violation";
	}
	if (
		sourceSignals.some(
			(signal) => signal.category !== candidate.category || signal.normalizedKey !== candidate.key,
		) ||
		!sourceSignals.some((signal) => signal.signalType !== "reject" && same(signal.normalizedValue, candidate.value))
	) {
		return "unsupported_inference";
	}
	return { candidate, sourceSignals };
}

async function invokeWithTimeout(
	input: ConsolidationInput,
	request: SanitizedConsolidationRequest,
): Promise<{ result: { text: string; costUsd: number } | null; timedOut: boolean }> {
	const abortController = new AbortController();
	let timedOut = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			abortController.abort();
			reject(new Error("MEMORY_CONSOLIDATION_TIMEOUT"));
		}, input.timeoutMs);
	});
	try {
		return { result: await Promise.race([input.invokeModel(request, abortController.signal), timeout]), timedOut };
	} catch {
		return { result: null, timedOut };
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	}
}

export async function consolidateMemorySignals(input: ConsolidationInput): Promise<ConsolidationResult> {
	if (
		typeof input.profileRoot !== "string" ||
		input.profileRoot.length === 0 ||
		!safeSessionRef(input.sessionRef) ||
		!consolidationTriggers.has(input.trigger) ||
		!Array.isArray(input.signalRefs) ||
		input.signalRefs.length === 0 ||
		input.signalRefs.length > 100 ||
		new Set(input.signalRefs.map(({ signalId }) => signalId)).size !== input.signalRefs.length ||
		!Number.isInteger(input.priorUsage.calls) ||
		input.priorUsage.calls < 0 ||
		!Number.isFinite(input.priorUsage.costUsd) ||
		input.priorUsage.costUsd < 0 ||
		!Number.isInteger(input.priorSecurityViolations) ||
		input.priorSecurityViolations < 0 ||
		!Number.isFinite(input.estimatedCostUsd) ||
		input.estimatedCostUsd < 0 ||
		!Number.isInteger(input.timeoutMs) ||
		input.timeoutMs < 1 ||
		input.timeoutMs > 60_000 ||
		!identifierPattern.test(input.model.modelRef) ||
		typeof input.model.version !== "string" ||
		input.model.version.length === 0 ||
		input.model.version.length > 128 ||
		!hashPattern.test(input.model.promptHash) ||
		!hashPattern.test(input.model.outputSchemaHash) ||
		typeof input.model.local !== "boolean" ||
		!Array.isArray(input.model.allowedDataClasses) ||
		input.model.allowedDataClasses.some((dataClass) => !dataClasses.has(dataClass)) ||
		typeof input.reserveAttempt !== "function" ||
		typeof input.invokeModel !== "function"
	) {
		return failure("rejected", "invalid_input");
	}

	const opened = await openMemoryProfile(input.profileRoot);
	if (opened.mode !== "read-write") return failure("skipped", "memory_unavailable");
	if (opened.profile.status !== "active" || opened.profile.learningPolicy.mode !== "active") {
		return failure("skipped", "profile_paused");
	}
	if (input.priorSecurityViolations >= PROHIBITED_INFERENCE_CIRCUIT_BREAKER) {
		return failure("skipped", "security_circuit_open");
	}
	if (input.priorUsage.calls >= opened.profile.budgetPolicy.maxInferenceCallsPerSession) {
		return failure("skipped", "inference_already_attempted");
	}
	if (input.priorUsage.costUsd + input.estimatedCostUsd > opened.profile.budgetPolicy.maxInferenceCostUsdPerSession) {
		return failure("skipped", "budget_exceeded");
	}

	const allSignals = await readCanonicalPreferenceSignals(opened.root, opened.profile.profileId);
	const byId = new Map(allSignals.map((signal) => [signal.signalId, signal]));
	const resolvedSignals: PreferenceSignalV1[] = [];
	for (const ref of input.signalRefs) {
		const signal = byId.get(ref.signalId);
		if (
			signal === undefined ||
			signalRef(signal).contentHash !== ref.contentHash ||
			!usableSignal(signal, opened.profile)
		) {
			return failure("rejected", "provenance_missing");
		}
		resolvedSignals.push(signal);
	}
	if (input.trigger === "signal_threshold" && resolvedSignals.length < 10) {
		return failure("skipped", "signal_threshold_not_met");
	}
	if (
		resolvedSignals.some(
			(signal) =>
				!input.model.allowedDataClasses.includes(signal.dataClass) ||
				(!input.model.local && opened.profile.sensitivityPolicy.externalProviderMemoryView === "disabled"),
		)
	) {
		return failure("skipped", "model_data_class_denied");
	}

	const createdAt = new Date().toISOString();
	const attemptId = `attempt_${hash({
		profileId: opened.profile.profileId,
		sessionLocator: input.sessionRef.locator,
	}).slice("sha256:".length)}`;
	const candidateId = `candidate_${hash({ profileId: opened.profile.profileId, attemptId }).slice("sha256:".length)}`;
	const request: SanitizedConsolidationRequest = {
		format: "doro-memory-consolidation-request",
		version: 1,
		profileId: opened.profile.profileId,
		candidateId,
		createdAt,
		generatedBy: {
			type: "model",
			version: input.model.version,
			modelRef: input.model.modelRef,
			promptHash: input.model.promptHash,
			outputSchemaHash: input.model.outputSchemaHash,
		},
		signals: resolvedSignals
			.map(
				(signal): SanitizedConsolidationSignal => ({
					signalId: signal.signalId,
					contentHash: signalRef(signal).contentHash,
					signalType: signal.signalType,
					observedAt: signal.observedAt,
					category: signal.category,
					key: signal.normalizedKey,
					value: signal.normalizedValue,
					scope: signal.scopeCandidate,
					baseWeight: signal.baseWeight,
					dataClass: signal.dataClass as Exclude<DataClass, "restricted">,
				}),
			)
			.sort((left, right) => left.signalId.localeCompare(right.signalId)),
		constraints: {
			allowedRationaleCodes: CONSOLIDATION_RATIONALE_CODES,
			maximumCandidates: 1,
			memoryItemsForbidden: true,
		},
	};
	const reservation: ConsolidationAttemptReservation = {
		format: "doro-memory-consolidation-attempt",
		version: 1,
		attemptId,
		profileId: opened.profile.profileId,
		sessionRef: { ...input.sessionRef },
		modelRef: input.model.modelRef,
		promptHash: input.model.promptHash,
		inputHash: hash(request),
		estimatedCostUsd: input.estimatedCostUsd,
		createdAt,
	};
	try {
		const reservationOutcome = await input.reserveAttempt(reservation);
		if (reservationOutcome === "already_reserved") {
			return failure("skipped", "inference_already_attempted", attemptId);
		}
		if (reservationOutcome !== "reserved") return failure("failed", "attempt_reservation_failed", attemptId);
	} catch {
		return failure("failed", "attempt_reservation_failed", attemptId);
	}

	const invocation = await invokeWithTimeout(input, request);
	if (invocation.result === null) {
		return failure("failed", invocation.timedOut ? "model_timeout" : "model_error", attemptId);
	}
	if (typeof invocation.result.text !== "string" || typeof invocation.result.costUsd !== "number") {
		return failure("failed", "model_error", attemptId);
	}
	const outputHash = textHash(invocation.result.text);
	if (
		!Number.isFinite(invocation.result.costUsd) ||
		invocation.result.costUsd < 0 ||
		input.priorUsage.costUsd + invocation.result.costUsd > opened.profile.budgetPolicy.maxInferenceCostUsdPerSession
	) {
		return failure("rejected", "actual_cost_exceeded", attemptId, outputHash);
	}
	if (Buffer.byteLength(invocation.result.text, "utf8") > 64 * 1024) {
		return failure("rejected", "output_too_large", attemptId, outputHash);
	}
	const parsed = strictCandidate(invocation.result.text, request, resolvedSignals);
	if (typeof parsed === "string") return failure("rejected", parsed, attemptId, outputHash);
	const promotion = evaluateCandidatePromotion(
		parsed.candidate,
		allSignals.filter((signal) => usableSignal(signal, opened.profile)),
		opened.activeItems,
		opened.profile.learningPolicy,
	);
	try {
		const appended = await appendMemoryRecord(opened.root, parsed.candidate);
		return {
			outcome: "persisted",
			attemptId,
			transactionId: appended.transactionId,
			candidate: appended.record as MemoryCandidateDraftV1,
			promotion,
			costUsd: invocation.result.costUsd,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("DATA_CONFLICT: immutable memory target already exists: candidates/")) {
			return failure("skipped", "candidate_exists", attemptId, outputHash);
		}
		throw error;
	}
}
