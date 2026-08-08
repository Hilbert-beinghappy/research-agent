// SPDX-License-Identifier: Apache-2.0

import type {
	DataClass,
	MemoryCategory,
	MemoryEffect,
	MemoryItemV1,
	MemoryScope,
} from "@research-agent/contracts/memory";
import { hashCanonicalJson } from "../../../../src/contracts/integrity.ts";
import type { MemoryRetrievalQuery } from "../../../../src/memory/retrieval.ts";

export function hash(value: unknown): `sha256:${string}` {
	return `sha256:${hashCanonicalJson(value).value}`;
}

function criticalPolicy(category: MemoryCategory): MemoryItemV1["criticalDecisionPolicy"] {
	if (category === "domain" || category === "theory" || category === "method" || category === "evidence") {
		return "rank_only";
	}
	if (category === "writing" || category === "output") return "format_only";
	return "not_applicable";
}

export function itemDraft(
	profileId: string,
	memoryId: string,
	options: {
		category: MemoryCategory;
		key: string;
		value: MemoryItemV1["value"];
		scope?: MemoryScope;
		dataClass?: DataClass;
		allowedEffects: MemoryEffect[];
		origin?: MemoryItemV1["origin"];
		confidence?: number;
		lastSupportedAt?: string;
	},
): Omit<MemoryItemV1, "transactionId"> {
	const now = options.lastSupportedAt ?? "2026-08-01T12:00:00.000Z";
	return {
		format: "doro-memory-item",
		schemaVersion: "1.0.0",
		profileId,
		memoryId,
		revision: 1,
		previousRevision: null,
		status: "active",
		category: options.category,
		key: options.key,
		value: options.value,
		origin: options.origin ?? "explicit",
		scope: options.scope ?? { level: "global" },
		confidence: options.confidence ?? 1,
		supportCount: 3,
		independentSupportCount: 3,
		contradictionCount: 0,
		dataClass: options.dataClass ?? "public",
		allowedEffects: options.allowedEffects,
		criticalDecisionPolicy: criticalPolicy(options.category),
		sourceSignalRefs: [{ signalId: `signal-${memoryId}`, contentHash: hash({ memoryId }) }],
		supersedes: [],
		generator: { type: "rule", version: "test-v1", schemaHash: hash("memory-item-schema") },
		provenanceHash: hash({ profileId, memoryId }),
		validFrom: now,
		validUntil: null,
		lastSupportedAt: now,
		lastUsedAt: null,
		decay: { halfLifeDays: 180 },
		createdAt: now,
	};
}

export function retrievalQuery(overrides: Partial<MemoryRetrievalQuery> = {}): MemoryRetrievalQuery {
	return {
		taskCategories: ["writing", "output"],
		keywords: [],
		effect: "formatting",
		allowedDataClasses: ["public", "internal"],
		criticalDecision: false,
		availableContextTokens: 20_000,
		requestedMaxTokens: 800,
		now: "2026-08-08T12:00:00.000Z",
		...overrides,
	};
}
