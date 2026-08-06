// SPDX-License-Identifier: Apache-2.0

import type {
	ContributorName,
	FileRef,
	HashValue,
	JsonValue,
	PublicationStatus,
	SourceIdentifier,
} from "../contracts/schemas.ts";

type JsonObject = { [key: string]: JsonValue };

export interface MetadataCandidateInput {
	candidateId: string;
	adapterId: string;
	retrievedAt: string;
	rawRecord: FileRef;
	metadata: JsonObject | null;
	documentContentHash: HashValue | null;
	requiresBibliographicMatch: boolean;
}

export interface NormalizationIssue {
	code: "INVALID_IDENTIFIER" | "MISSING_BIBLIOGRAPHIC_METADATA";
	field: string;
	value: string | null;
}

export interface NormalizedSourceCandidate {
	candidateId: string;
	adapterId: string;
	retrievedAt: string;
	rawRecord: FileRef;
	identifiers: SourceIdentifier[];
	title: string | null;
	titleNormalized: string | null;
	contributors: ContributorName[];
	issuedDate: string | null;
	publicationYear: number | null;
	containerTitle: string | null;
	publisher: string | null;
	sourceType: string | null;
	language: string | null;
	abstractText: string | null;
	publicationStatus: PublicationStatus;
	dedupKeys: {
		doi: string | null;
		arxiv: string | null;
		isbn: string | null;
		strongIdentifier: string | null;
		normalizedTitleYearFirstAuthor: string | null;
		contentHash: string | null;
	};
	requiresBibliographicMatch: boolean;
	issues: NormalizationIssue[];
}

function strings(...values: Array<JsonValue | undefined>): string[] {
	return values.flatMap((value) =>
		Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			: typeof value === "string" && value.trim().length > 0
				? [value]
				: [],
	);
}

function firstString(...values: Array<JsonValue | undefined>): string | null {
	return strings(...values)[0]?.trim() ?? null;
}

export function normalizeTitle(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/<[^>]+>/g, " ")
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeDoi(value: string): string | null {
	const normalized = value
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/^doi:\s*/i, "")
		.toLowerCase();
	return /^10\.\d{4,9}\/\S+$/.test(normalized) ? normalized : null;
}

function normalizeArxiv(value: string): string | null {
	const normalized = value
		.trim()
		.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
		.replace(/^arxiv:\s*/i, "")
		.replace(/\.pdf$/i, "")
		.replace(/v\d+$/i, "")
		.toLowerCase();
	return /^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})$/.test(normalized) ? normalized : null;
}

function normalizeIsbn(value: string): string | null {
	const normalized = value
		.trim()
		.toUpperCase()
		.replace(/^ISBN(?:-1[03])?:?\s*/i, "")
		.replace(/[\s-]/g, "");
	if (/^\d{9}[\dX]$/.test(normalized)) {
		const sum = [...normalized].reduce(
			(total, digit, index) => total + (digit === "X" ? 10 : Number(digit)) * (10 - index),
			0,
		);
		return sum % 11 === 0 ? normalized : null;
	}
	if (/^\d{13}$/.test(normalized)) {
		const sum = [...normalized].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
		return sum % 10 === 0 ? normalized : null;
	}
	return null;
}

function normalizeSimpleIdentifier(scheme: SourceIdentifier["scheme"], value: string): string | null {
	const trimmed = value.trim();
	if (scheme === "doi") return normalizeDoi(trimmed);
	if (scheme === "arxiv") return normalizeArxiv(trimmed);
	if (scheme === "isbn") return normalizeIsbn(trimmed);
	if (scheme === "issn") {
		const issn = trimmed.toUpperCase().replace(/[\s-]/g, "");
		return /^\d{7}[\dX]$/.test(issn) ? issn : null;
	}
	if (scheme === "openalex") {
		const id = trimmed.replace(/^https?:\/\/openalex\.org\//i, "").toUpperCase();
		return /^W\d+$/.test(id) ? id : null;
	}
	if (scheme === "pmid") {
		const id = trimmed.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, "").replace(/\/$/, "");
		return /^\d+$/.test(id) ? id : null;
	}
	if (scheme === "pmcid") {
		const id = trimmed
			.replace(/^https?:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\//i, "")
			.replace(/\/$/, "")
			.toUpperCase();
		return /^PMC\d+$/.test(id) ? id : null;
	}
	if (scheme === "url") {
		try {
			const url = new URL(trimmed);
			return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
		} catch {
			return null;
		}
	}
	return trimmed.length > 0 ? trimmed : null;
}

function identifierInputs(metadata: JsonObject): Array<readonly [SourceIdentifier["scheme"], string]> {
	const nested =
		metadata.identifiers !== null && typeof metadata.identifiers === "object" && !Array.isArray(metadata.identifiers)
			? metadata.identifiers
			: {};
	const arxiv = strings(metadata.arxiv, metadata.arXiv, nested.arxiv);
	if (typeof metadata.archive === "string" && /arxiv/i.test(metadata.archive)) arxiv.push(...strings(metadata.number));
	return [
		...strings(metadata.doi, metadata.DOI, nested.doi).map((value) => ["doi", value] as const),
		...arxiv.map((value) => ["arxiv", value] as const),
		...strings(metadata.isbn, metadata.ISBN, nested.isbn).map((value) => ["isbn", value] as const),
		...strings(metadata.issn, metadata.ISSN, metadata.issnL, nested.issn).map((value) => ["issn", value] as const),
		...strings(metadata.openalexId, nested.openalex).map((value) => ["openalex", value] as const),
		...strings(metadata.pmid, nested.pmid).map((value) => ["pmid", value] as const),
		...strings(metadata.pmcid, nested.pmcid).map((value) => ["pmcid", value] as const),
		...strings(metadata.url, metadata.URL, nested.url).map((value) => ["url", value] as const),
	];
}

function normalizeIdentifiers(metadata: JsonObject, issues: NormalizationIssue[]): SourceIdentifier[] {
	const identifiers = new Map<string, SourceIdentifier>();
	for (const [scheme, value] of identifierInputs(metadata)) {
		const normalizedValue = normalizeSimpleIdentifier(scheme, value);
		if (normalizedValue === null) {
			issues.push({ code: "INVALID_IDENTIFIER", field: scheme, value });
			continue;
		}
		identifiers.set(`${scheme}:${normalizedValue}`, {
			scheme,
			value,
			normalizedValue,
			verified: false,
			verificationId: null,
		});
	}
	return [...identifiers.values()].sort(
		(left, right) =>
			left.scheme.localeCompare(right.scheme) || left.normalizedValue.localeCompare(right.normalizedValue),
	);
}

function contributors(metadata: JsonObject): ContributorName[] {
	const value = metadata.authors ?? metadata.author;
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (typeof entry === "string" && entry.trim().length > 0) {
			return [{ family: null, given: null, literal: entry.trim(), orcid: null }];
		}
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
		const family = firstString(entry.family);
		const given = firstString(entry.given);
		const literal = firstString(entry.literal, entry.name);
		const orcid = firstString(entry.orcid, entry.ORCID)?.replace(/^https?:\/\/orcid\.org\//i, "") ?? null;
		return family === null && given === null && literal === null ? [] : [{ family, given, literal, orcid }];
	});
}

function issuedDate(metadata: JsonObject): string | null {
	const direct = firstString(metadata.issuedDate, metadata.publicationDate, metadata.year);
	if (direct !== null) {
		const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(direct);
		if (match !== null)
			return match
				.slice(1)
				.filter((part) => part !== undefined)
				.join("-");
	}
	if (typeof metadata.publicationYear === "number" && Number.isInteger(metadata.publicationYear)) {
		return metadata.publicationYear.toString();
	}
	if (metadata.issued === null || typeof metadata.issued !== "object" || Array.isArray(metadata.issued)) return null;
	const parts = metadata.issued["date-parts"];
	if (!Array.isArray(parts) || !Array.isArray(parts[0])) return null;
	const [year, month, day] = parts[0];
	if (typeof year !== "number" || !Number.isInteger(year)) return null;
	return [year, month, day]
		.filter((part): part is number => typeof part === "number" && Number.isInteger(part))
		.map((part, index) => part.toString().padStart(index === 0 ? 4 : 2, "0"))
		.join("-");
}

function sourceType(metadata: JsonObject): string | null {
	const value = firstString(metadata.type);
	if (value === null) return null;
	const normalized = normalizeTitle(value).replace(/ /g, "-");
	if (["article", "article-journal", "journal-article"].includes(normalized)) return "journal-article";
	if (["chapter", "book-chapter"].includes(normalized)) return "book-chapter";
	if (["paper-conference", "proceedings-article"].includes(normalized)) return "conference-paper";
	if (["posted-content", "preprint"].includes(normalized)) return "preprint";
	return normalized || null;
}

function firstAuthorKey(value: readonly ContributorName[]): string | null {
	const first = value[0];
	if (first === undefined) return null;
	const family = first.family === null ? null : normalizeTitle(first.family);
	if (family) return family;
	const literal = first.literal === null ? null : normalizeTitle(first.literal);
	if (!literal) return null;
	if (/\p{Script=Han}/u.test(literal)) return literal.replace(/\s/g, "");
	return literal.split(" ").at(-1) ?? null;
}

function status(metadata: JsonObject): PublicationStatus {
	const value = firstString(metadata.publicationStatus);
	if (
		value === "normal" ||
		value === "corrected" ||
		value === "retracted" ||
		value === "expression_of_concern" ||
		value === "withdrawn" ||
		value === "unknown"
	) {
		return value;
	}
	return metadata.retractedFlag === true ? "retracted" : "unknown";
}

function identifierValue(identifiers: readonly SourceIdentifier[], scheme: SourceIdentifier["scheme"]): string | null {
	return identifiers.find((identifier) => identifier.scheme === scheme)?.normalizedValue ?? null;
}

export function normalizeMetadataCandidate(input: MetadataCandidateInput): NormalizedSourceCandidate {
	const metadata = input.metadata ?? {};
	const issues: NormalizationIssue[] = [];
	if (input.metadata === null) {
		issues.push({ code: "MISSING_BIBLIOGRAPHIC_METADATA", field: "metadata", value: null });
	}
	const identifiers = normalizeIdentifiers(metadata, issues);
	const title = firstString(metadata.title);
	const titleNormalized = title === null ? null : normalizeTitle(title) || null;
	const normalizedContributors = contributors(metadata);
	const normalizedIssuedDate = issuedDate(metadata);
	const publicationYear = normalizedIssuedDate === null ? null : Number(normalizedIssuedDate.slice(0, 4));
	const authorKey = firstAuthorKey(normalizedContributors);
	const weakKey =
		titleNormalized === null || publicationYear === null || authorKey === null
			? null
			: `${titleNormalized}|${publicationYear}|${authorKey}`;
	const doi = identifierValue(identifiers, "doi");
	const arxiv = identifierValue(identifiers, "arxiv");
	const isbn = identifierValue(identifiers, "isbn");
	return {
		candidateId: input.candidateId,
		adapterId: input.adapterId,
		retrievedAt: input.retrievedAt,
		rawRecord: input.rawRecord,
		identifiers,
		title,
		titleNormalized,
		contributors: normalizedContributors,
		issuedDate: normalizedIssuedDate,
		publicationYear,
		containerTitle: firstString(metadata.containerTitle, metadata["container-title"]),
		publisher: firstString(metadata.publisher),
		sourceType: sourceType(metadata),
		language: firstString(metadata.language)?.toLowerCase() ?? null,
		abstractText: firstString(metadata.abstract, metadata.abstractText),
		publicationStatus: status(metadata),
		dedupKeys: {
			doi,
			arxiv,
			isbn,
			strongIdentifier:
				doi === null ? (arxiv === null ? (isbn === null ? null : `isbn:${isbn}`) : `arxiv:${arxiv}`) : `doi:${doi}`,
			normalizedTitleYearFirstAuthor: weakKey,
			contentHash: input.documentContentHash?.value ?? null,
		},
		requiresBibliographicMatch: input.requiresBibliographicMatch,
		issues,
	};
}
