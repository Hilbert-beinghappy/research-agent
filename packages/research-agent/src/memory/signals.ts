// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	DataClass,
	MemoryCategory,
	MemoryScope,
	PreferenceSignalV1,
	SafeRef,
} from "@research-agent/contracts/memory";
import { validatePreferenceSignalV1 } from "@research-agent/contracts/memory-validators";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../contracts/integrity.ts";
import { withWriterLease } from "../project/writer-lock.ts";
import { resolveMemoryPath, validateMemoryLayout } from "./layout.ts";
import { appendMemoryRecord, openMemoryProfile } from "./store.ts";

export type HostPreferenceActor = "user" | "model" | "tool" | "adapter" | "skill" | "system";

export type HostPreferenceSource =
	| "user_input"
	| "explicit_action"
	| "artifact_diff"
	| "host_tool_choice"
	| "host_delivery_choice"
	| "pdf"
	| "web"
	| "email"
	| "dataset"
	| "tool_output"
	| "adapter_output"
	| "model_output"
	| "skill"
	| "silence";

export interface ArtifactDiffSegment {
	origin: "user" | "agent" | "external" | "quoted_external";
	operation: "insert" | "delete";
	text: string;
}

export interface SanitizedArtifactDiff {
	userSegmentCount: number;
	userInsertionCount: number;
	userDeletionCount: number;
	excludedSegmentCount: number;
	digest: PreferenceSignalV1["dedupeKey"];
}

export interface HostPreferenceObservation {
	actor: HostPreferenceActor;
	source: HostPreferenceSource;
	signalType: PreferenceSignalV1["signalType"];
	observedAt: string;
	category: MemoryCategory;
	normalizedKey: string;
	normalizedValue: PreferenceSignalV1["normalizedValue"];
	scopeCandidate: MemoryScope;
	sourceRefs: readonly SafeRef[];
	sourceContentHash?: PreferenceSignalV1["sourceContentHash"];
	diffSegments?: readonly ArtifactDiffSegment[];
}

export type SignalCaptureResult =
	| {
			outcome: "persisted";
			transactionId: string;
			profileRevision: number;
			signal: PreferenceSignalV1;
	  }
	| {
			outcome: "duplicate";
			signalId: string;
			dedupeKey: PreferenceSignalV1["dedupeKey"];
	  }
	| {
			outcome: "discarded";
			code:
				| "actor_not_user"
				| "attachments_not_eligible"
				| "data_class_denied"
				| "external_content_only"
				| "input_source_not_user"
				| "invalid_signal"
				| "memory_unavailable"
				| "not_explicit_preference"
				| "profile_paused"
				| "provenance_missing"
				| "restricted_learning_disabled"
				| "signal_source_mismatch"
				| "source_not_trusted";
			eventHash: PreferenceSignalV1["dedupeKey"];
	  };

export const SIGNAL_BASE_WEIGHTS = {
	explicit_statement: 1,
	accept: 0.45,
	reject: 1,
	edit_diff: 0.6,
	tool_choice: 0.25,
	delivery_choice: 0.35,
} as const satisfies Record<PreferenceSignalV1["signalType"], number>;

const expectedSources = {
	explicit_statement: "user_input",
	accept: "explicit_action",
	reject: "explicit_action",
	edit_diff: "artifact_diff",
	tool_choice: "host_tool_choice",
	delivery_choice: "host_delivery_choice",
} as const satisfies Record<PreferenceSignalV1["signalType"], HostPreferenceSource>;

const trustedSources = new Set<HostPreferenceSource>(Object.values(expectedSources));
const dataClassRanks: Record<DataClass, number> = { public: 0, internal: 1, restricted: 2 };

function hash(value: unknown): PreferenceSignalV1["dedupeKey"] {
	return `sha256:${hashCanonicalJson(value).value}`;
}

function textHash(value: string): PreferenceSignalV1["dedupeKey"] {
	return `sha256:${hashBytes(value).value}`;
}

function discard(
	code: Extract<SignalCaptureResult, { outcome: "discarded" }>["code"],
	value: unknown,
): SignalCaptureResult {
	try {
		return { outcome: "discarded", code, eventHash: hash(value) };
	} catch {
		return { outcome: "discarded", code, eventHash: hash({ code, malformedEvent: true }) };
	}
}

function sortedSourceRefs(sourceRefs: readonly SafeRef[]): SafeRef[] {
	return sourceRefs
		.map((ref) => ({ ...ref }))
		.sort(
			(left, right) =>
				left.kind.localeCompare(right.kind) ||
				left.locator.localeCompare(right.locator) ||
				(left.revision ?? -1) - (right.revision ?? -1) ||
				(left.contentHash ?? "").localeCompare(right.contentHash ?? "") ||
				left.dataClass.localeCompare(right.dataClass),
		);
}

function highestDataClass(sourceRefs: readonly SafeRef[]): DataClass | null {
	return sourceRefs.reduce<DataClass | null>(
		(highest, ref) =>
			highest === null || dataClassRanks[ref.dataClass] > dataClassRanks[highest] ? ref.dataClass : highest,
		null,
	);
}

function hasRequiredProvenance(signalType: PreferenceSignalV1["signalType"], sourceRefs: readonly SafeRef[]): boolean {
	if (!sourceRefs.some(({ kind }) => kind === "session")) return false;
	switch (signalType) {
		case "explicit_statement":
			return true;
		case "accept":
			return sourceRefs.some(({ kind }) => kind === "operation" || kind === "artifact" || kind === "memory");
		case "reject":
			return sourceRefs.some(({ kind, revision }) => kind === "memory" && revision !== undefined);
		case "edit_diff":
			return sourceRefs.some(({ kind }) => kind === "artifact");
		case "tool_choice":
			return sourceRefs.some(({ kind }) => kind === "operation");
		case "delivery_choice":
			return sourceRefs.some(({ kind }) => kind === "artifact");
	}
}

async function findSignalByDedupeKey(
	profileRoot: string,
	profileId: string,
	dedupeKey: PreferenceSignalV1["dedupeKey"],
): Promise<PreferenceSignalV1 | null> {
	const matches: PreferenceSignalV1[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true, encoding: "utf8" })) {
			if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new TypeError("Memory signal path must not be a symbolic link");
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json")) {
				throw new TypeError("Memory signal directory contains an unexpected entry");
			}
			const text = await readFile(path, "utf8");
			const parsed: unknown = JSON.parse(text);
			if (text !== `${canonicalStringify(parsed)}\n`) throw new TypeError("Memory signal is not canonical JSON");
			const validation = validatePreferenceSignalV1(parsed);
			if (!validation.ok || validation.value.profileId !== profileId) {
				throw new TypeError("Memory signal failed validation during dedupe scan");
			}
			if (validation.value.dedupeKey === dedupeKey) matches.push(validation.value);
		}
	};
	// ponytail: scan canonical signals; add a derived dedupe index only after capture latency requires it.
	await walk(await resolveMemoryPath(profileRoot, "signals"));
	if (matches.length > 1) throw new TypeError("Memory signals contain a duplicate dedupe key");
	return matches[0] ?? null;
}

export function sanitizeArtifactDiff(segments: readonly ArtifactDiffSegment[]): SanitizedArtifactDiff {
	const userSegments = segments
		.filter(({ origin, text }) => origin === "user" && text.length > 0)
		.map(({ operation, text }) => ({ operation, contentHash: textHash(text) }));
	return {
		userSegmentCount: userSegments.length,
		userInsertionCount: userSegments.filter(({ operation }) => operation === "insert").length,
		userDeletionCount: userSegments.filter(({ operation }) => operation === "delete").length,
		excludedSegmentCount: segments.length - userSegments.length,
		digest: hash(userSegments),
	};
}

export async function capturePreferenceSignal(
	profileRoot: string,
	observation: HostPreferenceObservation,
): Promise<SignalCaptureResult> {
	const eventView = {
		actor: observation.actor,
		source: observation.source,
		signalType: observation.signalType,
		observedAt: observation.observedAt,
		category: observation.category,
		normalizedKey: observation.normalizedKey,
		normalizedValue: observation.normalizedValue,
		scopeCandidate: observation.scopeCandidate,
		sourceRefs: observation.sourceRefs,
		sourceContentHash: observation.sourceContentHash ?? null,
		...(observation.diffSegments === undefined
			? {}
			: {
					diffSegments: observation.diffSegments.map(({ origin, operation, text }) => ({
						origin,
						operation,
						contentHash: textHash(text),
					})),
				}),
	};
	if (observation.actor !== "user") return discard("actor_not_user", eventView);
	if (!trustedSources.has(observation.source)) return discard("source_not_trusted", eventView);
	if (expectedSources[observation.signalType] !== observation.source) {
		return discard("signal_source_mismatch", eventView);
	}

	const sourceRefs = sortedSourceRefs(observation.sourceRefs);
	if (!hasRequiredProvenance(observation.signalType, sourceRefs)) return discard("provenance_missing", eventView);
	if (observation.scopeCandidate.level === "project") {
		const projectId = observation.scopeCandidate.projectId;
		if (!sourceRefs.some(({ kind, locator }) => kind === "project" && locator === `project:${projectId}`)) {
			return discard("provenance_missing", eventView);
		}
	}

	let sourceContentHash = observation.sourceContentHash ?? null;
	if (observation.signalType === "edit_diff") {
		if (observation.diffSegments === undefined) return discard("provenance_missing", eventView);
		const sanitized = sanitizeArtifactDiff(observation.diffSegments);
		if (sanitized.userSegmentCount === 0) return discard("external_content_only", eventView);
		sourceContentHash = sanitized.digest;
	} else if (observation.diffSegments !== undefined) {
		return discard("signal_source_mismatch", eventView);
	}
	if (observation.signalType === "explicit_statement" && sourceContentHash === null) {
		return discard("provenance_missing", eventView);
	}

	const dataClass = highestDataClass(sourceRefs);
	if (dataClass === null) return discard("provenance_missing", eventView);
	if (dataClass === "restricted") return discard("restricted_learning_disabled", eventView);

	try {
		const canonicalRoot = await validateMemoryLayout(profileRoot);
		return withWriterLease(canonicalRoot, "locks/signal-capture.lock", "MEMORY_SIGNAL_CAPTURE", async () => {
			const opened = await openMemoryProfile(canonicalRoot);
			if (opened.mode !== "read-write") return discard("memory_unavailable", eventView);
			if (opened.profile.status !== "active" || opened.profile.learningPolicy.mode !== "active") {
				return discard("profile_paused", eventView);
			}
			if (!opened.profile.sensitivityPolicy.allowedDataClasses.includes(dataClass)) {
				return discard("data_class_denied", eventView);
			}

			const dedupeKey = hash({
				profileId: opened.profile.profileId,
				signalType: observation.signalType,
				category: observation.category,
				normalizedKey: observation.normalizedKey,
				normalizedValue: observation.normalizedValue,
				scopeCandidate: observation.scopeCandidate,
				sourceRefs: sourceRefs.map(({ kind, locator, revision, dataClass: refDataClass }) => ({
					kind,
					locator,
					revision: revision ?? null,
					dataClass: refDataClass,
				})),
				diffDigest: observation.signalType === "edit_diff" ? sourceContentHash : null,
			});
			const signal: PreferenceSignalV1 = {
				format: "doro-preference-signal",
				schemaVersion: "1.0.0",
				signalId: `signal_${dedupeKey.slice("sha256:".length)}`,
				profileId: opened.profile.profileId,
				signalType: observation.signalType,
				actor: "user",
				observedAt: observation.observedAt,
				category: observation.category,
				normalizedKey: observation.normalizedKey,
				normalizedValue: observation.normalizedValue,
				scopeCandidate: observation.scopeCandidate,
				baseWeight: SIGNAL_BASE_WEIGHTS[observation.signalType],
				dedupeKey,
				dataClass,
				sourceRefs,
				sourceContentHash,
				captureMethod: { type: "deterministic", ruleVersion: "host-signal-v1" },
				trustState:
					observation.signalType === "explicit_statement" || observation.signalType === "reject"
						? "accepted"
						: "captured",
				rejectionCode: null,
				createdAt: observation.observedAt,
			};
			if (!validatePreferenceSignalV1(signal).ok) return discard("invalid_signal", eventView);
			const existing = await findSignalByDedupeKey(canonicalRoot, opened.profile.profileId, dedupeKey);
			if (existing !== null) {
				return { outcome: "duplicate", signalId: existing.signalId, dedupeKey: existing.dedupeKey };
			}
			const result = await appendMemoryRecord(canonicalRoot, signal);
			return {
				outcome: "persisted",
				transactionId: result.transactionId,
				profileRevision: result.profile.revision,
				signal: result.record as PreferenceSignalV1,
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return discard("memory_unavailable", eventView);
		if (message.startsWith("Memory layout path must be a real directory")) {
			return discard("memory_unavailable", eventView);
		}
		throw error;
	}
}

export interface ParsedExplicitPreference {
	category: MemoryCategory;
	normalizedKey: string;
	normalizedValue: PreferenceSignalV1["normalizedValue"];
	scopeCandidate: MemoryScope;
}

const explicitPreferenceValues = new Map<string, Omit<ParsedExplicitPreference, "scopeCandidate">>([
	["默认用中文", { category: "writing", normalizedKey: "language", normalizedValue: "zh-CN" }],
	["默认使用中文", { category: "writing", normalizedKey: "language", normalizedValue: "zh-CN" }],
	["use chinese by default", { category: "writing", normalizedKey: "language", normalizedValue: "zh-CN" }],
	["默认用英文", { category: "writing", normalizedKey: "language", normalizedValue: "en" }],
	["默认使用英文", { category: "writing", normalizedKey: "language", normalizedValue: "en" }],
	["use english by default", { category: "writing", normalizedKey: "language", normalizedValue: "en" }],
	["默认用表格", { category: "writing", normalizedKey: "representation", normalizedValue: "table" }],
	["优先用表格", { category: "writing", normalizedKey: "representation", normalizedValue: "table" }],
	["use tables by default", { category: "writing", normalizedKey: "representation", normalizedValue: "table" }],
	["因果表述保持保守", { category: "writing", normalizedKey: "tone", normalizedValue: "conservative" }],
	["使用保守因果措辞", { category: "writing", normalizedKey: "tone", normalizedValue: "conservative" }],
	["use conservative causal wording", { category: "writing", normalizedKey: "tone", normalizedValue: "conservative" }],
	[
		"优先使用证据矩阵",
		{ category: "output", normalizedKey: "presentation_style", normalizedValue: "evidence-matrix" },
	],
	[
		"use an evidence matrix",
		{ category: "output", normalizedKey: "presentation_style", normalizedValue: "evidence-matrix" },
	],
	[
		"结论优先表格呈现",
		{ category: "output", normalizedKey: "presentation_style", normalizedValue: "conclusion-first-table" },
	],
	[
		"use conclusion-first tables",
		{ category: "output", normalizedKey: "presentation_style", normalizedValue: "conclusion-first-table" },
	],
]);

export function parseExplicitPreferenceInput(text: string): ParsedExplicitPreference | null {
	if (text.includes("\n") || text.includes("\r")) return null;
	const normalized = text.normalize("NFKC").trim();
	const match = /^(?:请记住我的长期偏好|please remember my long-term preference)\s*:\s*(.+)$/iu.exec(normalized);
	if (match === null) return null;
	const body = (match[1] ?? "")
		.trim()
		.replace(/[。.]+$/u, "")
		.toLocaleLowerCase("en-US");
	const preference = explicitPreferenceValues.get(body);
	return preference === undefined ? null : { ...preference, scopeCandidate: { level: "global" } };
}

export async function captureExplicitPreferenceInput(
	profileRoot: string,
	input: {
		text: string;
		inputSource: "interactive" | "rpc" | "extension";
		hasAttachments: boolean;
		observedAt: string;
		sourceRefs: readonly SafeRef[];
	},
): Promise<SignalCaptureResult> {
	if (input.inputSource === "extension") return discard("input_source_not_user", input.text);
	if (input.hasAttachments) return discard("attachments_not_eligible", input.text);
	const parsed = parseExplicitPreferenceInput(input.text);
	if (parsed === null) return discard("not_explicit_preference", input.text);
	return capturePreferenceSignal(profileRoot, {
		actor: "user",
		source: "user_input",
		signalType: "explicit_statement",
		observedAt: input.observedAt,
		...parsed,
		sourceRefs: input.sourceRefs,
		sourceContentHash: textHash(input.text),
	});
}
