// SPDX-License-Identifier: Apache-2.0

import type {
	MemoryCategory,
	MemoryFeedbackV1,
	MemoryItemV1,
	MemoryPreferenceRefs,
	SafeRef,
} from "@research-agent/contracts/memory";
import { validateMemoryFeedbackV1, validateMemoryItemV1 } from "@research-agent/contracts/memory-validators";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import { hashCanonicalJson } from "../contracts/integrity.ts";
import { validateMemoryIdentifier } from "./layout.ts";
import { memoryItemRootHash, openMemoryProfile } from "./store.ts";
import { runMemoryTransaction } from "./transactions.ts";

export type MemoryFeedbackRequest = Pick<
	MemoryFeedbackV1,
	"feedbackId" | "target" | "action" | "correction" | "sourceRef" | "reasonCode" | "requestedAt"
>;

export interface ApplyMemoryFeedbackOptions {
	expectedProfileRevision?: number;
}

const categories: readonly MemoryCategory[] = [
	"domain",
	"theory",
	"method",
	"evidence",
	"writing",
	"workflow",
	"tool",
	"output",
];
const memoryItemSchemaHash = `sha256:${hashCanonicalJson("MemoryItemV1:feedback-v1").value}`;

function requireValid<T>(
	validation: { ok: true; value: T } | { ok: false; issues: readonly unknown[] },
	label: string,
): T {
	if (validation.ok) return validation.value;
	throw new TypeError(`Invalid ${label}`);
}

function latestItem(items: readonly MemoryItemV1[], memoryId: string): MemoryItemV1 | null {
	return (
		items.filter((item) => item.memoryId === memoryId).sort((left, right) => right.revision - left.revision)[0] ??
		null
	);
}

function nextPreferenceRefs(profileRefs: MemoryPreferenceRefs, item: MemoryItemV1): MemoryPreferenceRefs {
	return Object.fromEntries(
		categories.flatMap((category) => {
			const refs = (profileRefs[category] ?? []).filter(({ memoryId }) => memoryId !== item.memoryId);
			if (item.status === "active" && category === item.category) {
				refs.push({ memoryId: item.memoryId, revision: item.revision });
			}
			return refs.length === 0
				? []
				: [[category, refs.sort((left, right) => left.memoryId.localeCompare(right.memoryId))] as const];
		}),
	) as MemoryPreferenceRefs;
}

function provenanceHash(
	latest: MemoryItemV1,
	action: MemoryFeedbackV1["action"],
	requestedAt: string,
	sourceRef: SafeRef,
	correction: MemoryFeedbackV1["correction"],
): `sha256:${string}` {
	return `sha256:${
		hashCanonicalJson({
			action,
			correction,
			requestedAt,
			sourceRef,
			target: { memoryId: latest.memoryId, revision: latest.revision, provenanceHash: latest.provenanceHash },
		}).value
	}`;
}

function nextMemoryItem(
	latest: MemoryItemV1,
	request: MemoryFeedbackRequest,
	appliedAt: string,
	transactionId: string,
	recoverable: MemoryItemV1 | null,
): MemoryItemV1 {
	const revision = latest.revision + 1;
	const generator: MemoryItemV1["generator"] = {
		type: request.action === "correct" || request.action === "restore" ? "user_correction" : "rule",
		version: "feedback-v1",
		schemaHash: memoryItemSchemaHash,
	};
	const common = {
		...latest,
		revision,
		previousRevision: latest.revision,
		supersedes: [{ memoryId: latest.memoryId, revision: latest.revision }],
		generator,
		provenanceHash: provenanceHash(
			latest,
			request.action,
			request.requestedAt,
			request.sourceRef,
			request.correction,
		),
		validFrom: appliedAt,
		validUntil: null,
		createdAt: appliedAt,
		transactionId,
	};
	switch (request.action) {
		case "correct": {
			const correction = request.correction;
			if (correction === null) throw new TypeError("Correct feedback requires correction content");
			return requireValid(
				validateMemoryItemV1({
					...common,
					status: "active",
					key: correction.key,
					value: correction.value,
					origin: "explicit",
					scope: correction.scope ?? latest.scope,
					confidence: 1,
					supportCount: 1,
					independentSupportCount: 1,
					contradictionCount: 0,
					sourceSignalRefs: [],
					lastSupportedAt: appliedAt,
					lastUsedAt: null,
				}),
				"corrected MemoryItemV1",
			);
		}
		case "reinforce":
			return requireValid(
				validateMemoryItemV1({
					...common,
					confidence: Math.min(1, latest.confidence + 0.05),
					supportCount: latest.supportCount + 1,
					lastSupportedAt: appliedAt,
				}),
				"reinforced MemoryItemV1",
			);
		case "downrank":
			// ponytail: fixed 20% downrank; add a target-confidence field only when the management UI needs variable strength.
			return requireValid(
				validateMemoryItemV1({ ...common, confidence: Number((latest.confidence * 0.8).toFixed(6)) }),
				"downranked MemoryItemV1",
			);
		case "reject":
		case "forget":
			return requireValid(
				validateMemoryItemV1({
					...common,
					status: "forgotten",
					value: null,
					origin: "explicit",
					confidence: 0,
					supportCount: 0,
					independentSupportCount: 0,
					allowedEffects: [],
					sourceSignalRefs: [],
					lastSupportedAt: appliedAt,
					lastUsedAt: null,
				}),
				"forgotten MemoryItemV1",
			);
		case "restore": {
			if (recoverable === null || recoverable.value === null) {
				throw new Error("MEMORY_RESTORE_UNAVAILABLE: no recoverable semantic revision exists");
			}
			return requireValid(
				validateMemoryItemV1({
					...common,
					status: "active",
					key: recoverable.key,
					value: recoverable.value,
					origin: "explicit",
					scope: recoverable.scope,
					confidence: recoverable.confidence,
					supportCount: 1,
					independentSupportCount: 1,
					contradictionCount: 0,
					dataClass: recoverable.dataClass,
					allowedEffects: recoverable.allowedEffects,
					criticalDecisionPolicy: recoverable.criticalDecisionPolicy,
					sourceSignalRefs: [],
					lastSupportedAt: appliedAt,
					lastUsedAt: null,
					decay: recoverable.decay,
				}),
				"restored MemoryItemV1",
			);
		}
		case "delete":
			throw new Error("MEMORY_DELETE_CONTROLLER_REQUIRED: use the semantic deletion controller");
	}
}

export async function applyMemoryFeedback(
	profileRoot: string,
	request: MemoryFeedbackRequest,
	options: ApplyMemoryFeedbackOptions = {},
): Promise<{ transactionId: string; item: MemoryItemV1; feedback: MemoryFeedbackV1 }> {
	validateMemoryIdentifier(request.feedbackId, "feedbackId");
	validateMemoryIdentifier(request.target.memoryId, "memoryId");
	const prepared = await runMemoryTransaction(
		profileRoot,
		options.expectedProfileRevision,
		async (profile, transactionId) => {
			const appliedAt = new Date().toISOString();
			if (Date.parse(request.requestedAt) > Date.parse(appliedAt)) {
				throw new TypeError("Memory feedback requestedAt cannot be in the future");
			}
			const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
			if (opened.mode !== "read-write" || canonicalStringify(opened.profile) !== canonicalStringify(profile)) {
				throw new Error("MEMORY_RECOVERY_REQUIRED: canonical profile changed during feedback");
			}
			if (opened.tombstones.some(({ memoryId }) => memoryId === request.target.memoryId)) {
				throw new Error("MEMORY_DELETED_TERMINAL: deleted memory cannot receive feedback or be restored");
			}
			const latest = latestItem(opened.items, request.target.memoryId);
			if (latest === null || latest.revision !== request.target.revision) {
				throw new Error("DATA_CONFLICT: feedback must target the exact latest memory revision");
			}
			if (request.action === "reject" && latest.origin !== "inferred") {
				throw new Error("MEMORY_REJECT_EXPLICIT_DENIED: reject applies only to inferred memory");
			}
			if (request.action === "restore") {
				if (latest.status !== "forgotten")
					throw new Error("MEMORY_RESTORE_STATE_DENIED: latest revision is not forgotten");
			} else if (latest.status !== "active") {
				throw new Error("MEMORY_FEEDBACK_STATE_DENIED: latest revision is not active");
			}
			if (
				profile.status !== "active" &&
				(request.action === "correct" ||
					request.action === "reinforce" ||
					request.action === "downrank" ||
					request.action === "restore")
			) {
				throw new Error("MEMORY_PROFILE_PAUSED: paused profiles cannot activate memory items");
			}
			const recoverable =
				request.action === "restore"
					? (opened.items
							.filter(
								(item) =>
									item.memoryId === latest.memoryId && item.revision < latest.revision && item.value !== null,
							)
							.sort((left, right) => right.revision - left.revision)[0] ?? null)
					: null;
			const item = nextMemoryItem(latest, request, appliedAt, transactionId, recoverable);
			if (!profile.sensitivityPolicy.allowedDataClasses.includes(item.dataClass)) {
				throw new Error(`MEMORY_DATA_CLASS_DENIED: ${item.dataClass}`);
			}
			const feedback = requireValid(
				validateMemoryFeedbackV1({
					format: "doro-memory-feedback",
					schemaVersion: "1.0.0",
					feedbackId: request.feedbackId,
					profileId: profile.profileId,
					target: request.target,
					action: request.action,
					correction: request.correction,
					actor: "user",
					sourceRef: request.sourceRef,
					reasonCode: request.reasonCode,
					requestedAt: request.requestedAt,
					applicationStatus: "applied",
					resultingRevision: item.revision,
					deactivatedAt: appliedAt,
					cacheInvalidatedAt: appliedAt,
					exportExclusionVerifiedAt: null,
					transactionId,
					errorCode: null,
				}),
				"MemoryFeedbackV1",
			);
			const items = [...opened.items, item];
			const nextProfile = {
				...profile,
				revision: profile.revision + 1,
				preferenceRefs: nextPreferenceRefs(profile.preferenceRefs, item),
				currentItemRootHash: memoryItemRootHash(items),
				updatedAt: appliedAt,
				lastTransactionId: transactionId,
			};
			return {
				profile: nextProfile,
				writes: [
					{
						path: `items/${item.category}/${item.memoryId}/${item.revision}.json`,
						content: `${canonicalStringify(item)}\n`,
					},
					{
						path: `feedback/${request.requestedAt.slice(0, 4)}/${request.requestedAt.slice(5, 7)}/${request.feedbackId}.json`,
						content: `${canonicalStringify(feedback)}\n`,
					},
				],
				result: { item, feedback },
			};
		},
	);
	return { transactionId: prepared.transactionId, ...prepared.result };
}
