// SPDX-License-Identifier: Apache-2.0

import { canonicalizeJson } from "../contracts/canonical-json.ts";
import type { JsonValue, MetadataConflict, SourceIdentifier } from "../contracts/schemas.ts";
import type { NormalizedSourceCandidate } from "./normalize.ts";

export type DedupMatchKey = "doi" | "arxiv" | "isbn" | "content_hash" | "title_year_first_author";
export type DedupStatus = "automatic_merge" | "possible_duplicate" | "distinct";

export interface DedupDecision {
	candidateIds: [string, string];
	status: DedupStatus;
	matchedBy: DedupMatchKey | null;
	reason:
		| "strong_identifier_match"
		| "content_hash_match"
		| "weak_metadata_match"
		| "ambiguous_identifier_set"
		| "isbn_scope_requires_review"
		| "metadata_conflict_requires_review"
		| "higher_priority_identifier_conflict"
		| "cluster_identifier_conflict"
		| "no_match";
	metadataConflicts: MetadataConflict[];
	blockingCandidateIds: string[];
}

export interface DeduplicationResult {
	automaticMergeGroups: string[][];
	possibleDuplicates: DedupDecision[];
	decisions: DedupDecision[];
}

const IDENTIFIER_PRIORITY = ["doi", "arxiv", "isbn"] as const;

function identifierValues(candidate: NormalizedSourceCandidate, scheme: SourceIdentifier["scheme"]): string[] {
	return candidate.identifiers
		.filter((identifier) => identifier.scheme === scheme)
		.map(({ normalizedValue }) => normalizedValue);
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
	const rightValues = new Set(right);
	return left.filter((value) => rightValues.has(value));
}

function fieldConflict(
	field: string,
	left: NormalizedSourceCandidate,
	right: NormalizedSourceCandidate,
	leftValue: unknown,
	rightValue: unknown,
): MetadataConflict {
	return {
		field,
		values: [
			{
				value: canonicalizeJson(leftValue),
				adapterId: left.adapterId,
				retrievedAt: left.retrievedAt,
				rawRecord: left.rawRecord,
			},
			{
				value: canonicalizeJson(rightValue),
				adapterId: right.adapterId,
				retrievedAt: right.retrievedAt,
				rawRecord: right.rawRecord,
			},
		],
		resolution: "unresolved",
		selectedValue: null,
		resolvedBy: null,
		resolvedAt: null,
	};
}

function normalizedText(value: string | null): string | null {
	return value?.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim() || null;
}

function conflicts(left: NormalizedSourceCandidate, right: NormalizedSourceCandidate): MetadataConflict[] {
	const result: MetadataConflict[] = [];
	for (const scheme of IDENTIFIER_PRIORITY) {
		const leftValues = identifierValues(left, scheme);
		const rightValues = identifierValues(right, scheme);
		if (leftValues.length > 0 && rightValues.length > 0 && intersection(leftValues, rightValues).length === 0) {
			result.push(fieldConflict(`identifiers.${scheme}`, left, right, leftValues, rightValues));
		}
	}
	const comparable: Array<[string, JsonValue, JsonValue]> = [];
	if (
		left.titleNormalized !== null &&
		right.titleNormalized !== null &&
		left.titleNormalized !== right.titleNormalized
	) {
		comparable.push(["title", left.title, right.title]);
	}
	if (
		left.publicationYear !== null &&
		right.publicationYear !== null &&
		left.publicationYear !== right.publicationYear
	) {
		comparable.push(["issuedDate", left.issuedDate, right.issuedDate]);
	}
	const leftAuthor = left.dedupKeys.normalizedTitleYearFirstAuthor?.split("|").at(-1) ?? null;
	const rightAuthor = right.dedupKeys.normalizedTitleYearFirstAuthor?.split("|").at(-1) ?? null;
	if (leftAuthor !== null && rightAuthor !== null && leftAuthor !== rightAuthor) {
		comparable.push(["contributors", canonicalizeJson(left.contributors), canonicalizeJson(right.contributors)]);
	}
	for (const [field, leftValue, rightValue] of [
		["containerTitle", left.containerTitle, right.containerTitle],
		["publisher", left.publisher, right.publisher],
		["sourceType", left.sourceType, right.sourceType],
		["language", left.language, right.language],
	] as const) {
		const normalizedLeft = normalizedText(leftValue);
		const normalizedRight = normalizedText(rightValue);
		if (normalizedLeft !== null && normalizedRight !== null && normalizedLeft !== normalizedRight) {
			comparable.push([field, leftValue, rightValue]);
		}
	}
	if (
		left.publicationStatus !== "unknown" &&
		right.publicationStatus !== "unknown" &&
		left.publicationStatus !== right.publicationStatus
	) {
		comparable.push(["publicationStatus", left.publicationStatus, right.publicationStatus]);
	}
	return [
		...result,
		...comparable.map(([field, leftValue, rightValue]) => fieldConflict(field, left, right, leftValue, rightValue)),
	];
}

function decision(
	left: NormalizedSourceCandidate,
	right: NormalizedSourceCandidate,
	status: DedupStatus,
	matchedBy: DedupMatchKey | null,
	reason: DedupDecision["reason"],
): DedupDecision {
	return {
		candidateIds: [left.candidateId, right.candidateId].sort() as [string, string],
		status,
		matchedBy,
		reason,
		metadataConflicts: conflicts(left, right),
		blockingCandidateIds: [],
	};
}

export function compareNormalizedCandidates(
	leftCandidate: NormalizedSourceCandidate,
	rightCandidate: NormalizedSourceCandidate,
): DedupDecision {
	const [left, right] =
		leftCandidate.candidateId.localeCompare(rightCandidate.candidateId) <= 0
			? [leftCandidate, rightCandidate]
			: [rightCandidate, leftCandidate];
	let higherConflict = false;
	for (const scheme of IDENTIFIER_PRIORITY) {
		const leftValues = identifierValues(left, scheme);
		const rightValues = identifierValues(right, scheme);
		if (leftValues.length === 0 || rightValues.length === 0) continue;
		const shared = intersection(leftValues, rightValues);
		if (shared.length === 0) {
			higherConflict = true;
			continue;
		}
		const ambiguous = new Set([...leftValues, ...rightValues]).size > 1;
		if (higherConflict || ambiguous) {
			return decision(
				left,
				right,
				"possible_duplicate",
				scheme,
				higherConflict ? "higher_priority_identifier_conflict" : "ambiguous_identifier_set",
			);
		}
		if (scheme === "isbn" && (left.sourceType !== "book" || right.sourceType !== "book")) {
			return decision(left, right, "possible_duplicate", scheme, "isbn_scope_requires_review");
		}
		if (conflicts(left, right).some(({ field }) => field === "title")) {
			return decision(left, right, "possible_duplicate", scheme, "metadata_conflict_requires_review");
		}
		return decision(left, right, "automatic_merge", scheme, "strong_identifier_match");
	}
	if (left.dedupKeys.contentHash !== null && left.dedupKeys.contentHash === right.dedupKeys.contentHash) {
		return decision(
			left,
			right,
			higherConflict ? "possible_duplicate" : "automatic_merge",
			"content_hash",
			higherConflict ? "higher_priority_identifier_conflict" : "content_hash_match",
		);
	}
	if (
		left.dedupKeys.normalizedTitleYearFirstAuthor !== null &&
		left.dedupKeys.normalizedTitleYearFirstAuthor === right.dedupKeys.normalizedTitleYearFirstAuthor
	) {
		return decision(
			left,
			right,
			"possible_duplicate",
			"title_year_first_author",
			higherConflict ? "higher_priority_identifier_conflict" : "weak_metadata_match",
		);
	}
	return decision(left, right, "distinct", null, higherConflict ? "higher_priority_identifier_conflict" : "no_match");
}

function candidatePairs(candidates: readonly NormalizedSourceCandidate[]): Array<[string, string]> {
	const buckets = new Map<string, string[]>();
	for (const candidate of candidates) {
		const keys = [
			...candidate.identifiers
				.filter(({ scheme }) => IDENTIFIER_PRIORITY.includes(scheme as (typeof IDENTIFIER_PRIORITY)[number]))
				.map(({ scheme, normalizedValue }) => `${scheme}:${normalizedValue}`),
			candidate.dedupKeys.contentHash === null ? null : `content:${candidate.dedupKeys.contentHash}`,
			candidate.dedupKeys.normalizedTitleYearFirstAuthor === null
				? null
				: `weak:${candidate.dedupKeys.normalizedTitleYearFirstAuthor}`,
		].filter((key): key is string => key !== null);
		for (const key of new Set(keys)) buckets.set(key, [...(buckets.get(key) ?? []), candidate.candidateId]);
	}
	const pairs = new Set<string>();
	for (const candidateIds of buckets.values()) {
		const sorted = [...candidateIds].sort();
		for (let left = 0; left < sorted.length; left += 1) {
			for (let right = left + 1; right < sorted.length; right += 1) pairs.add(`${sorted[left]}\0${sorted[right]}`);
		}
	}
	return [...pairs].sort().map((pair) => pair.split("\0") as [string, string]);
}

function higherSchemes(match: DedupMatchKey): Array<(typeof IDENTIFIER_PRIORITY)[number]> {
	if (match === "doi") return [];
	if (match === "arxiv") return ["doi"];
	if (match === "isbn") return ["doi", "arxiv"];
	return [...IDENTIFIER_PRIORITY];
}

export function deduplicateCandidates(candidates: readonly NormalizedSourceCandidate[]): DeduplicationResult {
	const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
	if (byId.size !== candidates.length) throw new TypeError("Metadata candidate IDs must be unique");
	const parent = new Map(candidates.map(({ candidateId }) => [candidateId, candidateId]));
	const find = (candidateId: string): string => {
		const current = parent.get(candidateId);
		if (current === undefined) throw new TypeError(`Unknown metadata candidate: ${candidateId}`);
		if (current === candidateId) return current;
		const root = find(current);
		parent.set(candidateId, root);
		return root;
	};
	const members = (root: string): NormalizedSourceCandidate[] =>
		candidates.filter(({ candidateId }) => find(candidateId) === root);
	const decisions = candidatePairs(candidates).map(([leftId, rightId]) =>
		compareNormalizedCandidates(byId.get(leftId)!, byId.get(rightId)!),
	);
	const priority: Record<DedupMatchKey, number> = {
		doi: 0,
		arxiv: 1,
		isbn: 2,
		content_hash: 3,
		title_year_first_author: 4,
	};
	decisions.sort(
		(left, right) =>
			(left.matchedBy === null ? 5 : priority[left.matchedBy]) -
				(right.matchedBy === null ? 5 : priority[right.matchedBy]) ||
			left.candidateIds.join("\0").localeCompare(right.candidateIds.join("\0")),
	);
	for (const item of decisions) {
		if (item.status !== "automatic_merge" || item.matchedBy === null) continue;
		const [leftId, rightId] = item.candidateIds;
		const leftRoot = find(leftId);
		const rightRoot = find(rightId);
		if (leftRoot === rightRoot) continue;
		const combined = [...members(leftRoot), ...members(rightRoot)];
		const incompatible = higherSchemes(item.matchedBy).some((scheme) => {
			const values = new Set(combined.flatMap((candidate) => identifierValues(candidate, scheme)));
			return values.size > 1;
		});
		if (incompatible) {
			item.status = "possible_duplicate";
			item.reason = "cluster_identifier_conflict";
			item.blockingCandidateIds = combined.map(({ candidateId }) => candidateId).sort();
			continue;
		}
		const [root, alias] = [leftRoot, rightRoot].sort();
		parent.set(alias, root);
	}
	const groups = new Map<string, string[]>();
	for (const { candidateId } of candidates) {
		const root = find(candidateId);
		groups.set(root, [...(groups.get(root) ?? []), candidateId]);
	}
	return {
		automaticMergeGroups: [...groups.values()]
			.map((group) => group.sort())
			.sort((left, right) => left[0].localeCompare(right[0])),
		possibleDuplicates: decisions.filter(({ status }) => status === "possible_duplicate"),
		decisions,
	};
}
