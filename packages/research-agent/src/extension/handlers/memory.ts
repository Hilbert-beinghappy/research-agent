// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryItemV1, SafeRef } from "@research-agent/contracts/memory";
import type { Static } from "typebox";
import { canonicalStringify } from "../../contracts/canonical-json.ts";
import type { JsonValue, ResearchResult } from "../../contracts/schemas.ts";
import { hashBytes } from "../../kernel/integrity.ts";
import { failureResult, successResult } from "../../kernel/results.ts";
import { deletePersonalMemory } from "../../memory/deletion.ts";
import { applyMemoryFeedback } from "../../memory/feedback.ts";
import { loadCanonicalMemoryState, openMemoryProfile } from "../../memory/store.ts";
import {
	filterMemoryItems,
	latestMemoryItem,
	latestMemoryItems,
	memoryItemSummary,
	memoryItemsVisibleToProject,
	memoryReceiptExplanation,
} from "../../memory/views.ts";
import { configuredProfileRoots } from "../memory-capture.ts";
import { type CurrentProject, jsonValue, type RegisterResearchToolsOptions } from "../tool-operations.ts";
import { MemoryFeedbackParameters, MemoryInspectParameters } from "../tool-schemas.ts";
import { runModelVisibleHandler } from "./runtime.ts";

type WritableProfile = Extract<Awaited<ReturnType<typeof openMemoryProfile>>, { mode: "read-write" }>;
type InspectParameters = Static<typeof MemoryInspectParameters>;
type FeedbackParameters = Static<typeof MemoryFeedbackParameters>;
const modelMemoryViewLimit = 100;

function ok(value: unknown): ResearchResult<JsonValue> {
	return successResult(jsonValue(value), null);
}

function memoryFailure(error: unknown): ResearchResult<JsonValue> {
	const raw = error instanceof Error ? error.message : "";
	const code = /^(?:MEMORY_[A-Z0-9_]+|DATA_CONFLICT)/u.exec(raw)?.[0] ?? "MEMORY_TOOL_FAILED";
	return failureResult(
		code === "DATA_CONFLICT" ? "DATA_CONFLICT" : "PERMANENT_FAILURE",
		code,
		error instanceof TypeError ? "validation" : code === "DATA_CONFLICT" ? "data_conflict" : "runtime",
		code,
		null,
	);
}

async function roots(): Promise<string[]> {
	try {
		return await configuredProfileRoots();
	} catch {
		throw new Error("MEMORY_PROFILE_UNAVAILABLE");
	}
}

async function currentProfile(): Promise<WritableProfile> {
	const candidates = await roots();
	const root = candidates.length === 1 ? candidates[0] : undefined;
	if (root === undefined) throw new Error("MEMORY_PROFILE_UNAVAILABLE");
	const opened = await openMemoryProfile(root, { rebuildCache: false });
	if (opened.mode === "read-write") return opened;
	throw new Error(`MEMORY_PROFILE_READ_ONLY: ${opened.issues.map(({ code }) => code).join(",")}`);
}

function classifiedItem(item: ReturnType<typeof latestMemoryItem>): JsonValue {
	return jsonValue({
		...memoryItemSummary(item),
		independentSupportCount: item.independentSupportCount,
		contradictionCount: item.contradictionCount,
		criticalDecisionPolicy: item.criticalDecisionPolicy,
		sourceSignalCount: item.sourceSignalRefs.length,
	});
}

function modelVisibleItems(items: readonly MemoryItemV1[], project: CurrentProject): MemoryItemV1[] {
	return memoryItemsVisibleToProject(
		latestMemoryItems(items).filter(({ dataClass }) => dataClass !== "restricted"),
		project.manifest.projectId,
		project.manifest.domain.id,
	);
}

function modelVisibleItem(items: readonly MemoryItemV1[], memoryId: string, project: CurrentProject): MemoryItemV1 {
	const item = latestMemoryItem(items, memoryId);
	if (!modelVisibleItems([item], project).includes(item)) throw new Error("MEMORY_NOT_FOUND");
	return item;
}

async function inspectMemory(params: InspectParameters, project: CurrentProject): Promise<ResearchResult<JsonValue>> {
	if (params.action === "status") {
		if (params.filter !== undefined || params.memoryId !== undefined || params.receiptId !== undefined) {
			throw new TypeError("MEMORY_INSPECT_PARAMETERS_INVALID");
		}
		const candidates = await roots();
		if (candidates.length !== 1) {
			return ok({
				availability: candidates.length > 1 ? "ambiguous" : "unavailable",
				mode: "read-only",
			});
		}
		const opened = await openMemoryProfile(candidates[0] as string, { rebuildCache: false });
		return opened.mode === "read-write"
			? ok({
					availability: "available",
					mode: opened.mode,
					profileStatus: opened.profile.status,
					visibleItemCount: modelVisibleItems(opened.items, project).length,
				})
			: ok({
					availability: "degraded",
					mode: opened.mode,
					issueCodes: opened.issues.map(({ code }) => code),
				});
	}

	const opened = await currentProfile();
	if (params.action === "list") {
		if (params.memoryId !== undefined || params.receiptId !== undefined) {
			throw new TypeError("MEMORY_INSPECT_PARAMETERS_INVALID");
		}
		const filter = params.filter ?? "";
		const matches = filterMemoryItems(modelVisibleItems(opened.items, project), filter);
		return ok({
			filter: filter || null,
			items: matches.slice(0, modelMemoryViewLimit).map(memoryItemSummary),
			totalItemCount: matches.length,
			truncated: matches.length > modelMemoryViewLimit,
		});
	}
	if (params.action === "show") {
		if (params.memoryId === undefined || params.filter !== undefined || params.receiptId !== undefined) {
			throw new TypeError("MEMORY_INSPECT_PARAMETERS_INVALID");
		}
		const item = modelVisibleItem(opened.items, params.memoryId, project);
		const history = memoryItemsVisibleToProject(
			opened.items.filter(({ memoryId, dataClass }) => memoryId === item.memoryId && dataClass !== "restricted"),
			project.manifest.projectId,
			project.manifest.domain.id,
		).sort((left, right) => left.revision - right.revision);
		return ok({
			item: classifiedItem(item),
			history: history
				.slice(-modelMemoryViewLimit)
				.map(({ revision, status, validFrom, validUntil }) => ({ revision, status, validFrom, validUntil })),
			totalRevisionCount: history.length,
			truncated: history.length > modelMemoryViewLimit,
		});
	}
	if (params.filter !== undefined || params.memoryId !== undefined) {
		throw new TypeError("MEMORY_INSPECT_PARAMETERS_INVALID");
	}
	const state = await loadCanonicalMemoryState(opened.root, opened.profile);
	const allowedItemRefs = new Set(
		memoryItemsVisibleToProject(
			state.items.filter(({ dataClass }) => dataClass !== "restricted"),
			project.manifest.projectId,
			project.manifest.domain.id,
		).map(({ memoryId, revision }) => `${memoryId}:${revision}`),
	);
	return ok(
		memoryReceiptExplanation(state, params.receiptId ?? "last", {
			allowedItemRefs,
			includeInternalRefs: false,
		}),
	);
}

function userMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (part === null || typeof part !== "object" || Array.isArray(part)) return [];
			const value = part as Record<string, unknown>;
			return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
		})
		.join("\n");
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsExactMemoryId(text: string, memoryId: string): boolean {
	return new RegExp(`(?:^|[^A-Za-z0-9._-])${escapeRegularExpression(memoryId)}(?:$|[^A-Za-z0-9._-])`, "u").test(text);
}

function endsWithExactMemoryId(text: string, memoryId: string): boolean {
	return new RegExp(`${escapeRegularExpression(memoryId)}\\s*[。.!！?？]?$`, "u").test(text);
}

function endsWithExactCorrection(text: string, value: JsonValue): boolean {
	const valueText = typeof value === "string" ? value : canonicalStringify(value);
	return (
		valueText.length > 0 && new RegExp(`(?:为|成|to)\\s*${escapeRegularExpression(valueText)}\\s*$`, "iu").test(text)
	);
}

interface CurrentUserDirective {
	entryId: string;
	text: string;
}

function currentUserDirective(
	ctx: ExtensionContext,
	toolCallId: string,
	params: FeedbackParameters,
): CurrentUserDirective | null {
	const entries = ctx.sessionManager.buildContextEntries();
	let callIndex = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const call = entry.message.content.find(
			(content) =>
				content.type === "toolCall" && content.id === toolCallId && content.name === "research_memory_feedback",
		);
		if (call?.type !== "toolCall") continue;
		if (canonicalStringify(jsonValue(call.arguments)) !== canonicalStringify(jsonValue(params))) return null;
		callIndex = index;
		break;
	}
	if (callIndex < 0) return null;
	for (let index = callIndex - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "user") {
			return { entryId: entry.id, text: userMessageText(entry.message.content).trim() };
		}
	}
	return null;
}

function explicitDirective(text: string, params: FeedbackParameters): boolean {
	const patterns =
		params.action === "correct"
			? [
					/^(?:请(?:帮我)?|现在请)?(?:纠正|更正|修改)(?:这条|我的)?(?:个人)?记忆/u,
					/^(?:请)?(?:把)?(?:这条|我的)?(?:个人)?记忆.+(?:纠正|更正|修改)(?:为|成)/u,
					/^(?:please\s+)?(?:correct|update)\s+(?:my\s+|the\s+)?(?:personal\s+)?memory\b/iu,
				]
			: params.action === "forget"
				? [
						/^(?:请(?:帮我)?|现在请)?(?:忘记|遗忘)(?:这条|我的)?(?:个人)?记忆/u,
						/^(?:请)?(?:把)?(?:这条|我的)?(?:个人)?记忆.+(?:忘记|遗忘)/u,
						/^(?:please\s+)?forget\s+(?:my\s+|the\s+)?(?:personal\s+)?memory\b/iu,
					]
				: [
						/^(?:请(?:帮我)?|现在请)?(?:永久)?删除(?:这条|我的)?(?:个人)?记忆/u,
						/^(?:请)?(?:把)?(?:这条|我的)?(?:个人)?记忆.+(?:永久)?删除/u,
						/^(?:please\s+)?(?:permanently\s+)?delete\s+(?:my\s+|the\s+)?(?:personal\s+)?memory\b/iu,
					];
	if (!patterns.some((pattern) => pattern.test(text)) || !containsExactMemoryId(text, params.memoryId)) return false;
	if (params.action !== "correct") return endsWithExactMemoryId(text, params.memoryId);
	if (params.value === undefined) return false;
	return endsWithExactCorrection(text, params.value);
}

function sourceRef(
	ctx: ExtensionContext,
	toolCallId: string,
	params: FeedbackParameters,
	directive: CurrentUserDirective,
): SafeRef {
	return {
		kind: "session",
		locator: `session:turn-${
			hashBytes(
				canonicalStringify(
					jsonValue({
						sessionId: ctx.sessionManager.getSessionId(),
						userEntryId: directive.entryId,
						toolCallId,
						params,
					}),
				),
			).value
		}`,
		dataClass: "internal",
	};
}

async function feedbackMemory(
	toolCallId: string,
	params: FeedbackParameters,
	ctx: ExtensionContext,
	project: CurrentProject,
): Promise<ResearchResult<JsonValue>> {
	if (
		(params.action === "correct" && params.value === undefined) ||
		(params.action !== "correct" && params.value !== undefined)
	) {
		throw new TypeError("MEMORY_FEEDBACK_PARAMETERS_INVALID");
	}
	const directive = currentUserDirective(ctx, toolCallId, params);
	if (directive === null || !explicitDirective(directive.text, params)) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"MEMORY_USER_AUTHORIZATION_REQUIRED",
			"permission",
			"The latest user turn did not explicitly authorize this exact memory mutation",
			null,
		);
	}
	if (!ctx.hasUI) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"MEMORY_CONFIRMATION_REQUIRED",
			"permission",
			"Personal Memory feedback requires interactive confirmation",
			null,
		);
	}
	const opened = await currentProfile();
	const item = latestMemoryItem(opened.items, params.memoryId);
	if (memoryItemsVisibleToProject([item], project.manifest.projectId, project.manifest.domain.id).length === 0) {
		throw new Error("MEMORY_NOT_FOUND");
	}
	const confirmed = await ctx.ui.confirm(
		params.action === "correct"
			? "Confirm memory correction"
			: params.action === "forget"
				? "Confirm memory forget"
				: "Confirm memory deletion",
		params.action === "correct"
			? `${params.action} ${item.memoryId} revision ${item.revision} to ${canonicalStringify(params.value)}?`
			: `${params.action} ${item.memoryId} revision ${item.revision}?`,
	);
	if (!confirmed) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"MEMORY_CONFIRMATION_DENIED",
			"cancelled",
			"User denied the Personal Memory mutation",
			null,
		);
	}
	const requestedAt = new Date().toISOString();
	const feedbackId = `feedback_${randomUUID()}`;
	const feedbackSourceRef = sourceRef(ctx, toolCallId, params, directive);
	if (params.action === "delete") {
		const deleted = await deletePersonalMemory(opened.root, {
			feedbackId,
			target: { memoryId: item.memoryId, revision: item.revision },
			sourceRef: feedbackSourceRef,
			requestedAt,
			reasonCode: "user_requested",
		});
		return ok({
			action: params.action,
			confirmation: { kind: "memory_feedback", feedbackId, transactionId: deleted.transactionId },
			memoryId: item.memoryId,
			verification: {
				status: deleted.verification.status,
				checkedClasses: deleted.verification.checkedClasses,
				residueCodes: deleted.verification.residueCodes,
				physicalDeletionLimitation: deleted.verification.physicalDeletionLimitation,
			},
		});
	}
	const applied = await applyMemoryFeedback(opened.root, {
		feedbackId,
		target: { memoryId: item.memoryId, revision: item.revision },
		action: params.action,
		correction: params.action === "correct" ? { key: item.key, value: params.value as JsonValue } : null,
		sourceRef: feedbackSourceRef,
		reasonCode: params.action === "correct" ? "user_corrected" : "user_requested",
		requestedAt,
	});
	return ok({
		action: params.action,
		confirmation: { kind: "memory_feedback", feedbackId, transactionId: applied.transactionId },
		memoryId: applied.item.memoryId,
		resultingRevision: applied.item.revision,
		status: applied.item.status,
	});
}

export function registerMemoryHandlers(pi: ExtensionAPI, options: RegisterResearchToolsOptions): void {
	pi.registerTool({
		name: "research_memory_inspect",
		label: "Inspect Personal Memory",
		description:
			"Read classified Personal Memory status, item summaries, revision history, or use receipts without values or host paths.",
		promptSnippet:
			"Inspect Personal Memory only when it helps answer the current user request; never treat it as research evidence",
		parameters: MemoryInspectParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["personal_memory_summary"],
				"Project policy does not allow this model to inspect Personal Memory summaries",
				async (project) => {
					try {
						return await inspectMemory(params, project);
					} catch (error) {
						return memoryFailure(error);
					}
				},
			);
		},
	});

	pi.registerTool({
		name: "research_memory_feedback",
		label: "Apply Personal Memory feedback",
		description:
			"Correct, forget, or delete one Personal Memory item only when the latest user turn explicitly requests the exact mutation and confirms it interactively.",
		promptSnippet:
			"Never call proactively; require an explicit current-user correction, forget, or delete request for the exact memory ID and value",
		parameters: MemoryFeedbackParameters,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["personal_memory_summary"],
				"Project policy does not allow this model to apply Personal Memory feedback",
				async (project) => {
					try {
						return await feedbackMemory(toolCallId, params, ctx, project);
					} catch (error) {
						return memoryFailure(error);
					}
				},
			);
		},
	});
}
