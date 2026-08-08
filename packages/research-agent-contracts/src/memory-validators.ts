// SPDX-License-Identifier: Apache-2.0

import { Compile, type Validator } from "typebox/compile";
import { canonicalizeJson } from "./canonical-json.ts";
import {
	type DataClass,
	MEMORY_KEY_ALLOWLIST,
	type MemoryCandidateDraftV1,
	MemoryCandidateDraftV1Schema,
	type MemoryCategory,
	type MemoryDeletionTombstoneV1,
	MemoryDeletionTombstoneV1Schema,
	type MemoryEffect,
	type MemoryFeedbackV1,
	MemoryFeedbackV1Schema,
	type MemoryItemV1,
	MemoryItemV1Schema,
	type MemoryUseReceiptV1,
	MemoryUseReceiptV1Schema,
	type PreferenceSignalV1,
	PreferenceSignalV1Schema,
	type ResearcherProfileV1,
	ResearcherProfileV1Schema,
	type SafeRef,
} from "./memory.ts";
import {
	type EncryptedTransferEnvelopeV1,
	EncryptedTransferEnvelopeV1Schema,
	type MemorySnapshotManifestV1,
	MemorySnapshotManifestV1Schema,
} from "./memory-transfer.ts";

export interface MemoryContractIssue {
	path: string;
	code: string;
	message: string;
}

export type MemoryContractValidation<T> =
	| { ok: true; value: T; issues: [] }
	| { ok: false; value: null; issues: [MemoryContractIssue, ...MemoryContractIssue[]] };

type SchemaValidator = Pick<Validator, "Errors">;

const profileValidator = Compile(ResearcherProfileV1Schema);
const signalValidator = Compile(PreferenceSignalV1Schema);
const candidateValidator = Compile(MemoryCandidateDraftV1Schema);
const itemValidator = Compile(MemoryItemV1Schema);
const receiptValidator = Compile(MemoryUseReceiptV1Schema);
const feedbackValidator = Compile(MemoryFeedbackV1Schema);
const deletionTombstoneValidator = Compile(MemoryDeletionTombstoneV1Schema);
const snapshotValidator = Compile(MemorySnapshotManifestV1Schema);
const transferValidator = Compile(EncryptedTransferEnvelopeV1Schema);

const dataClassRanks: Record<DataClass, number> = { public: 0, internal: 1, restricted: 2 };
const allowedEffects: Record<MemoryCategory, ReadonlySet<MemoryEffect>> = {
	domain: new Set(["ranking", "recommendation"]),
	theory: new Set(["ranking", "recommendation"]),
	method: new Set(["ranking", "recommendation"]),
	evidence: new Set(["ranking", "recommendation"]),
	writing: new Set(["prompt_context", "formatting", "recommendation"]),
	workflow: new Set(["routing", "ranking", "prompt_context", "tool_order", "recommendation"]),
	tool: new Set(["routing", "ranking", "tool_order", "recommendation"]),
	output: new Set(["prompt_context", "formatting", "recommendation"]),
};
const expectedCriticalPolicies: Record<MemoryCategory, MemoryItemV1["criticalDecisionPolicy"]> = {
	domain: "rank_only",
	theory: "rank_only",
	method: "rank_only",
	evidence: "rank_only",
	writing: "format_only",
	workflow: "not_applicable",
	tool: "not_applicable",
	output: "format_only",
};
const requiredSnapshotExclusions = new Set<MemorySnapshotManifestV1["excluded"][number]>([
	"session_content",
	"project_content",
	"restricted_sources",
	"credentials",
	"keys",
	"cache",
	"pending_transactions",
]);
const codeValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const languagePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const representationValues = new Set(["table", "prose", "mixed"]);
const toneValues = new Set(["formal", "technical", "concise", "conversational", "neutral", "conservative"]);
const reviewDepthValues = new Set(["light", "standard", "full"]);

function issue(path: string, code: string, message: string): MemoryContractIssue {
	return { path, code, message };
}

function validateWith<T>(
	value: unknown,
	validator: SchemaValidator,
	invariantIssues: (validated: T) => MemoryContractIssue[],
): MemoryContractValidation<T> {
	try {
		canonicalizeJson(value);
	} catch (error) {
		return {
			ok: false,
			value: null,
			issues: [issue("$root", "json.non_canonical_value", error instanceof Error ? error.message : String(error))],
		};
	}
	const schemaIssues = validator
		.Errors(value)
		.map((error) => issue(error.instancePath || "$root", `schema.${error.keyword}`, error.message));
	if (schemaIssues.length > 0) {
		return { ok: false, value: null, issues: schemaIssues as [MemoryContractIssue, ...MemoryContractIssue[]] };
	}
	const validated = value as T;
	const issues = invariantIssues(validated);
	return issues.length === 0
		? { ok: true, value: validated, issues: [] }
		: { ok: false, value: null, issues: issues as [MemoryContractIssue, ...MemoryContractIssue[]] };
}

function timestamp(value: string): number | null {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	const canonical = /\.\d{3}Z$/u.test(value) ? value : value.replace(/Z$/u, ".000Z");
	return new Date(parsed).toISOString() === canonical ? parsed : null;
}

function timestampIssues(fields: ReadonlyArray<readonly [path: string, value: string | null]>): MemoryContractIssue[] {
	return fields.flatMap(([path, value]) =>
		value === null || timestamp(value) !== null
			? []
			: [issue(path, "time.invalid", "value must be a real UTC ISO date-time")],
	);
}

function orderedTimestamps(
	first: string,
	second: string,
	path: string,
	code: string,
	message: string,
): MemoryContractIssue[] {
	const firstTime = timestamp(first);
	const secondTime = timestamp(second);
	return firstTime !== null && secondTime !== null && firstTime > secondTime ? [issue(path, code, message)] : [];
}

function isCodeList(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 32 &&
		value.every((entry) => typeof entry === "string" && codeValuePattern.test(entry)) &&
		new Set(value).size === value.length
	);
}

function preferenceValueIssues(
	category: MemoryCategory,
	key: string,
	value: unknown,
	keyPath: string,
	valuePath: string,
): MemoryContractIssue[] {
	if (!MEMORY_KEY_ALLOWLIST[category].some((allowedKey) => allowedKey === key)) {
		return [issue(keyPath, "memory.key_not_allowed", `${key} is not an allowed ${category} preference key`)];
	}
	let valid: boolean;
	switch (key) {
		case "language":
			valid = typeof value === "string" && languagePattern.test(value);
			break;
		case "target_length":
			valid = Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100_000;
			break;
		case "heading_level":
			valid = Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6;
			break;
		case "representation":
			valid = typeof value === "string" && representationValues.has(value);
			break;
		case "tone":
			valid = typeof value === "string" && toneValues.has(value);
			break;
		case "review_depth":
			valid = typeof value === "string" && reviewDepthValues.has(value);
			break;
		case "citation_style":
		case "artifact_format":
		case "filename_template_id":
		case "presentation_style":
			valid = typeof value === "string" && codeValuePattern.test(value);
			break;
		default:
			valid = isCodeList(value);
	}
	return valid ? [] : [issue(valuePath, "memory.value_not_allowed", `${key} has an invalid structured value`)];
}

function safeRefIssues(ref: SafeRef, path: string): MemoryContractIssue[] {
	return ref.locator.startsWith(`${ref.kind}:`)
		? []
		: [issue(`${path}.locator`, "safe_ref.kind_mismatch", "logical locator prefix must match the reference kind")];
}

function producerIssues(
	producer: { type: string; modelRef?: string; promptHash?: string },
	path: string,
): MemoryContractIssue[] {
	const hasModelFields = producer.modelRef !== undefined || producer.promptHash !== undefined;
	if (producer.type === "model" || producer.type === "model_assisted") {
		return producer.modelRef === undefined || producer.promptHash === undefined
			? [issue(path, "producer.model_provenance_missing", "model output requires model and prompt identity")]
			: [];
	}
	return hasModelFields
		? [issue(path, "producer.non_model_has_model_fields", "non-model output cannot claim model identity")]
		: [];
}

function effectIssues(category: MemoryCategory, effects: MemoryEffect[], path: string): MemoryContractIssue[] {
	const unsupported = effects.filter((effect) => !allowedEffects[category].has(effect));
	return unsupported.length === 0
		? []
		: [issue(path, "memory.effect_not_allowed", `${category} memory cannot use effects: ${unsupported.join(", ")}`)];
}

function profileIssues(profile: ResearcherProfileV1): MemoryContractIssue[] {
	const issues = [
		...timestampIssues([
			["createdAt", profile.createdAt],
			["updatedAt", profile.updatedAt],
		]),
		...orderedTimestamps(
			profile.createdAt,
			profile.updatedAt,
			"updatedAt",
			"profile.time_order",
			"updatedAt cannot precede createdAt",
		),
	];
	const activeMode = profile.status === "active";
	if ((profile.learningPolicy.mode === "active") !== activeMode) {
		issues.push(issue("learningPolicy.mode", "profile.mode_mismatch", "only an active profile can learn actively"));
	}
	if (profile.learningPolicy.inferredLowRiskThreshold > profile.learningPolicy.inferredResearchThreshold) {
		issues.push(
			issue(
				"learningPolicy.inferredResearchThreshold",
				"profile.threshold_order",
				"research inference threshold cannot be lower than low-risk threshold",
			),
		);
	}
	if (profile.budgetPolicy.maxAdditionalTokensPerTask > profile.learningPolicy.maxContextTokens) {
		issues.push(
			issue(
				"budgetPolicy.maxAdditionalTokensPerTask",
				"profile.context_budget_exceeded",
				"additional token budget cannot exceed the context limit",
			),
		);
	}
	const refs = Object.values(profile.preferenceRefs).flatMap((entries) => entries ?? []);
	const memoryIds = refs.map(({ memoryId }) => memoryId);
	if (new Set(memoryIds).size !== memoryIds.length) {
		issues.push(
			issue("preferenceRefs", "profile.duplicate_memory_ref", "a memory item can appear in only one category"),
		);
	}
	return issues;
}

function signalIssues(signal: PreferenceSignalV1): MemoryContractIssue[] {
	const issues = [
		...timestampIssues([
			["observedAt", signal.observedAt],
			["createdAt", signal.createdAt],
		]),
		...orderedTimestamps(
			signal.observedAt,
			signal.createdAt,
			"createdAt",
			"signal.time_order",
			"createdAt cannot precede observedAt",
		),
		...producerIssues(signal.captureMethod, "captureMethod"),
		...preferenceValueIssues(
			signal.category,
			signal.normalizedKey,
			signal.normalizedValue,
			"normalizedKey",
			"normalizedValue",
		),
		...signal.sourceRefs.flatMap((ref, index) => safeRefIssues(ref, `sourceRefs[${index}]`)),
	];
	if (signal.dataClass === "restricted" && signal.scopeCandidate.level !== "project") {
		issues.push(issue("scopeCandidate", "signal.restricted_scope", "restricted signals must remain project scoped"));
	}
	const highestSourceRank = signal.sourceRefs.reduce(
		(highest, ref) => Math.max(highest, dataClassRanks[ref.dataClass]),
		0,
	);
	if (signal.sourceRefs.length > 0 && dataClassRanks[signal.dataClass] !== highestSourceRank) {
		issues.push(
			issue(
				"dataClass",
				"signal.data_class_mismatch",
				"signal data class must equal the highest source classification",
			),
		);
	}
	const rejected = signal.trustState === "quarantined" || signal.trustState === "discarded";
	if ((signal.rejectionCode !== null) !== rejected) {
		issues.push(
			issue(
				"rejectionCode",
				"signal.rejection_mismatch",
				"only quarantined or discarded signals require a rejection code",
			),
		);
	}
	const refKeys = signal.sourceRefs.map((ref) => `${ref.kind}:${ref.locator}:${ref.revision ?? "none"}`);
	if (new Set(refKeys).size !== refKeys.length) {
		issues.push(issue("sourceRefs", "signal.duplicate_source_ref", "signal source references must be unique"));
	}
	return issues;
}

function candidateIssues(candidate: MemoryCandidateDraftV1): MemoryContractIssue[] {
	return [
		...timestampIssues([["createdAt", candidate.createdAt]]),
		...producerIssues(candidate.generatedBy, "generatedBy"),
		...preferenceValueIssues(candidate.category, candidate.key, candidate.value, "key", "value"),
		...effectIssues(candidate.category, candidate.proposedEffects, "proposedEffects"),
	];
}

function itemIssues(item: MemoryItemV1): MemoryContractIssue[] {
	const issues: MemoryContractIssue[] = [
		...timestampIssues([
			["validFrom", item.validFrom],
			["validUntil", item.validUntil],
			["lastSupportedAt", item.lastSupportedAt],
			["lastUsedAt", item.lastUsedAt],
			["createdAt", item.createdAt],
		]),
		...producerIssues(item.generator, "generator"),
		...effectIssues(item.category, item.allowedEffects, "allowedEffects"),
	];
	if (item.value !== null) issues.push(...preferenceValueIssues(item.category, item.key, item.value, "key", "value"));
	if ((item.revision === 1) !== (item.previousRevision === null)) {
		issues.push(
			issue(
				"previousRevision",
				"memory.revision_origin",
				"revision 1 must have no previous revision and later revisions must have one",
			),
		);
	} else if (item.previousRevision !== null && item.previousRevision !== item.revision - 1) {
		issues.push(issue("previousRevision", "memory.revision_gap", "memory revisions must be consecutive"));
	}
	if (item.independentSupportCount > item.supportCount) {
		issues.push(
			issue(
				"independentSupportCount",
				"memory.support_count_invalid",
				"independent support cannot exceed total support",
			),
		);
	}
	if (item.origin === "inferred" && (item.independentSupportCount === 0 || item.sourceSignalRefs.length === 0)) {
		issues.push(
			issue(
				"sourceSignalRefs",
				"memory.inferred_without_support",
				"inferred memory requires independent source signals",
			),
		);
	}
	if (item.dataClass === "restricted" && (item.scope.level !== "project" || item.status === "active")) {
		issues.push(
			issue(
				"scope",
				"memory.restricted_activation",
				"restricted memory must be project scoped and cannot be active by default",
			),
		);
	}
	if ((item.value === null) !== (item.status === "forgotten")) {
		issues.push(
			issue(
				"value",
				"memory.tombstone_status",
				"forgotten memory must carry a semantic-free tombstone and only forgotten memory may do so",
			),
		);
	}
	if (item.status === "active" && item.allowedEffects.length === 0) {
		issues.push(issue("allowedEffects", "memory.active_without_effect", "active memory requires an allowed effect"));
	}
	if (item.criticalDecisionPolicy !== expectedCriticalPolicies[item.category]) {
		issues.push(
			issue(
				"criticalDecisionPolicy",
				"memory.critical_policy_mismatch",
				"critical decision policy must match the memory category",
			),
		);
	}
	if (item.validUntil !== null) {
		issues.push(
			...orderedTimestamps(
				item.validFrom,
				item.validUntil,
				"validUntil",
				"memory.validity_order",
				"validUntil cannot precede validFrom",
			),
		);
	}
	const supersedes = item.supersedes.map(({ memoryId, revision }) => `${memoryId}:${revision}`);
	if (new Set(supersedes).size !== supersedes.length) {
		issues.push(issue("supersedes", "memory.duplicate_supersedes", "superseded revision references must be unique"));
	}
	return issues;
}

function receiptIssues(receipt: MemoryUseReceiptV1): MemoryContractIssue[] {
	const issues = [
		...timestampIssues([["appliedAt", receipt.appliedAt]]),
		...safeRefIssues(receipt.sessionRef, "sessionRef"),
		...safeRefIssues(receipt.taskRef, "taskRef"),
		...(receipt.operationRef === null ? [] : safeRefIssues(receipt.operationRef, "operationRef")),
		...(receipt.artifactRef === null ? [] : safeRefIssues(receipt.artifactRef, "artifactRef")),
	];
	if (receipt.sessionRef.kind !== "session" || receipt.taskRef.kind !== "task") {
		issues.push(
			issue("sessionRef", "receipt.required_ref_kind", "receipt requires session and task reference kinds"),
		);
	}
	if (receipt.operationRef !== null && receipt.operationRef.kind !== "operation") {
		issues.push(issue("operationRef", "receipt.operation_ref_kind", "operationRef must reference an operation"));
	}
	if (receipt.artifactRef !== null && receipt.artifactRef.kind !== "artifact") {
		issues.push(issue("artifactRef", "receipt.artifact_ref_kind", "artifactRef must reference an artifact"));
	}
	if (receipt.criticalResearchDecisionTouched && receipt.outcome === "applied") {
		issues.push(
			issue(
				"outcome",
				"receipt.critical_decision_applied",
				"memory cannot directly apply a critical research decision",
			),
		);
	}
	const itemRefs = receipt.itemRefs.map(({ memoryId, revision }) => `${memoryId}:${revision}`);
	if (new Set(itemRefs).size !== itemRefs.length) {
		issues.push(issue("itemRefs", "receipt.duplicate_item_ref", "receipt item revisions must be unique"));
	}
	return issues;
}

function feedbackIssues(feedback: MemoryFeedbackV1): MemoryContractIssue[] {
	const issues = [
		...timestampIssues([
			["requestedAt", feedback.requestedAt],
			["deactivatedAt", feedback.deactivatedAt],
			["cacheInvalidatedAt", feedback.cacheInvalidatedAt],
			["exportExclusionVerifiedAt", feedback.exportExclusionVerifiedAt],
		]),
		...safeRefIssues(feedback.sourceRef, "sourceRef"),
	];
	if ((feedback.action === "correct") !== (feedback.correction !== null)) {
		issues.push(
			issue("correction", "feedback.correction_mismatch", "only correct actions require correction content"),
		);
	}
	if (feedback.applicationStatus === "pending") {
		if (
			feedback.resultingRevision !== null ||
			feedback.deactivatedAt !== null ||
			feedback.cacheInvalidatedAt !== null ||
			feedback.exportExclusionVerifiedAt !== null ||
			feedback.transactionId !== null ||
			feedback.errorCode !== null
		) {
			issues.push(
				issue("applicationStatus", "feedback.pending_has_result", "pending feedback cannot have result fields"),
			);
		}
	} else if (feedback.applicationStatus === "failed") {
		if (feedback.errorCode === null) {
			issues.push(issue("errorCode", "feedback.failure_without_error", "failed feedback requires an error code"));
		}
	} else {
		if (feedback.resultingRevision === null || feedback.transactionId === null || feedback.errorCode !== null) {
			issues.push(
				issue(
					"applicationStatus",
					"feedback.applied_result_incomplete",
					"applied feedback requires a resulting revision and transaction without an error",
				),
			);
		}
		if (feedback.resultingRevision !== feedback.target.revision + 1) {
			issues.push(
				issue("resultingRevision", "feedback.revision_gap", "applied feedback must create the next revision"),
			);
		}
		if (
			["correct", "reject", "downrank", "forget", "delete", "restore"].includes(feedback.action) &&
			feedback.cacheInvalidatedAt === null
		) {
			issues.push(
				issue(
					"cacheInvalidatedAt",
					"feedback.cache_invalidation_missing",
					"state-changing feedback must invalidate cache",
				),
			);
		}
		if (["correct", "reject", "forget", "delete"].includes(feedback.action) && feedback.deactivatedAt === null) {
			issues.push(
				issue("deactivatedAt", "feedback.deactivation_missing", "feedback must record old-revision deactivation"),
			);
		}
		if (feedback.action === "delete" && feedback.exportExclusionVerifiedAt === null) {
			issues.push(
				issue(
					"exportExclusionVerifiedAt",
					"feedback.delete_export_unverified",
					"applied deletion requires export exclusion verification",
				),
			);
		}
	}
	return issues;
}

function deletionTombstoneIssues(tombstone: MemoryDeletionTombstoneV1): MemoryContractIssue[] {
	const issues = timestampIssues([["deletedAt", tombstone.deletedAt]]);
	for (const [path, hashes] of [
		["deletedRecordHashes", tombstone.deletedRecordHashes],
		["relatedIdentifierHashes", tombstone.relatedIdentifierHashes],
		["deletedPathHashes", tombstone.deletedPathHashes],
	] as const) {
		if (hashes.some((value, index) => index > 0 && value <= (hashes[index - 1] as string))) {
			issues.push(issue(path, "deletion.hash_order", "deletion hashes must be unique and sorted"));
		}
	}
	return issues;
}

function snapshotIssues(snapshot: MemorySnapshotManifestV1): MemoryContractIssue[] {
	const issues = timestampIssues([["createdAt", snapshot.createdAt]]);
	if (snapshot.sourceLineage.profileId !== snapshot.profileId) {
		issues.push(issue("sourceLineage.profileId", "snapshot.profile_mismatch", "snapshot lineage must match profile"));
	}
	if (snapshot.sourceLineage.baseRevision > snapshot.profileRevision) {
		issues.push(
			issue(
				"sourceLineage.baseRevision",
				"snapshot.revision_order",
				"lineage base revision cannot exceed snapshot revision",
			),
		);
	}
	const missingExclusions = [...requiredSnapshotExclusions].filter((entry) => !snapshot.excluded.includes(entry));
	if (missingExclusions.length > 0) {
		issues.push(
			issue(
				"excluded",
				"snapshot.required_exclusion_missing",
				`memory snapshot must exclude: ${missingExclusions.join(", ")}`,
			),
		);
	}
	const paths = snapshot.files.map(({ path }) => path);
	if (new Set(paths).size !== paths.length) {
		issues.push(issue("files", "snapshot.duplicate_path", "snapshot file paths must be unique"));
	}
	const forbiddenPath = paths.find((path) => /^(?:cache|locks|transactions\/pending)(?:\/|$)/u.test(path));
	if (forbiddenPath !== undefined) {
		issues.push(issue("files", "snapshot.forbidden_path", `snapshot includes forbidden path: ${forbiddenPath}`));
	}
	return issues;
}

function transferIssues(envelope: EncryptedTransferEnvelopeV1): MemoryContractIssue[] {
	return envelope.wrappedDek.nonceBase64 === envelope.encryptedManifest.nonceBase64
		? [issue("encryptedManifest.nonceBase64", "transfer.nonce_reuse", "wrapped DEK and manifest nonces must differ")]
		: [];
}

export function validateResearcherProfileV1(value: unknown): MemoryContractValidation<ResearcherProfileV1> {
	return validateWith(value, profileValidator, profileIssues);
}

export function validatePreferenceSignalV1(value: unknown): MemoryContractValidation<PreferenceSignalV1> {
	return validateWith(value, signalValidator, signalIssues);
}

export function validateMemoryCandidateDraftV1(value: unknown): MemoryContractValidation<MemoryCandidateDraftV1> {
	return validateWith(value, candidateValidator, candidateIssues);
}

export function validateMemoryItemV1(value: unknown): MemoryContractValidation<MemoryItemV1> {
	return validateWith(value, itemValidator, itemIssues);
}

export function validateMemoryUseReceiptV1(value: unknown): MemoryContractValidation<MemoryUseReceiptV1> {
	return validateWith(value, receiptValidator, receiptIssues);
}

export function validateMemoryFeedbackV1(value: unknown): MemoryContractValidation<MemoryFeedbackV1> {
	return validateWith(value, feedbackValidator, feedbackIssues);
}

export function validateMemoryDeletionTombstoneV1(value: unknown): MemoryContractValidation<MemoryDeletionTombstoneV1> {
	return validateWith(value, deletionTombstoneValidator, deletionTombstoneIssues);
}

export function validateMemorySnapshotManifestV1(value: unknown): MemoryContractValidation<MemorySnapshotManifestV1> {
	return validateWith(value, snapshotValidator, snapshotIssues);
}

export function validateEncryptedTransferEnvelopeV1(
	value: unknown,
): MemoryContractValidation<EncryptedTransferEnvelopeV1> {
	return validateWith(value, transferValidator, transferIssues);
}
