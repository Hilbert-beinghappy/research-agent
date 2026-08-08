// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { MemoryUseReceiptV1, SafeRef } from "@research-agent/contracts/memory";
import { hashBytes } from "../contracts/integrity.ts";
import type { MemoryRetrievalQuery, MemoryRetrievalResult } from "./retrieval.ts";
import { retrievePersonalMemory } from "./retrieval.ts";
import { appendMemoryRecord, openMemoryProfile } from "./store.ts";

export interface MemoryUseContext {
	receiptId?: string;
	sessionRef: SafeRef;
	taskRef: SafeRef;
	operationRef?: SafeRef;
	artifactRef?: SafeRef;
	decisionCodeBefore: string;
	decisionCodeAfter: string;
	explanationCodes: string[];
	criticalResearchDecisionTouched: boolean;
	approvalRequired: boolean;
	appliedAt: string;
	estimatedCostUsd?: number;
}

export interface PersonalMemoryUseResult {
	retrieval: MemoryRetrievalResult;
	receipt: MemoryUseReceiptV1 | null;
}

async function recordAppliedMemoryUse(
	profileRoot: string,
	query: MemoryRetrievalQuery,
	retrieval: MemoryRetrievalResult,
	retrievalLatencyMs: number,
	context: MemoryUseContext,
): Promise<MemoryUseReceiptV1> {
	if (retrieval.status !== "applied" || retrieval.profileId === null || retrieval.profileRevision === null) {
		throw new Error("MEMORY_RECEIPT_NOT_APPLIED: only applied memory context can create a use receipt");
	}
	if (context.explanationCodes.length === 0) {
		throw new TypeError("Memory use receipts require at least one explanation code");
	}
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
	if (
		opened.mode !== "read-write" ||
		opened.profile.profileId !== retrieval.profileId ||
		opened.profile.revision !== retrieval.profileRevision ||
		opened.profile.currentItemRootHash !== retrieval.profileRootHash
	) {
		throw new Error("DATA_CONFLICT: memory profile changed before receipt persistence");
	}
	const activeRefs = new Map(
		opened.activeItems.map((item) => [`${item.memoryId}:${item.revision}`, item.provenanceHash] as const),
	);
	if (retrieval.items.some((item) => activeRefs.get(`${item.memoryId}:${item.revision}`) !== item.provenanceHash)) {
		throw new Error("DATA_CONFLICT: receipt item revision is no longer active");
	}
	const receipt: MemoryUseReceiptV1 = {
		format: "doro-memory-use-receipt",
		schemaVersion: "1.0.0",
		receiptId: context.receiptId ?? `receipt_${randomUUID()}`,
		profileId: retrieval.profileId,
		sessionRef: context.sessionRef,
		taskRef: context.taskRef,
		operationRef: context.operationRef ?? null,
		artifactRef: context.artifactRef ?? null,
		itemRefs: retrieval.items.map(({ memoryId, revision, provenanceHash }) => ({
			memoryId,
			revision,
			provenanceHash,
		})),
		effect: query.effect,
		decisionCodeBefore: context.decisionCodeBefore,
		decisionCodeAfter: context.decisionCodeAfter,
		explanationCodes: context.explanationCodes,
		criticalResearchDecisionTouched: context.criticalResearchDecisionTouched,
		approvalRequired: context.approvalRequired,
		appliedAt: context.appliedAt,
		retrievalLatencyMs,
		addedContextTokens: retrieval.estimatedTokens,
		estimatedCostUsd: context.estimatedCostUsd ?? 0,
		outcome: "applied",
		feedbackRefs: [],
		contextDigest: `sha256:${hashBytes(retrieval.context).value}`,
	};
	const appended = await appendMemoryRecord(profileRoot, receipt, {
		expectedProfileRevision: retrieval.profileRevision,
	});
	return appended.record as MemoryUseReceiptV1;
}

export async function retrievePersonalMemoryForUse(
	profileRoot: string,
	query: MemoryRetrievalQuery,
	context: MemoryUseContext,
): Promise<PersonalMemoryUseResult> {
	const started = performance.now();
	const retrieval = await retrievePersonalMemory(profileRoot, query);
	const retrievalLatencyMs = performance.now() - started;
	if (retrieval.status !== "applied") return { retrieval, receipt: null };
	return {
		retrieval,
		receipt: await recordAppliedMemoryUse(profileRoot, query, retrieval, retrievalLatencyMs, context),
	};
}
