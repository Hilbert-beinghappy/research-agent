import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../src/contracts/schemas.ts";
import {
	compareNormalizedCandidates,
	type DedupStatus,
	deduplicateCandidates,
} from "../../src/literature/deduplicate.ts";
import {
	type MetadataCandidateInput,
	type NormalizedSourceCandidate,
	normalizeMetadataCandidate,
} from "../../src/literature/normalize.ts";

interface GoldCandidate {
	candidateId: string;
	adapterId: string;
	metadata: { [key: string]: JsonValue } | null;
	contentHash: string | null;
	requiresBibliographicMatch: boolean;
}

interface GoldPair {
	left: string;
	right: string;
	sameSource: boolean;
	expectedStatus: DedupStatus;
}

interface GoldFixture {
	candidates: GoldCandidate[];
	pairs: GoldPair[];
}

const fixturePath = fileURLToPath(new URL("../fixtures/dedup/gold.json", import.meta.url));
const timestamp = "2026-08-06T00:00:00.000Z";
const fileHash = { algorithm: "sha256", value: "a".repeat(64) } as const;

async function loadGold(): Promise<{
	fixture: GoldFixture;
	candidates: NormalizedSourceCandidate[];
	byId: Map<string, NormalizedSourceCandidate>;
}> {
	const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as GoldFixture;
	const candidates = fixture.candidates.map((candidate): NormalizedSourceCandidate => {
		const input: MetadataCandidateInput = {
			candidateId: candidate.candidateId,
			adapterId: candidate.adapterId,
			retrievedAt: timestamp,
			rawRecord: {
				path: `.research/raw/gold/${candidate.candidateId}.json`,
				hash: fileHash,
				mediaType: "application/json",
				bytes: 1,
			},
			metadata: candidate.metadata,
			documentContentHash:
				candidate.contentHash === null ? null : { algorithm: "sha256", value: candidate.contentHash },
			requiresBibliographicMatch: candidate.requiresBibliographicMatch,
		};
		return normalizeMetadataCandidate(input);
	});
	return { fixture, candidates, byId: new Map(candidates.map((candidate) => [candidate.candidateId, candidate])) };
}

describe("metadata normalization and dedup", () => {
	it("normalizes DOI, arXiv versions, ISBN, source types, names, and invalid identifiers", async () => {
		const { byId } = await loadGold();
		expect(byId.get("doi-crossref")?.dedupKeys).toMatchObject({
			doi: "10.5555/transparency.1",
			strongIdentifier: "doi:10.5555/transparency.1",
			normalizedTitleYearFirstAuthor: "algorithmic transparency and public trust|2024|li",
		});
		expect(byId.get("doi-openalex")?.sourceType).toBe("journal-article");
		expect(byId.get("arxiv-v1")?.dedupKeys.arxiv).toBe("2401.01234");
		expect(byId.get("arxiv-v3")?.dedupKeys.arxiv).toBe("2401.01234");
		expect(byId.get("isbn-book-a")?.dedupKeys.isbn).toBe("9780306406157");
		expect(byId.get("chinese-weak-a")?.dedupKeys.normalizedTitleYearFirstAuthor).toBe(
			"算法治理 透明度与公众信任|2025|张",
		);
		expect(byId.get("invalid-doi-a")?.identifiers).toHaveLength(0);
		expect(byId.get("invalid-doi-a")?.issues).toContainEqual({
			code: "INVALID_IDENTIFIER",
			field: "doi",
			value: "not-a-doi",
		});
		expect(byId.get("pdf-copy-a")?.issues).toContainEqual({
			code: "MISSING_BIBLIOGRAPHIC_METADATA",
			field: "metadata",
			value: null,
		});
	});

	it("meets the gold automatic-merge precision and review-queue recall gates", async () => {
		const { fixture, byId } = await loadGold();
		const outcomes = fixture.pairs.map((pair) => {
			const result = compareNormalizedCandidates(byId.get(pair.left)!, byId.get(pair.right)!);
			expect(result.status, `${pair.left} vs ${pair.right}`).toBe(pair.expectedStatus);
			return { ...pair, predictedStatus: result.status };
		});
		const automatic = outcomes.filter(({ predictedStatus }) => predictedStatus === "automatic_merge");
		const trueSources = outcomes.filter(({ sameSource }) => sameSource);
		const automaticMergePrecision = automatic.filter(({ sameSource }) => sameSource).length / automatic.length;
		const duplicateDetectionRecall =
			trueSources.filter(({ predictedStatus }) => predictedStatus !== "distinct").length / trueSources.length;
		expect(automaticMergePrecision).toBeGreaterThanOrEqual(0.98);
		expect(duplicateDetectionRecall).toBeGreaterThanOrEqual(0.95);
	});

	it("keeps weak matches and transitive identifier conflicts out of automatic groups", async () => {
		const { candidates, byId } = await loadGold();
		const titleConflict = compareNormalizedCandidates(byId.get("doi-crossref")!, byId.get("doi-title-conflict")!);
		expect(titleConflict).toMatchObject({
			status: "possible_duplicate",
			matchedBy: "doi",
			reason: "metadata_conflict_requires_review",
		});
		expect(titleConflict.metadataConflicts).toEqual(
			expect.arrayContaining([expect.objectContaining({ field: "title", resolution: "unresolved" })]),
		);
		const doiConflict = compareNormalizedCandidates(byId.get("doi-crossref")!, byId.get("doi-wrong")!);
		expect(doiConflict).toMatchObject({
			status: "possible_duplicate",
			reason: "higher_priority_identifier_conflict",
		});
		expect(doiConflict.metadataConflicts).toEqual(
			expect.arrayContaining([expect.objectContaining({ field: "identifiers.doi", resolution: "unresolved" })]),
		);

		const result = deduplicateCandidates(candidates);
		expect(
			result.automaticMergeGroups.some((group) => group.includes("doi-crossref") && group.includes("weak-ris")),
		).toBe(false);
		expect(
			result.automaticMergeGroups.some(
				(group) => group.includes("bridge-a") && group.includes("bridge-mid") && group.includes("bridge-c"),
			),
		).toBe(false);
		expect(result.possibleDuplicates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "cluster_identifier_conflict" }),
				expect.objectContaining({ matchedBy: "title_year_first_author", status: "possible_duplicate" }),
			]),
		);
	});
});
