// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryCategory, MemoryItemV1, SafeRef } from "@research-agent/contracts/memory";
import { canonicalizeJson } from "../contracts/canonical-json.ts";
import type { JsonValue, ResearchResult } from "../contracts/schemas.ts";
import { hashBytes } from "../kernel/integrity.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { deletePersonalMemory, verifyMemoryDeletion } from "../memory/deletion.ts";
import { applyMemoryFeedback } from "../memory/feedback.ts";
import { memoryProfileRoot as resolveMemoryProfileRoot, validateMemoryIdentifier } from "../memory/layout.ts";
import {
	createMemoryProfile,
	loadCanonicalMemoryState,
	openMemoryProfile,
	setMemoryProfileStatus,
} from "../memory/store.ts";
import {
	exportEncryptedMemoryTransfer,
	importEncryptedMemoryTransfer,
	MemoryTransferError,
	verifyEncryptedMemoryTransfer,
} from "../memory/transfer.ts";
import { configuredMemoryHome, configuredProfileRoots } from "./memory-capture.ts";

type CommandResult = ResearchResult<JsonValue>;
type WritableProfile = Extract<Awaited<ReturnType<typeof openMemoryProfile>>, { mode: "read-write" }>;

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

function ok(value: unknown): CommandResult {
	return successResult(canonicalizeJson(value), null);
}

function blocked(code: string, message: string, category: "permission" | "cancelled" = "permission"): CommandResult {
	return failureResult("PERMISSION_BLOCKED", code, category, message, null);
}

function command(args: string): { action: string; rest: string } {
	const trimmed = args.trim();
	if (trimmed.length === 0) throw new TypeError("Usage: /memory <action> [arguments]");
	const separator = trimmed.search(/\s/u);
	return separator < 0
		? { action: trimmed, rest: "" }
		: { action: trimmed.slice(0, separator), rest: trimmed.slice(separator).trim() };
}

function exactArgument(value: string, usage: string): string {
	if (value.length === 0 || /\s/u.test(value)) throw new TypeError(usage);
	return value;
}

function pathArgument(value: string, cwd: string, usage: string): string {
	if (value.length === 0 || value.includes("\0")) throw new TypeError(usage);
	const unquoted =
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
			? value.slice(1, -1)
			: value;
	if (unquoted.length === 0) throw new TypeError(usage);
	return resolve(cwd, unquoted);
}

function latestItems(items: readonly MemoryItemV1[]): MemoryItemV1[] {
	const latest = new Map<string, MemoryItemV1>();
	for (const item of items) {
		const current = latest.get(item.memoryId);
		if (current === undefined || item.revision > current.revision) latest.set(item.memoryId, item);
	}
	return [...latest.values()].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
}

function latestItem(opened: WritableProfile, memoryIdInput: string): MemoryItemV1 {
	const memoryId = validateMemoryIdentifier(memoryIdInput, "memoryId");
	const item = latestItems(opened.items).find((candidate) => candidate.memoryId === memoryId);
	if (item === undefined) throw new Error(`MEMORY_NOT_FOUND: ${memoryId}`);
	return item;
}

function itemSummary(item: MemoryItemV1) {
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

function shownItem(item: MemoryItemV1): JsonValue {
	return canonicalizeJson({
		...itemSummary(item),
		value: item.value === null || item.dataClass !== "restricted" ? item.value : "[redacted:restricted]",
		independentSupportCount: item.independentSupportCount,
		contradictionCount: item.contradictionCount,
		criticalDecisionPolicy: item.criticalDecisionPolicy,
		provenanceHash: item.provenanceHash,
		sourceSignalCount: item.sourceSignalRefs.length,
		createdAt: item.createdAt,
	});
}

function filterItems(items: readonly MemoryItemV1[], filter: string): MemoryItemV1[] {
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
	throw new TypeError("Usage: /memory list [category|global|domain[:id]|project[:id]]");
}

async function profileRoots(): Promise<string[]> {
	try {
		return await configuredProfileRoots();
	} catch {
		throw new Error("MEMORY_PROFILE_UNAVAILABLE");
	}
}

async function profileRoot(): Promise<string> {
	const roots = await profileRoots();
	const root = roots.length === 1 ? roots[0] : undefined;
	if (root === undefined) {
		throw new Error("MEMORY_PROFILE_UNAVAILABLE: DORO_HOME must contain exactly one valid profile");
	}
	return root;
}

async function writableProfile(root: string): Promise<WritableProfile> {
	const opened = await openMemoryProfile(root, { rebuildCache: false });
	if (opened.mode === "read-write") return opened;
	throw new Error(`MEMORY_PROFILE_READ_ONLY: ${opened.issues.map(({ code }) => code).join(",")}`);
}

function userSourceRef(ctx: ExtensionCommandContext): SafeRef {
	return {
		kind: "session",
		locator: `session:${hashBytes(ctx.sessionManager.getSessionId()).value}`,
		dataClass: "internal",
	};
}

async function confirmMutation(
	ctx: ExtensionCommandContext,
	title: string,
	message: string,
): Promise<CommandResult | null> {
	if (!ctx.hasUI) {
		return blocked("MEMORY_CONFIRMATION_REQUIRED", "Memory mutations require interactive confirmation");
	}
	if (!(await ctx.ui.confirm(title, message))) {
		return blocked("MEMORY_CONFIRMATION_CANCELLED", "Memory mutation was cancelled", "cancelled");
	}
	return null;
}

async function promptPassphrase(ctx: ExtensionCommandContext, confirm: boolean): Promise<Buffer | CommandResult> {
	const first = await ctx.ui.input("Memory transfer passphrase", "Passphrase is not stored in command history");
	if (first === undefined || first.length === 0) {
		return blocked("MEMORY_PASSPHRASE_CANCELLED", "Memory transfer passphrase was not provided", "cancelled");
	}
	if (confirm) {
		const second = await ctx.ui.input("Confirm memory transfer passphrase", "Enter the same passphrase again");
		if (second !== first) {
			return blocked("MEMORY_PASSPHRASE_MISMATCH", "Memory transfer passphrases did not match", "cancelled");
		}
	}
	return Buffer.from(first, "utf8");
}

function parseJsonOrText(value: string): JsonValue {
	try {
		return canonicalizeJson(JSON.parse(value));
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return value;
	}
}

async function status(ctx: ExtensionCommandContext): Promise<CommandResult> {
	const roots = await profileRoots();
	let root = roots.length === 1 ? (roots[0] ?? null) : null;
	const doroHome = configuredMemoryHome();
	if (
		root === null &&
		roots.length === 0 &&
		doroHome !== null &&
		ctx.hasUI &&
		(await ctx.ui.confirm(
			"Initialize Personal Memory",
			"Create an empty, local Doro memory profile using the current default policies?",
		))
	) {
		const profileId = `profile_${randomUUID()}`;
		root = resolveMemoryProfileRoot(doroHome, profileId);
		try {
			await createMemoryProfile(root, { profileId, createdBy: "user" });
		} catch {
			throw new Error("MEMORY_PROFILE_INITIALIZATION_FAILED");
		}
	}
	if (root === null) {
		return ok({
			format: "doro-memory-status",
			version: 1,
			availability: "unavailable",
			mode: "read-only",
			reasonCode: roots.length > 1 ? "memory.profile_ambiguous" : "memory.profile_unavailable",
		});
	}
	const opened = await openMemoryProfile(root, { rebuildCache: false });
	if (opened.mode === "read-only") {
		return ok({
			format: "doro-memory-status",
			version: 1,
			availability: "degraded",
			mode: opened.mode,
			profileId: opened.profile?.profileId ?? null,
			profileRevision: opened.profile?.revision ?? null,
			profileStatus: opened.profile?.status ?? null,
			pendingTransactionCount: opened.pendingTransactions.length,
			issueCodes: opened.issues.map(({ code }) => code),
		});
	}
	return ok({
		format: "doro-memory-status",
		version: 1,
		availability: "available",
		mode: opened.mode,
		profileId: opened.profile.profileId,
		profileRevision: opened.profile.revision,
		profileStatus: opened.profile.status,
		learningMode: opened.profile.learningPolicy.mode,
		rootHash: opened.profile.currentItemRootHash,
		cacheStatus: opened.cacheStatus,
		activeItemCount: opened.activeItems.length,
		counts: opened.counts,
	});
}

async function list(filter: string): Promise<CommandResult> {
	const opened = await writableProfile(await profileRoot());
	return ok({
		filter: filter || null,
		items: filterItems(latestItems(opened.items), filter).map(itemSummary),
	});
}

async function show(memoryId: string): Promise<CommandResult> {
	const opened = await writableProfile(await profileRoot());
	const item = latestItem(opened, memoryId);
	return ok({
		item: shownItem(item),
		history: opened.items
			.filter((candidate) => candidate.memoryId === item.memoryId)
			.sort((left, right) => left.revision - right.revision)
			.map(({ revision, status, validFrom, validUntil }) => ({ revision, status, validFrom, validUntil })),
	});
}

async function explain(receiptIdInput: string): Promise<CommandResult> {
	const opened = await writableProfile(await profileRoot());
	const state = await loadCanonicalMemoryState(opened.root, opened.profile);
	const receipts = [...state.receipts].sort(
		(left, right) => left.appliedAt.localeCompare(right.appliedAt) || left.receiptId.localeCompare(right.receiptId),
	);
	const receipt =
		receiptIdInput.length === 0 || receiptIdInput === "last"
			? receipts.at(-1)
			: receipts.find(({ receiptId }) => receiptId === validateMemoryIdentifier(receiptIdInput, "receiptId"));
	if (receipt === undefined) throw new Error("MEMORY_RECEIPT_NOT_FOUND");
	const items = receipt.itemRefs.map((ref) => {
		const item = state.items.find(
			(candidate) => candidate.memoryId === ref.memoryId && candidate.revision === ref.revision,
		);
		return item === undefined
			? { ...ref, status: "unavailable" }
			: {
					...ref,
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
	return ok({
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
			feedbackRefs: receipt.feedbackRefs,
		},
		items,
	});
}

async function correct(rest: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const parsed = /^(\S+)\s+--value\s+([\s\S]+)$/u.exec(rest);
	if (parsed === null) throw new TypeError("Usage: /memory correct <memory-id> --value <json-or-text>");
	const root = await profileRoot();
	const item = latestItem(await writableProfile(root), parsed[1] as string);
	const denied = await confirmMutation(
		ctx,
		"Correct personal memory",
		`Replace ${item.memoryId} revision ${item.revision} with a user-confirmed value?`,
	);
	if (denied !== null) return denied;
	const applied = await applyMemoryFeedback(root, {
		feedbackId: `feedback_${randomUUID()}`,
		target: { memoryId: item.memoryId, revision: item.revision },
		action: "correct",
		correction: { key: item.key, value: parseJsonOrText(parsed[2] as string) },
		sourceRef: userSourceRef(ctx),
		reasonCode: "user_corrected",
		requestedAt: new Date().toISOString(),
	});
	return ok({
		transactionId: applied.transactionId,
		item: shownItem(applied.item),
		feedbackId: applied.feedback.feedbackId,
	});
}

async function forget(memoryIdInput: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const root = await profileRoot();
	const item = latestItem(await writableProfile(root), memoryIdInput);
	const denied = await confirmMutation(
		ctx,
		"Forget personal memory",
		`Stop applying ${item.memoryId} revision ${item.revision}?`,
	);
	if (denied !== null) return denied;
	const applied = await applyMemoryFeedback(root, {
		feedbackId: `feedback_${randomUUID()}`,
		target: { memoryId: item.memoryId, revision: item.revision },
		action: "forget",
		correction: null,
		sourceRef: userSourceRef(ctx),
		reasonCode: "user_requested",
		requestedAt: new Date().toISOString(),
	});
	return ok({
		transactionId: applied.transactionId,
		item: shownItem(applied.item),
		feedbackId: applied.feedback.feedbackId,
	});
}

async function remove(memoryIdInput: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const root = await profileRoot();
	const item = latestItem(await writableProfile(root), memoryIdInput);
	const denied = await confirmMutation(
		ctx,
		"Delete personal memory",
		`Permanently remove Doro's semantic records for ${item.memoryId} and create a deletion tombstone?`,
	);
	if (denied !== null) return denied;
	const deleted = await deletePersonalMemory(root, {
		feedbackId: `feedback_${randomUUID()}`,
		target: { memoryId: item.memoryId, revision: item.revision },
		sourceRef: userSourceRef(ctx),
		requestedAt: new Date().toISOString(),
		reasonCode: "user_requested",
	});
	return ok({
		transactionId: deleted.transactionId,
		memoryId: deleted.tombstone.memoryId,
		terminalRevision: deleted.tombstone.terminalRevision,
		verification: deleted.verification,
	});
}

async function setStatus(action: "pause" | "resume", ctx: ExtensionCommandContext): Promise<CommandResult> {
	const denied = await confirmMutation(
		ctx,
		action === "pause" ? "Pause personal memory" : "Resume personal memory",
		action === "pause"
			? "Stop signal capture, consolidation, and personalization until resumed?"
			: "Resume signal capture, consolidation, and personalization for future events?",
	);
	if (denied !== null) return denied;
	const updated = await setMemoryProfileStatus(await profileRoot(), action === "pause" ? "paused" : "active");
	return ok({
		changed: updated.changed,
		transactionId: updated.transactionId,
		profileId: updated.profile.profileId,
		profileRevision: updated.profile.revision,
		profileStatus: updated.profile.status,
	});
}

async function exportMemory(destinationInput: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const destination = pathArgument(destinationInput, ctx.cwd, "Usage: /memory export <destination>");
	const denied = await confirmMutation(
		ctx,
		"Export personal memory",
		"Write one encrypted, exclusive-create memory bundle to the requested destination?",
	);
	if (denied !== null) return denied;
	const passphrase = await promptPassphrase(ctx, true);
	if (!Buffer.isBuffer(passphrase)) return passphrase;
	try {
		const exported = await exportEncryptedMemoryTransfer(await profileRoot(), destination, passphrase);
		return ok({
			destinationName: basename(exported.destination),
			bytes: exported.bytes,
			snapshotId: exported.snapshot.snapshotId,
			profileId: exported.snapshot.profileId,
			profileRevision: exported.snapshot.profileRevision,
		});
	} catch (error) {
		throw new Error(error instanceof MemoryTransferError ? error.code : "MEMORY_TRANSFER_FAILED");
	} finally {
		passphrase.fill(0);
	}
}

async function importMemory(bundleInput: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const bundle = pathArgument(bundleInput, ctx.cwd, "Usage: /memory import <bundle>");
	const doroHome = configuredMemoryHome();
	if (doroHome === null) throw new Error("MEMORY_HOME_UNAVAILABLE: DORO_HOME must be an absolute path");
	const denied = await confirmMutation(
		ctx,
		"Import personal memory",
		"Authenticate, validate, and atomically import this memory bundle into DORO_HOME?",
	);
	if (denied !== null) return denied;
	const passphrase = await promptPassphrase(ctx, false);
	if (!Buffer.isBuffer(passphrase)) return passphrase;
	try {
		const verified = await verifyEncryptedMemoryTransfer(bundle, passphrase);
		const currentProfileIds = (await profileRoots()).map((root) => basename(root));
		if (
			currentProfileIds.length > 1 ||
			(currentProfileIds.length === 1 && currentProfileIds[0] !== verified.snapshot.profileId)
		) {
			return failureResult(
				"DATA_CONFLICT",
				"MEMORY_IMPORT_PROFILE_CONFLICT",
				"data_conflict",
				"The current memory home is bound to a different or ambiguous profile",
				null,
			);
		}
		const imported = await importEncryptedMemoryTransfer(doroHome, bundle, passphrase);
		return ok({
			outcome: imported.outcome,
			profileId: imported.profileId,
			profileRevision: imported.profileRevision,
			snapshotId: imported.snapshotId,
			manifestRecorded: imported.manifestRecorded,
		});
	} catch (error) {
		throw new Error(error instanceof MemoryTransferError ? error.code : "MEMORY_TRANSFER_FAILED");
	} finally {
		passphrase.fill(0);
	}
}

export async function runMemoryCommand(args: string, ctx: ExtensionCommandContext): Promise<CommandResult> {
	const parsed = command(args);
	switch (parsed.action) {
		case "status":
			if (parsed.rest.length > 0) throw new TypeError("Usage: /memory status");
			return status(ctx);
		case "list":
			return list(parsed.rest);
		case "show":
			return show(exactArgument(parsed.rest, "Usage: /memory show <memory-id>"));
		case "explain":
			return explain(parsed.rest);
		case "correct":
			return correct(parsed.rest, ctx);
		case "forget":
			return forget(exactArgument(parsed.rest, "Usage: /memory forget <memory-id>"), ctx);
		case "delete":
			return remove(exactArgument(parsed.rest, "Usage: /memory delete <memory-id>"), ctx);
		case "pause":
		case "resume":
			if (parsed.rest.length > 0) throw new TypeError(`Usage: /memory ${parsed.action}`);
			return setStatus(parsed.action, ctx);
		case "export":
			return exportMemory(parsed.rest, ctx);
		case "import":
			return importMemory(parsed.rest, ctx);
		case "verify-delete":
			return ok(
				await verifyMemoryDeletion(
					await profileRoot(),
					exactArgument(parsed.rest, "Usage: /memory verify-delete <memory-id>"),
				),
			);
		default:
			throw new TypeError(`Unknown /memory action: ${parsed.action}`);
	}
}
