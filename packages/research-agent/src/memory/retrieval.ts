// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from "node:fs/promises";
import type {
	DataClass,
	MemoryCategory,
	MemoryEffect,
	MemoryItemV1,
	MemoryScope,
	ResearcherProfileV1,
} from "@research-agent/contracts/memory";
import { validateMemoryItemV1 } from "@research-agent/contracts/memory-validators";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../contracts/integrity.ts";
import { atomicWriteFile } from "../project/atomic-write.ts";
import {
	MEMORY_PROFILE_PATH,
	MEMORY_RETRIEVAL_INDEX_HASH_PATH,
	MEMORY_RETRIEVAL_INDEX_PATH,
	resolveMemoryPath,
	validateMemoryIdentifier,
	validateMemoryLayout,
} from "./layout.ts";
import { openMemoryProfile } from "./store.ts";
import {
	listPendingMemoryTransactionsAtRoot,
	parseMemoryProfile,
	readMemoryProfileFile,
	withMemoryWriterLease,
} from "./transactions.ts";

export const MEMORY_CONTEXT_LABEL = "User preferences; not domain facts or research evidence.";
export { MEMORY_RETRIEVAL_INDEX_HASH_PATH, MEMORY_RETRIEVAL_INDEX_PATH };

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
const effects = new Set<MemoryEffect>([
	"routing",
	"ranking",
	"prompt_context",
	"formatting",
	"tool_order",
	"recommendation",
]);
const dataClasses = new Set<DataClass>(["public", "internal", "restricted"]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const dayMs = 86_400_000;

export interface MemoryRetrievalQuery {
	projectId?: string;
	domainId?: string;
	taskCategories: readonly MemoryCategory[];
	keywords: readonly string[];
	effect: MemoryEffect;
	allowedDataClasses: readonly DataClass[];
	criticalDecision: boolean;
	availableContextTokens: number;
	requestedMaxTokens?: number;
	now: string;
}

export interface RankedActiveMemoryItem {
	item: RankableMemoryItem;
	score: number;
	scopeMatch: number;
}

export interface RankableMemoryItem {
	memoryId: string;
	revision: number;
	status: MemoryItemV1["status"];
	category: MemoryCategory;
	key: string;
	value: MemoryItemV1["value"];
	origin: MemoryItemV1["origin"];
	scope: MemoryScope;
	confidence: number;
	supportCount: number;
	contradictionCount: number;
	dataClass: DataClass;
	allowedEffects: MemoryEffect[];
	criticalDecisionPolicy: MemoryItemV1["criticalDecisionPolicy"];
	validFrom: string;
	validUntil: string | null;
	lastSupportedAt: string;
	lastUsedAt: string | null;
	decay: MemoryItemV1["decay"];
	provenanceHash: string;
}

export interface RetrievedMemoryPreference {
	memoryId: string;
	revision: number;
	category: MemoryCategory;
	key: string;
	value: MemoryItemV1["value"];
	scope: MemoryScope["level"];
	dataClass: DataClass;
	effect: MemoryEffect;
	confidence: number;
	score: number;
	provenanceHash: string;
	authority: "preference_only";
	evidenceUse: "forbidden";
	decisionUse: "allowed_effect_only" | "rank_only";
}

export interface MemoryRetrievalResult {
	status: "applied" | "empty" | "blocked" | "unavailable";
	code:
		| "ok"
		| "no_eligible_items"
		| "budget_exhausted"
		| "invalid_query"
		| "critical_decision_memory_denied"
		| "profile_paused"
		| "memory_unavailable"
		| "canonical_recheck_failed";
	profileId: string | null;
	profileRevision: number | null;
	profileRootHash: string | null;
	cacheStatus: "valid" | "rebuilt" | "unavailable";
	tokenBudget: number;
	estimatedTokens: number;
	omittedCount: number;
	items: RetrievedMemoryPreference[];
	context: string;
}

interface RetrievalIndexEntry extends RankableMemoryItem {
	contentHash: string;
}

interface RetrievalIndexV1 {
	format: "doro-memory-retrieval-index";
	version: 1;
	basedOnProfileRevision: number;
	currentItemRootHash: string;
	items: RetrievalIndexEntry[];
}

interface ActiveItemSource {
	root: string;
	profile: ResearcherProfileV1;
	profileContentHash: string;
	items: RankableMemoryItem[];
	cacheStatus: "valid" | "rebuilt" | "unavailable";
}

interface CachedProfile {
	contentHash: string;
	indexBindingHash: string;
	profile: ResearcherProfileV1;
}

interface CachedRetrievalIndex {
	contentHash: string;
	profileIndexBindingHash: string;
	basedOnProfileRevision: number;
	indexFingerprint: FileFingerprint;
	items: RetrievalIndexEntry[];
}

interface FileFingerprint {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}

const profileCache = new Map<string, CachedProfile>();
const retrievalIndexCache = new Map<string, CachedRetrievalIndex>();

export async function clearPersonalMemoryRetrievalCache(profileRoot: string): Promise<void> {
	const root = await validateMemoryLayout(profileRoot);
	profileCache.delete(root);
	retrievalIndexCache.delete(root);
}

function remember<Value>(cache: Map<string, Value>, key: string, value: Value): void {
	cache.delete(key);
	cache.set(key, value);
	// ponytail: eight hot profiles bound memory; add a shared LRU only if more concurrent profiles are measured.
	if (cache.size <= 8) return;
	const oldest = cache.keys().next().value;
	if (oldest !== undefined) cache.delete(oldest);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTimestamp(value: string): number | null {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	const canonical = /\.\d{3}Z$/u.test(value) ? value : value.replace(/Z$/u, ".000Z");
	return new Date(parsed).toISOString() === canonical ? parsed : null;
}

function unique<T>(values: readonly T[]): boolean {
	return new Set(values).size === values.length;
}

function validQuery(query: MemoryRetrievalQuery): boolean {
	return (
		(query.projectId === undefined || identifierPattern.test(query.projectId)) &&
		(query.domainId === undefined || identifierPattern.test(query.domainId)) &&
		Array.isArray(query.taskCategories) &&
		query.taskCategories.length <= 8 &&
		query.taskCategories.every((category) => categories.has(category)) &&
		unique(query.taskCategories) &&
		Array.isArray(query.keywords) &&
		query.keywords.length <= 32 &&
		query.keywords.every(
			(keyword) =>
				typeof keyword === "string" && keyword.length > 0 && keyword.length <= 64 && !/[\r\n]/u.test(keyword),
		) &&
		effects.has(query.effect) &&
		Array.isArray(query.allowedDataClasses) &&
		query.allowedDataClasses.length > 0 &&
		query.allowedDataClasses.every((dataClass) => dataClasses.has(dataClass)) &&
		unique(query.allowedDataClasses) &&
		typeof query.criticalDecision === "boolean" &&
		Number.isInteger(query.availableContextTokens) &&
		query.availableContextTokens > 0 &&
		(query.requestedMaxTokens === undefined ||
			(Number.isInteger(query.requestedMaxTokens) && query.requestedMaxTokens > 0)) &&
		canonicalTimestamp(query.now) !== null
	);
}

function scopeMatch(scope: MemoryScope, query: MemoryRetrievalQuery): number | null {
	switch (scope.level) {
		case "global":
			return 0.5;
		case "domain":
			return query.domainId === scope.domainId ? 0.75 : null;
		case "project":
			return query.projectId === scope.projectId ? 1 : null;
	}
}

function scopeSpecificity(scope: MemoryScope): number {
	return scope.level === "project" ? 2 : scope.level === "domain" ? 1 : 0;
}

function decay(timestamp: string, halfLifeDays: number | null, now: number): number {
	const ageDays = Math.max(0, (now - Date.parse(timestamp)) / dayMs);
	if (halfLifeDays === null) return 1;
	if (halfLifeDays === 0) return ageDays === 0 ? 1 : 0;
	return 2 ** (-ageDays / halfLifeDays);
}

function matchesKeyword(item: RankableMemoryItem, keywords: readonly string[]): boolean {
	const searchable = canonicalStringify({ key: item.key, value: item.value })
		.normalize("NFKC")
		.toLocaleLowerCase("en-US");
	return keywords.some((keyword) => searchable.includes(keyword.normalize("NFKC").toLocaleLowerCase("en-US")));
}

function ranked(item: RankableMemoryItem, query: MemoryRetrievalQuery, now: number): RankedActiveMemoryItem | null {
	const matchedScope = scopeMatch(item.scope, query);
	if (
		item.status !== "active" ||
		matchedScope === null ||
		!query.allowedDataClasses.includes(item.dataClass) ||
		!item.allowedEffects.includes(query.effect) ||
		Date.parse(item.validFrom) > now ||
		(item.validUntil !== null && Date.parse(item.validUntil) <= now) ||
		(query.criticalDecision && (query.effect !== "ranking" || item.criticalDecisionPolicy !== "rank_only"))
	) {
		return null;
	}
	const taskMatch = query.taskCategories.includes(item.category) ? 1 : matchesKeyword(item, query.keywords) ? 0.5 : 0;
	const recency = decay(item.lastSupportedAt, item.decay.halfLifeDays, now);
	const priorUsefulness = item.lastUsedAt === null ? 0 : decay(item.lastUsedAt, 180, now);
	const contradictionPenalty = Math.min(
		0.5,
		item.contradictionCount / Math.max(1, item.supportCount + item.contradictionCount),
	);
	return {
		item,
		scopeMatch: matchedScope,
		score: Number(
			(
				0.35 * matchedScope +
				0.25 * taskMatch +
				0.2 * item.confidence +
				0.1 * recency +
				0.1 * priorUsefulness -
				contradictionPenalty
			).toFixed(6),
		),
	};
}

function compareRanked(left: RankedActiveMemoryItem, right: RankedActiveMemoryItem): number {
	return (
		right.score - left.score ||
		scopeSpecificity(right.item.scope) - scopeSpecificity(left.item.scope) ||
		right.item.confidence - left.item.confidence ||
		right.item.lastSupportedAt.localeCompare(left.item.lastSupportedAt) ||
		left.item.memoryId.localeCompare(right.item.memoryId) ||
		right.item.revision - left.item.revision
	);
}

export function rankActiveMemoryItems(
	items: readonly RankableMemoryItem[],
	query: MemoryRetrievalQuery,
): RankedActiveMemoryItem[] {
	const now = Date.parse(query.now);
	const groups = new Map<string, RankedActiveMemoryItem[]>();
	for (const item of items) {
		const result = ranked(item, query, now);
		if (result === null) continue;
		const key = `${item.category}:${item.key}`;
		const group = groups.get(key) ?? [];
		group.push(result);
		groups.set(key, group);
	}
	const resolved: RankedActiveMemoryItem[] = [];
	for (const group of groups.values()) {
		const explicit = group.filter(({ item }) => item.origin === "explicit");
		const authoritative = explicit.length > 0 ? explicit : group;
		const specificity = Math.max(...authoritative.map(({ item }) => scopeSpecificity(item.scope)));
		const scoped = authoritative.filter(({ item }) => scopeSpecificity(item.scope) === specificity);
		if (new Set(scoped.map(({ item }) => canonicalStringify(item.value))).size > 1) continue;
		resolved.push(scoped.sort(compareRanked)[0] as RankedActiveMemoryItem);
	}
	return resolved.sort(compareRanked);
}

function profileRefs(
	profile: ResearcherProfileV1,
): Array<{ category: MemoryCategory; memoryId: string; revision: number }> {
	return [...categories]
		.flatMap((category) => (profile.preferenceRefs[category] ?? []).map((ref) => ({ category, ...ref })))
		.sort(
			(left, right) =>
				left.category.localeCompare(right.category) ||
				left.memoryId.localeCompare(right.memoryId) ||
				left.revision - right.revision,
		);
}

function validScope(value: unknown): value is MemoryScope {
	if (!isObject(value)) return false;
	if (value.level === "global") return Object.keys(value).length === 1;
	if (value.level === "domain") return typeof value.domainId === "string" && identifierPattern.test(value.domainId);
	return value.level === "project" && typeof value.projectId === "string" && identifierPattern.test(value.projectId);
}

function validIndexItem(item: Record<string, unknown>): boolean {
	return (
		typeof item.memoryId === "string" &&
		identifierPattern.test(item.memoryId) &&
		Number.isInteger(item.revision) &&
		Number(item.revision) >= 1 &&
		item.status === "active" &&
		typeof item.category === "string" &&
		categories.has(item.category as MemoryCategory) &&
		typeof item.key === "string" &&
		(item.origin === "explicit" || item.origin === "inferred") &&
		validScope(item.scope) &&
		typeof item.confidence === "number" &&
		Number.isFinite(item.confidence) &&
		item.confidence >= 0 &&
		item.confidence <= 1 &&
		Number.isInteger(item.supportCount) &&
		Number(item.supportCount) >= 0 &&
		Number.isInteger(item.contradictionCount) &&
		Number(item.contradictionCount) >= 0 &&
		typeof item.dataClass === "string" &&
		dataClasses.has(item.dataClass as DataClass) &&
		Array.isArray(item.allowedEffects) &&
		item.allowedEffects.every((effect) => typeof effect === "string" && effects.has(effect as MemoryEffect)) &&
		(item.criticalDecisionPolicy === "rank_only" ||
			item.criticalDecisionPolicy === "format_only" ||
			item.criticalDecisionPolicy === "not_applicable") &&
		typeof item.validFrom === "string" &&
		canonicalTimestamp(item.validFrom) !== null &&
		(item.validUntil === null ||
			(typeof item.validUntil === "string" && canonicalTimestamp(item.validUntil) !== null)) &&
		typeof item.lastSupportedAt === "string" &&
		canonicalTimestamp(item.lastSupportedAt) !== null &&
		(item.lastUsedAt === null ||
			(typeof item.lastUsedAt === "string" && canonicalTimestamp(item.lastUsedAt) !== null)) &&
		isObject(item.decay) &&
		(item.decay.halfLifeDays === null ||
			(typeof item.decay.halfLifeDays === "number" &&
				Number.isFinite(item.decay.halfLifeDays) &&
				item.decay.halfLifeDays >= 0)) &&
		typeof item.provenanceHash === "string" &&
		hashPattern.test(item.provenanceHash) &&
		typeof item.contentHash === "string" &&
		hashPattern.test(item.contentHash)
	);
}

function indexItems(value: unknown, profile: ResearcherProfileV1): RetrievalIndexEntry[] | null {
	if (!Array.isArray(value)) return null;
	const refs = new Set(
		profileRefs(profile).map(({ category, memoryId, revision }) => `${category}:${memoryId}:${revision}`),
	);
	if (value.length !== refs.size) return null;
	for (const item of value) {
		if (!isObject(item) || !validIndexItem(item)) return null;
		if (!refs.delete(`${item.category as string}:${item.memoryId as string}:${item.revision as number}`)) return null;
		try {
			canonicalStringify(item.value);
		} catch {
			return null;
		}
	}
	return refs.size === 0 ? (value as RetrievalIndexEntry[]) : null;
}

async function readProfileSnapshot(root: string): Promise<CachedProfile> {
	const text = await readFile(await resolveMemoryPath(root, MEMORY_PROFILE_PATH), "utf8");
	const contentHash = `sha256:${hashBytes(text).value}`;
	const cached = profileCache.get(root);
	if (cached?.contentHash === contentHash) return cached;
	const profile = parseMemoryProfile(text, MEMORY_PROFILE_PATH);
	const snapshot = {
		contentHash,
		indexBindingHash: `sha256:${
			hashCanonicalJson({
				revision: profile.revision,
				currentItemRootHash: profile.currentItemRootHash,
				preferenceRefs: profile.preferenceRefs,
			}).value
		}`,
		profile,
	};
	remember(profileCache, root, snapshot);
	return snapshot;
}

async function fileFingerprint(path: string): Promise<FileFingerprint> {
	const stats = await stat(path, { bigint: true });
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
	};
}

function sameFileFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

async function readRetrievalIndex(
	root: string,
	profile: ResearcherProfileV1,
	profileIndexBindingHash: string,
): Promise<RetrievalIndexEntry[] | null> {
	const [indexPath, hashPath] = await Promise.all([
		resolveMemoryPath(root, MEMORY_RETRIEVAL_INDEX_PATH, { allowMissing: true }),
		resolveMemoryPath(root, MEMORY_RETRIEVAL_INDEX_HASH_PATH, { allowMissing: true }),
	]);
	const [expectedHash, before] = await Promise.all([readFile(hashPath, "utf8"), fileFingerprint(indexPath)]);
	const cached = retrievalIndexCache.get(root);
	if (
		cached !== undefined &&
		expectedHash === `${cached.contentHash}\n` &&
		cached.profileIndexBindingHash === profileIndexBindingHash &&
		cached.basedOnProfileRevision === profile.revision &&
		sameFileFingerprint(cached.indexFingerprint, before)
	) {
		return cached.items;
	}
	const text = await readFile(indexPath, "utf8");
	const after = await fileFingerprint(indexPath);
	if (!sameFileFingerprint(before, after)) return null;
	const contentHash = `sha256:${hashBytes(text).value}`;
	if (expectedHash !== `${contentHash}\n`) return null;
	const parsed: unknown = JSON.parse(text);
	if (
		!isObject(parsed) ||
		parsed.format !== "doro-memory-retrieval-index" ||
		parsed.version !== 1 ||
		parsed.basedOnProfileRevision !== profile.revision ||
		parsed.currentItemRootHash !== profile.currentItemRootHash
	) {
		return null;
	}
	const items = indexItems(parsed.items, profile);
	if (items !== null) {
		remember(retrievalIndexCache, root, {
			contentHash,
			profileIndexBindingHash,
			basedOnProfileRevision: profile.revision,
			indexFingerprint: after,
			items,
		});
	}
	return items;
}

function retrievalIndexEntry(item: MemoryItemV1): RetrievalIndexEntry {
	return {
		memoryId: item.memoryId,
		revision: item.revision,
		status: item.status,
		category: item.category,
		key: item.key,
		value: item.value,
		origin: item.origin,
		scope: item.scope,
		confidence: item.confidence,
		supportCount: item.supportCount,
		contradictionCount: item.contradictionCount,
		dataClass: item.dataClass,
		allowedEffects: item.allowedEffects,
		criticalDecisionPolicy: item.criticalDecisionPolicy,
		validFrom: item.validFrom,
		validUntil: item.validUntil,
		lastSupportedAt: item.lastSupportedAt,
		lastUsedAt: item.lastUsedAt,
		decay: item.decay,
		provenanceHash: item.provenanceHash,
		contentHash: `sha256:${hashCanonicalJson(item).value}`,
	};
}

async function writeRetrievalIndex(root: string, profile: ResearcherProfileV1, items: MemoryItemV1[]): Promise<void> {
	const document: RetrievalIndexV1 = {
		format: "doro-memory-retrieval-index",
		version: 1,
		basedOnProfileRevision: profile.revision,
		currentItemRootHash: profile.currentItemRootHash,
		items: items.map(retrievalIndexEntry).sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
	};
	// The shared memory lease prevents a stale rebuild from racing correction or deletion.
	const text = `${canonicalStringify(document)}\n`;
	await withMemoryWriterLease(root, async (lockedRoot) => {
		const [currentProfile, pending] = await Promise.all([
			readMemoryProfileFile(lockedRoot),
			listPendingMemoryTransactionsAtRoot(lockedRoot),
		]);
		if (pending.length > 0 || canonicalStringify(currentProfile) !== canonicalStringify(profile)) {
			throw new Error("DATA_CONFLICT: profile changed before retrieval cache rebuild");
		}
		await atomicWriteFile(
			await resolveMemoryPath(lockedRoot, MEMORY_RETRIEVAL_INDEX_PATH, { allowMissing: true }),
			text,
		);
		await atomicWriteFile(
			await resolveMemoryPath(lockedRoot, MEMORY_RETRIEVAL_INDEX_HASH_PATH, { allowMissing: true }),
			`sha256:${hashBytes(text).value}\n`,
		);
	});
}

async function activeItemSource(profileRoot: string): Promise<ActiveItemSource | null> {
	const root = await validateMemoryLayout(profileRoot);
	const [snapshot, pending] = await Promise.all([
		readProfileSnapshot(root),
		listPendingMemoryTransactionsAtRoot(root),
	]);
	const { contentHash: profileContentHash, profile } = snapshot;
	if (pending.length > 0) return null;
	if (profile.status !== "active") {
		return { root, profile, profileContentHash, items: [], cacheStatus: "unavailable" };
	}
	try {
		const items = await readRetrievalIndex(root, profile, snapshot.indexBindingHash);
		if (items !== null) return { root, profile, profileContentHash, items, cacheStatus: "valid" };
	} catch {
		// Rebuild from canonical state below.
	}
	const opened = await openMemoryProfile(root, { rebuildCache: false });
	if (opened.mode !== "read-write") return null;
	const rebuiltSnapshot = await readProfileSnapshot(opened.root);
	if (canonicalStringify(rebuiltSnapshot.profile) !== canonicalStringify(opened.profile)) return null;
	let cacheStatus: ActiveItemSource["cacheStatus"] = "unavailable";
	try {
		await writeRetrievalIndex(opened.root, opened.profile, opened.activeItems);
		cacheStatus = "rebuilt";
	} catch {
		// Personalization may continue from canonical state without a derived cache.
	}
	return {
		root: opened.root,
		profile: opened.profile,
		profileContentHash: rebuiltSnapshot.contentHash,
		items: opened.activeItems,
		cacheStatus,
	};
}

async function readCanonicalItem(root: string, expected: RankableMemoryItem): Promise<MemoryItemV1 | null> {
	const path = `items/${expected.category}/${validateMemoryIdentifier(expected.memoryId, "memoryId")}/${expected.revision}.json`;
	const text = await readFile(await resolveMemoryPath(root, path), "utf8");
	const parsed = canonicalizeJson(JSON.parse(text));
	if (text !== `${canonicalStringify(parsed)}\n`) return null;
	const validation = validateMemoryItemV1(parsed);
	if (!validation.ok) return null;
	const canonicalExpected = "contentHash" in expected ? retrievalIndexEntry(validation.value) : validation.value;
	if (canonicalStringify(canonicalExpected) !== canonicalStringify(expected)) {
		return null;
	}
	return validation.value;
}

async function canonicalRecheck(
	source: ActiveItemSource,
	selected: readonly RankedActiveMemoryItem[],
): Promise<MemoryItemV1[] | null> {
	const items = await Promise.all(selected.map(({ item }) => readCanonicalItem(source.root, item)));
	if (items.some((item) => item === null)) return null;
	const [profileText, pending] = await Promise.all([
		readFile(await resolveMemoryPath(source.root, MEMORY_PROFILE_PATH), "utf8"),
		listPendingMemoryTransactionsAtRoot(source.root),
	]);
	if (`sha256:${hashBytes(profileText).value}` !== source.profileContentHash || pending.length > 0) return null;
	return items as MemoryItemV1[];
}

export function estimateMemoryContextTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const character of text) {
		if (character.codePointAt(0) !== undefined && (character.codePointAt(0) as number) <= 0x7f) ascii += 1;
		else nonAscii += 1;
	}
	return Math.ceil(ascii / 3) + nonAscii;
}

function contextLine(item: RankableMemoryItem, effect: MemoryEffect): string {
	return `- ${item.category}.${item.key}=${canonicalStringify(item.value)}; scope=${item.scope.level}; effect=${effect}; confidence=${item.confidence}`;
}

function emptyResult(
	status: MemoryRetrievalResult["status"],
	code: MemoryRetrievalResult["code"],
	overrides: Partial<MemoryRetrievalResult> = {},
): MemoryRetrievalResult {
	return {
		status,
		code,
		profileId: null,
		profileRevision: null,
		profileRootHash: null,
		cacheStatus: "unavailable",
		tokenBudget: 0,
		estimatedTokens: 0,
		omittedCount: 0,
		items: [],
		context: "",
		...overrides,
	};
}

export async function retrievePersonalMemory(
	profileRoot: string,
	query: MemoryRetrievalQuery,
): Promise<MemoryRetrievalResult> {
	if (!validQuery(query)) return emptyResult("blocked", "invalid_query");
	if (query.criticalDecision && query.effect !== "ranking") {
		return emptyResult("blocked", "critical_decision_memory_denied");
	}
	try {
		const source = await activeItemSource(profileRoot);
		if (source === null) return emptyResult("unavailable", "memory_unavailable");
		const identity = {
			profileId: source.profile.profileId,
			profileRevision: source.profile.revision,
			profileRootHash: source.profile.currentItemRootHash,
			cacheStatus: source.cacheStatus,
		};
		if (source.profile.status !== "active") return emptyResult("empty", "profile_paused", identity);
		const allowedDataClasses = query.allowedDataClasses.filter((value) =>
			source.profile.sensitivityPolicy.allowedDataClasses.includes(value),
		);
		const rankedItems = rankActiveMemoryItems(source.items, { ...query, allowedDataClasses });
		const tokenBudget = Math.max(
			0,
			Math.min(
				800,
				source.profile.learningPolicy.maxContextTokens,
				source.profile.budgetPolicy.maxAdditionalTokensPerTask,
				query.requestedMaxTokens ?? Number.POSITIVE_INFINITY,
				Math.floor(query.availableContextTokens * 0.05),
			),
		);
		const selected: RankedActiveMemoryItem[] = [];
		let usedTokens = estimateMemoryContextTokens(MEMORY_CONTEXT_LABEL);
		for (const item of rankedItems) {
			if (selected.length >= Math.min(8, source.profile.learningPolicy.maxItemsPerTask)) break;
			const lineTokens = estimateMemoryContextTokens(`\n${contextLine(item.item, query.effect)}`);
			if (usedTokens + lineTokens > tokenBudget) continue;
			selected.push(item);
			usedTokens += lineTokens;
		}
		if (selected.length === 0) {
			return emptyResult("empty", rankedItems.length === 0 ? "no_eligible_items" : "budget_exhausted", {
				...identity,
				tokenBudget,
				omittedCount: rankedItems.length,
			});
		}
		const canonicalItems = await canonicalRecheck(source, selected);
		if (canonicalItems === null) {
			return emptyResult("unavailable", "canonical_recheck_failed", { ...identity, tokenBudget });
		}
		const lines = canonicalItems.map((item) => contextLine(item, query.effect));
		const context = `${MEMORY_CONTEXT_LABEL}\n${lines.join("\n")}`;
		return {
			status: "applied",
			code: "ok",
			...identity,
			tokenBudget,
			estimatedTokens: estimateMemoryContextTokens(context),
			omittedCount: rankedItems.length - canonicalItems.length,
			items: canonicalItems.map((item, index) => ({
				memoryId: item.memoryId,
				revision: item.revision,
				category: item.category,
				key: item.key,
				value: item.value,
				scope: item.scope.level,
				dataClass: item.dataClass,
				effect: query.effect,
				confidence: item.confidence,
				score: (selected[index] as RankedActiveMemoryItem).score,
				provenanceHash: item.provenanceHash,
				authority: "preference_only",
				evidenceUse: "forbidden",
				decisionUse: query.criticalDecision ? "rank_only" : "allowed_effect_only",
			})),
			context,
		};
	} catch {
		return emptyResult("unavailable", "memory_unavailable");
	}
}
