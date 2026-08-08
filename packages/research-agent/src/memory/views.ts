// SPDX-License-Identifier: Apache-2.0

import type { MemoryCategory, MemoryItemV1 } from "@research-agent/contracts/memory";
import { canonicalizeJson } from "../contracts/canonical-json.ts";
import type { JsonValue } from "../contracts/schemas.ts";
import { validateMemoryIdentifier } from "./layout.ts";
import type { CanonicalMemoryState } from "./store.ts";

const categories = new Set<MemoryCategory>([
	"domain",
	"theory",
	"method",
	"evidence",
	"writing",
	"workflow",
	"tool",
	"output",
]);

export function latestMemoryItems(items: readonly MemoryItemV1[]): MemoryItemV1[] {
	const latest = new Map<string, MemoryItemV1>();
	for (const item of items) {
		const current = latest.get(item.memoryId);
		if (current === undefined || item.revision > current.revision) latest.set(item.memoryId, item);
	}
	return [...latest.values()].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
}

export function latestMemoryItem(items: readonly MemoryItemV1[], memoryIdInput: string): MemoryItemV1 {
	const memoryId = validateMemoryIdentifier(memoryIdInput, "memoryId");
	const item = latestMemoryItems(items).find((candidate) => candidate.memoryId === memoryId);
	if (item === undefined) throw new Error(`MEMORY_NOT_FOUND: ${memoryId}`);
	return item;
}

export function memoryItemsVisibleToProject(
	items: readonly MemoryItemV1[],
	projectId: string,
	domainId: string,
): MemoryItemV1[] {
	return items.filter(({ scope }) => {
		switch (scope.level) {
			case "global":
				return true;
			case "domain":
				return scope.domainId === domainId;
			case "project":
				return scope.projectId === projectId;
		}
		return false;
	});
}

export function memoryItemSummary(item: MemoryItemV1) {
	return {
		memoryId: item.memoryId,
		revision: item.revision,
		status: item.status,
		category: item.category,
		key: item.key,
		origin: item.origin,
		scope: item.scope,
		confidence: item.confidence,
		dataClass: item.dataClass,
		allowedEffects: item.allowedEffects,
		lastSupportedAt: item.lastSupportedAt,
	};
}

export function memoryItemView(item: MemoryItemV1): JsonValue {
	return canonicalizeJson({
		...memoryItemSummary(item),
		value: item.value === null || item.dataClass !== "restricted" ? item.value : "[redacted:restricted]",
		independentSupportCount: item.independentSupportCount,
		contradictionCount: item.contradictionCount,
		criticalDecisionPolicy: item.criticalDecisionPolicy,
		provenanceHash: item.provenanceHash,
		sourceSignalCount: item.sourceSignalRefs.length,
		createdAt: item.createdAt,
	});
}

export function filterMemoryItems(items: readonly MemoryItemV1[], filter: string): MemoryItemV1[] {
	if (filter.length === 0) return [...items];
	if (categories.has(filter as MemoryCategory)) return items.filter(({ category }) => category === filter);
	if (filter === "global" || filter === "domain" || filter === "project") {
		return items.filter(({ scope }) => scope.level === filter);
	}
	const separator = filter.indexOf(":");
	if (separator > 0) {
		const level = filter.slice(0, separator);
		const id = filter.slice(separator + 1);
		if (id.length > 0 && level === "domain") {
			return items.filter(({ scope }) => scope.level === "domain" && scope.domainId === id);
		}
		if (id.length > 0 && level === "project") {
			return items.filter(({ scope }) => scope.level === "project" && scope.projectId === id);
		}
	}
	throw new TypeError("Memory filter must be a category, global, domain[:id], or project[:id]");
}

export interface MemoryReceiptExplanationOptions {
	allowedItemRefs?: ReadonlySet<string>;
	includeInternalRefs?: boolean;
}

export function memoryReceiptExplanation(
	state: CanonicalMemoryState,
	receiptIdInput: string,
	options: MemoryReceiptExplanationOptions = {},
): JsonValue {
	const receipts = state.receipts
		.filter(
			(receipt) =>
				options.allowedItemRefs === undefined ||
				receipt.itemRefs.some(({ memoryId, revision }) => options.allowedItemRefs?.has(`${memoryId}:${revision}`)),
		)
		.sort(
			(left, right) =>
				left.appliedAt.localeCompare(right.appliedAt) || left.receiptId.localeCompare(right.receiptId),
		);
	const receipt =
		receiptIdInput.length === 0 || receiptIdInput === "last"
			? receipts.at(-1)
			: receipts.find(({ receiptId }) => receiptId === validateMemoryIdentifier(receiptIdInput, "receiptId"));
	if (receipt === undefined) throw new Error("MEMORY_RECEIPT_NOT_FOUND");
	const items = receipt.itemRefs
		.filter(
			({ memoryId, revision }) =>
				options.allowedItemRefs === undefined || options.allowedItemRefs.has(`${memoryId}:${revision}`),
		)
		.map((ref) => {
			const item = state.items.find(
				(candidate) => candidate.memoryId === ref.memoryId && candidate.revision === ref.revision,
			);
			const shownRef =
				options.includeInternalRefs === false ? { memoryId: ref.memoryId, revision: ref.revision } : ref;
			return item === undefined
				? { ...shownRef, status: "unavailable" }
				: {
						...shownRef,
						status: item.status,
						category: item.category,
						key: item.key,
						origin: item.origin,
						scope: item.scope,
						dataClass: item.dataClass,
						allowedEffects: item.allowedEffects,
						sourceSignalCount: item.sourceSignalRefs.length,
					};
		});
	return canonicalizeJson({
		receipt: {
			receiptId: receipt.receiptId,
			effect: receipt.effect,
			decisionCodeBefore: receipt.decisionCodeBefore,
			decisionCodeAfter: receipt.decisionCodeAfter,
			explanationCodes: receipt.explanationCodes,
			criticalResearchDecisionTouched: receipt.criticalResearchDecisionTouched,
			approvalRequired: receipt.approvalRequired,
			appliedAt: receipt.appliedAt,
			retrievalLatencyMs: receipt.retrievalLatencyMs,
			addedContextTokens: receipt.addedContextTokens,
			estimatedCostUsd: receipt.estimatedCostUsd,
			outcome: receipt.outcome,
			feedbackRefs: options.includeInternalRefs === false ? [] : receipt.feedbackRefs,
		},
		items,
	});
}
