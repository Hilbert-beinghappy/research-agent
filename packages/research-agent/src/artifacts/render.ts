// SPDX-License-Identifier: Apache-2.0

import { plugins } from "@citation-js/core";
import "@citation-js/plugin-bibtex";
import "@citation-js/plugin-ris";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import type {
	ArtifactKind,
	ClaimRecord,
	ContributorName,
	EvidenceCard,
	JsonValue,
	SourceRecord,
} from "../contracts/schemas.ts";
import type { ProjectRecord } from "../project/record-index.ts";

export type ResearchArtifactType = "review" | "evidence-matrix" | "ris" | "bibtex" | "json";

export interface ArtifactFormatSpec {
	artifactKind: ArtifactKind;
	extension: string;
	generatorId: string;
	mediaType: string;
	title: string;
	directory: string;
}

export interface RenderedArtifact extends ArtifactFormatSpec {
	content: string;
}

const FORMAT_SPECS: Record<ResearchArtifactType, ArtifactFormatSpec> = {
	review: {
		artifactKind: "markdown",
		extension: "md",
		generatorId: "research.review-markdown",
		mediaType: "text/markdown",
		title: "Literature review",
		directory: "artifacts/reviews",
	},
	"evidence-matrix": {
		artifactKind: "markdown",
		extension: "md",
		generatorId: "research.evidence-matrix-markdown",
		mediaType: "text/markdown",
		title: "Evidence matrix",
		directory: "artifacts/matrices",
	},
	ris: {
		artifactKind: "ris",
		extension: "ris",
		generatorId: "research.sources-ris",
		mediaType: "application/x-research-info-systems",
		title: "RIS bibliography export",
		directory: "artifacts/exports",
	},
	bibtex: {
		artifactKind: "bibtex",
		extension: "bib",
		generatorId: "research.sources-bibtex",
		mediaType: "application/x-bibtex",
		title: "BibTeX bibliography export",
		directory: "artifacts/exports",
	},
	json: {
		artifactKind: "json",
		extension: "json",
		generatorId: "research.records-json",
		mediaType: "application/json",
		title: "Research record export",
		directory: "artifacts/exports",
	},
};

export function artifactFormatSpec(type: ResearchArtifactType): ArtifactFormatSpec {
	return FORMAT_SPECS[type];
}

export function artifactTypeFromGenerator(generatorId: string): ResearchArtifactType | null {
	for (const [type, spec] of Object.entries(FORMAT_SPECS) as Array<[ResearchArtifactType, ArtifactFormatSpec]>) {
		if (spec.generatorId === generatorId) return type;
	}
	return null;
}

function normalizedMarkdown(content: string): string {
	const normalized = content.replace(/\r\n?/g, "\n").trimEnd();
	if (normalized.trim().length === 0) throw new TypeError("Markdown artifact content must not be empty");
	return `${normalized}\n`;
}

function markdownCell(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function locatorText(evidence: EvidenceCard): string {
	const locator = evidence.locator;
	if (locator === null) return "";
	const pages =
		locator.pageStart === null
			? ""
			: locator.pageEnd === null || locator.pageEnd === locator.pageStart
				? `p. ${locator.pageStart}`
				: `pp. ${locator.pageStart}-${locator.pageEnd}`;
	const section = locator.sectionPath.join(" > ");
	const label = locator.label ?? "";
	return [pages, section, label].filter((value) => value.length > 0).join("; ");
}

function renderEvidenceMatrix(records: readonly ProjectRecord[]): string {
	const evidenceById = new Map(
		records
			.filter((record): record is EvidenceCard => record.kind === "evidence")
			.map((record) => [record.evidenceId, record]),
	);
	const sourceById = new Map(
		records
			.filter((record): record is SourceRecord => record.kind === "source")
			.map((record) => [record.sourceId, record]),
	);
	const claims = records
		.filter((record): record is ClaimRecord => record.kind === "claim")
		.sort((left, right) => left.claimId.localeCompare(right.claimId));
	const lines = [
		"# Evidence Matrix",
		"",
		"| Claim ID | Claim | Support | Evidence ID | Relation | Source | Evidence level | Locator | Evidence statement |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	for (const claim of claims) {
		if (claim.evidenceLinks.length === 0) {
			lines.push(`| ${claim.claimId} | ${markdownCell(claim.text)} | ${claim.supportStatus} |  |  |  |  |  |  |`);
			continue;
		}
		for (const link of [...claim.evidenceLinks].sort((left, right) =>
			left.evidenceId.localeCompare(right.evidenceId),
		)) {
			const evidence = evidenceById.get(link.evidenceId);
			const source = evidence === undefined ? undefined : sourceById.get(evidence.sourceId);
			lines.push(
				`| ${[
					claim.claimId,
					markdownCell(claim.text),
					claim.supportStatus,
					link.evidenceId,
					link.relation,
					markdownCell(source?.title ?? "missing source"),
					evidence?.evidenceLevel ?? "missing evidence",
					markdownCell(evidence === undefined ? "" : locatorText(evidence)),
					markdownCell(evidence?.evidenceStatement ?? ""),
				].join(" | ")} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

function contributorValue(contributor: ContributorName): { [key: string]: JsonValue } | null {
	const value: { [key: string]: JsonValue } = {};
	if (contributor.family !== null) value.family = contributor.family;
	if (contributor.given !== null) value.given = contributor.given;
	if (contributor.literal !== null) value.literal = contributor.literal;
	return Object.keys(value).length === 0 ? null : value;
}

function cslType(sourceType: string): string {
	switch (sourceType) {
		case "journal-article":
			return "article-journal";
		case "book-chapter":
			return "chapter";
		case "conference-paper":
			return "paper-conference";
		case "preprint":
			return "manuscript";
		default:
			return sourceType;
	}
}

function issuedValue(value: string | null): { "date-parts": number[][] } | null {
	if (value === null) return null;
	const parts = value.split("-").map(Number);
	if (parts.length === 0 || parts.some((part) => !Number.isInteger(part))) return null;
	return { "date-parts": [parts] };
}

function sourceIdentifier(source: SourceRecord, scheme: SourceRecord["identifiers"][number]["scheme"]): string | null {
	return source.identifiers.find((identifier) => identifier.scheme === scheme)?.normalizedValue ?? null;
}

function sourceToCsl(source: SourceRecord): { [key: string]: JsonValue } {
	const value: { [key: string]: JsonValue } = {
		id: source.sourceId,
		"citation-key": source.sourceId,
		type: cslType(source.sourceType),
		title: source.title,
	};
	const authors = source.contributors.map(contributorValue).filter((author) => author !== null);
	if (authors.length > 0) value.author = authors;
	const issued = issuedValue(source.issuedDate);
	if (issued !== null) value.issued = issued;
	if (source.containerTitle !== null) value["container-title"] = source.containerTitle;
	if (source.publisher !== null) value.publisher = source.publisher;
	if (source.language !== null) value.language = source.language;
	for (const [scheme, field] of [
		["doi", "DOI"],
		["isbn", "ISBN"],
		["issn", "ISSN"],
		["url", "URL"],
	] as const) {
		const identifier = sourceIdentifier(source, scheme);
		if (identifier !== null) value[field] = identifier;
	}
	return value;
}

function renderBibliography(type: "ris" | "bibtex", records: readonly ProjectRecord[]): string {
	const sources = records
		.filter((record): record is SourceRecord => record.kind === "source")
		.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
	if (sources.length === 0) throw new TypeError(`${type.toUpperCase()} export requires at least one SourceRecord`);
	const rendered = plugins.output.format(type, sources.map(sourceToCsl));
	if (typeof rendered !== "string") throw new TypeError(`Citation.js returned a non-text ${type} export`);
	return `${rendered.trimEnd()}\n`;
}

function exportRecord(record: ProjectRecord): ProjectRecord {
	if (record.kind === "source" && record.abstractRights !== "display_allowed") {
		return { ...record, abstractText: null };
	}
	if (record.kind === "evidence" && record.rights.publicExportAllowed !== true) {
		return { ...record, excerpt: null, excerptExactMatch: null };
	}
	return record;
}

function renderJson(records: readonly ProjectRecord[]): string {
	return `${canonicalStringify({
		format: "pi-research-record-export",
		version: 1,
		records: [...records]
			.sort((left, right) => `${left.kind}:${recordId(left)}`.localeCompare(`${right.kind}:${recordId(right)}`))
			.map(exportRecord),
	})}\n`;
}

function recordId(record: ProjectRecord): string {
	switch (record.kind) {
		case "source":
			return record.sourceId;
		case "document":
			return record.documentId;
		case "evidence":
			return record.evidenceId;
		case "claim":
			return record.claimId;
		case "citation_verification":
			return record.verificationId;
		case "task":
			return record.taskId;
		case "operation":
			return record.operationId;
		case "analysis_run":
			return record.analysisRunId;
		case "artifact":
			return record.artifactId;
		case "approval":
			return record.approvalId;
	}
}

export function renderArtifact(
	type: ResearchArtifactType,
	records: readonly ProjectRecord[],
	markdownContent: string | null,
): RenderedArtifact {
	const spec = artifactFormatSpec(type);
	const content =
		type === "review"
			? normalizedMarkdown(markdownContent ?? "")
			: type === "evidence-matrix"
				? renderEvidenceMatrix(records)
				: type === "ris" || type === "bibtex"
					? renderBibliography(type, records)
					: renderJson(records);
	return { ...spec, content };
}
