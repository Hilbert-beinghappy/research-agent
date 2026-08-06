// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from "node:fs/promises";
import { canonicalizeJson } from "../contracts/canonical-json.ts";
import type {
	DocumentRecord,
	EvidenceLevel,
	EvidenceLocator,
	HashValue,
	JsonValue,
	RecordRef,
	ResearchError,
	ResearchResult,
} from "../contracts/schemas.ts";
import {
	PARSED_PDF_FORMAT_VERSION,
	type ParsedPdfBlock,
	type ParsedPdfDocument,
	type ParsedPdfPage,
} from "../documents/pdf-parser.ts";
import { hashBytes, hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds, projectRecordRevision } from "../project/record-index.ts";
import { readRecord } from "../project/records.ts";

export type CorpusQueryScope = "sources" | "documents" | "evidence" | "claims" | "all";

export interface CorpusQueryInput {
	query: string;
	scope: CorpusQueryScope;
	filters: Record<string, JsonValue>;
	limit: number;
	maxCharsPerHit: number;
	cursor: string | null;
}

export interface CorpusQueryHit {
	hitKind: "source_metadata" | "source_abstract" | "document_block" | "evidence" | "claim";
	record: RecordRef;
	sourceId: string | null;
	documentId: string | null;
	evidenceLevel: EvidenceLevel | null;
	validity: "active" | "superseded" | "invalidated" | null;
	locator: EvidenceLocator | null;
	text: string;
	truncated: boolean;
	warnings: string[];
}

export interface CorpusQueryPage {
	projectId: string;
	projectRevision: number;
	hits: CorpusQueryHit[];
	nextCursor: string | null;
}

export interface ParsedLocatorMatch {
	block: ParsedPdfBlock;
	text: string;
}

interface QueryCandidate extends CorpusQueryHit {
	sortKey: string;
	matchIndex: number;
}

interface QueryCursor {
	version: 1;
	projectRevision: number;
	queryHash: string;
	offset: number;
}

const ALLOWED_FILTERS = new Set(["sourceId", "documentId", "evidenceLevel", "validity"]);
const QUERY_SCOPES = new Set<CorpusQueryScope>(["sources", "documents", "evidence", "claims", "all"]);

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHash(value: unknown): value is HashValue {
	return (
		isObject(value) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		/^[a-f0-9]{64}$/.test(value.value)
	);
}

function isParsedBlock(value: unknown): value is ParsedPdfBlock {
	return (
		isObject(value) &&
		typeof value.blockId === "string" &&
		Number.isInteger(value.pageNumber) &&
		Array.isArray(value.sectionPath) &&
		value.sectionPath.every((part) => typeof part === "string") &&
		typeof value.text === "string" &&
		Number.isInteger(value.charStart) &&
		Number.isInteger(value.charEnd) &&
		isHash(value.anchorHash)
	);
}

function isParsedPage(value: unknown): value is ParsedPdfPage {
	return (
		isObject(value) &&
		Number.isInteger(value.pageNumber) &&
		typeof value.text === "string" &&
		Number.isInteger(value.charStart) &&
		Number.isInteger(value.charEnd) &&
		isHash(value.textHash) &&
		Array.isArray(value.blocks) &&
		value.blocks.every(isParsedBlock)
	);
}

function isParsedDocument(value: unknown): value is ParsedPdfDocument {
	return (
		isObject(value) &&
		value.formatVersion === PARSED_PDF_FORMAT_VERSION &&
		typeof value.documentId === "string" &&
		isHash(value.sourceContentHash) &&
		isObject(value.parser) &&
		value.parser.id === "pdfjs-dist" &&
		typeof value.parser.version === "string" &&
		isHash(value.parser.optionsHash) &&
		(value.textLayer === "present" || value.textLayer === "absent" || value.textLayer === "partial") &&
		Number.isInteger(value.pageCount) &&
		typeof value.text === "string" &&
		isHash(value.textHash) &&
		Array.isArray(value.pages) &&
		value.pages.every(isParsedPage) &&
		Array.isArray(value.warnings) &&
		value.warnings.every((warning) => typeof warning === "string")
	);
}

function parsedDocumentIssue(value: unknown, document: DocumentRecord): string | null {
	if (!isParsedDocument(value)) return "Parsed PDF output does not satisfy its runtime shape";
	if (
		value.documentId !== document.documentId ||
		value.sourceContentHash.value !== document.localFile?.hash?.value ||
		value.parser.id !== document.parser?.id ||
		value.parser.version !== document.parser.version ||
		value.parser.optionsHash.value !== document.parser.optionsHash.value ||
		value.pageCount !== document.pageCount ||
		value.textLayer !== document.textLayer ||
		value.pages.length !== value.pageCount ||
		hashBytes(value.text).value !== value.textHash.value
	) {
		return "Parsed PDF output conflicts with its DocumentRecord";
	}
	for (const [pageIndex, page] of value.pages.entries()) {
		if (
			page.pageNumber !== pageIndex + 1 ||
			page.charStart < 0 ||
			page.charEnd < page.charStart ||
			page.charEnd > value.text.length ||
			value.text.slice(page.charStart, page.charEnd) !== page.text ||
			hashBytes(page.text).value !== page.textHash.value
		) {
			return `Parsed PDF page ${pageIndex + 1} has invalid offsets or hashes`;
		}
		for (const [blockIndex, block] of page.blocks.entries()) {
			if (
				block.blockId !== `p${page.pageNumber}-b${blockIndex + 1}` ||
				block.pageNumber !== page.pageNumber ||
				block.charStart < page.charStart ||
				block.charEnd <= block.charStart ||
				block.charEnd > page.charEnd ||
				value.text.slice(block.charStart, block.charEnd) !== block.text ||
				hashCanonicalJson({
					pageNumber: block.pageNumber,
					sectionPath: block.sectionPath,
					sourceContentHash: value.sourceContentHash,
					text: block.text,
				}).value !== block.anchorHash.value
			) {
				return `Parsed PDF block ${block.blockId} has invalid offsets or hashes`;
			}
		}
	}
	return null;
}

export async function readParsedPdfDocument(
	projectRoot: string,
	document: DocumentRecord,
	operationId: string,
): Promise<ResearchResult<ParsedPdfDocument>> {
	const original = document.localFile;
	const parsed = document.parsedOutput;
	if (
		(document.fullTextStatus !== "parsed" && document.fullTextStatus !== "parsed_with_warnings") ||
		original === null ||
		original.hash === null ||
		original.bytes === null ||
		original.mediaType !== "application/pdf" ||
		parsed === null ||
		parsed.hash === null ||
		parsed.bytes === null ||
		parsed.mediaType !== "application/json" ||
		document.parser === null
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_DOCUMENT_NOT_PARSED",
			"validation",
			"Located evidence requires a complete parsed DocumentRecord",
			operationId,
		);
	}
	try {
		const originalPath = await resolveProjectPath(projectRoot, original.path);
		const parsedPath = await resolveProjectPath(projectRoot, parsed.path);
		const [originalStat, originalHash, parsedBytes] = await Promise.all([
			stat(originalPath),
			hashFile(originalPath),
			readFile(parsedPath),
		]);
		if (originalStat.size !== original.bytes || originalHash.value !== original.hash.value) {
			return failureResult(
				"DATA_CONFLICT",
				"EVIDENCE_ORIGINAL_INTEGRITY_FAILED",
				"integrity",
				"Document original no longer matches its immutable FileRef",
				operationId,
			);
		}
		if (parsedBytes.byteLength !== parsed.bytes || hashBytes(parsedBytes).value !== parsed.hash.value) {
			return failureResult(
				"DATA_CONFLICT",
				"EVIDENCE_PARSED_OUTPUT_INTEGRITY_FAILED",
				"integrity",
				"Parsed PDF output no longer matches its FileRef",
				operationId,
			);
		}
		const value = canonicalizeJson(JSON.parse(parsedBytes.toString("utf8")));
		const issue = parsedDocumentIssue(value, document);
		if (issue !== null) {
			return failureResult("DATA_CONFLICT", "EVIDENCE_PARSED_OUTPUT_INVALID", "integrity", issue, operationId);
		}
		const parsedDocument = value as unknown as ParsedPdfDocument;
		return {
			ok: true,
			status: "SUCCESS",
			value: parsedDocument,
			errors: [],
			meta: { operationId, taskId: null, warnings: [...document.warnings] },
		};
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_PARSED_OUTPUT_READ_FAILED",
			(error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "parse",
			error instanceof Error ? error.message : "Parsed PDF output could not be read",
			operationId,
		);
	}
}

function sameSection(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function resolveParsedPdfLocator(
	parsed: ParsedPdfDocument,
	locator: EvidenceLocator,
	operationId: string | null,
): ResearchResult<ParsedLocatorMatch> {
	if (
		!["page", "section", "paragraph", "char_range"].includes(locator.locatorType) ||
		locator.pageStart === null ||
		locator.pageStart < 1 ||
		(locator.pageEnd !== null && locator.pageEnd !== locator.pageStart) ||
		locator.charStart === null ||
		locator.charEnd === null ||
		locator.charEnd <= locator.charStart ||
		locator.anchorHash === null ||
		locator.label === null
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EVIDENCE_LOCATOR_INVALID",
			"validation",
			"Located PDF evidence requires one page, block label, anchor hash, and bounded character offsets",
			operationId,
		);
	}
	const block = parsed.pages
		.flatMap(({ blocks }) => blocks)
		.find(({ anchorHash }) => anchorHash.value === locator.anchorHash?.value);
	if (
		block === undefined ||
		block.pageNumber !== locator.pageStart ||
		block.blockId !== locator.label ||
		!sameSection(block.sectionPath, locator.sectionPath) ||
		locator.charStart < block.charStart ||
		locator.charEnd > block.charEnd
	) {
		return failureResult(
			"DATA_CONFLICT",
			"EVIDENCE_LOCATOR_MISMATCH",
			"integrity",
			"Evidence locator does not match a current parsed PDF block",
			operationId,
		);
	}
	return successResult({ block, text: parsed.text.slice(locator.charStart, locator.charEnd) }, operationId);
}

function normalizedSearchText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function queryMatch(text: string, query: string): number {
	return normalizedSearchText(text).indexOf(query);
}

function boundedText(text: string, matchIndex: number, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const start = Math.min(Math.max(0, matchIndex - Math.floor(maxChars / 3)), text.length - maxChars);
	return { text: text.slice(start, start + maxChars), truncated: true };
}

function cursorValue(cursor: string): QueryCursor | null {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (
			!isObject(value) ||
			value.version !== 1 ||
			!Number.isInteger(value.projectRevision) ||
			typeof value.queryHash !== "string" ||
			!Number.isInteger(value.offset) ||
			(value.offset as number) < 0
		) {
			return null;
		}
		return value as unknown as QueryCursor;
	} catch {
		return null;
	}
}

function encodedCursor(value: QueryCursor): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function filterIssue(filters: Record<string, JsonValue>): string | null {
	for (const [key, value] of Object.entries(filters)) {
		if (!ALLOWED_FILTERS.has(key)) return `Unsupported corpus filter: ${key}`;
		if (value !== null && typeof value !== "string") return `Corpus filter ${key} must be a string or null`;
	}
	return null;
}

function matchesFilters(hit: CorpusQueryHit, filters: Record<string, JsonValue>): boolean {
	for (const [key, value] of Object.entries(filters)) {
		if (value === null) continue;
		if (key === "sourceId" && hit.sourceId !== value) return false;
		if (key === "documentId" && hit.documentId !== value) return false;
		if (key === "evidenceLevel" && hit.evidenceLevel !== value) return false;
		if (key === "validity" && hit.validity !== value) return false;
	}
	return true;
}

function recordError(error: ResearchError, operationId: string): ResearchError {
	return { ...error, operationId };
}

export async function queryCorpusRecords(
	projectRoot: string,
	input: CorpusQueryInput,
	operationId: string,
): Promise<ResearchResult<CorpusQueryPage>> {
	const query = normalizedSearchText(input.query);
	const badFilter = filterIssue(input.filters);
	if (
		query.length === 0 ||
		query.length > 1_000 ||
		!QUERY_SCOPES.has(input.scope) ||
		!Number.isInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 100 ||
		!Number.isInteger(input.maxCharsPerHit) ||
		input.maxCharsPerHit < 1 ||
		input.maxCharsPerHit > 4_000 ||
		badFilter !== null
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"CORPUS_QUERY_INVALID",
			"validation",
			badFilter ?? "Corpus query, limit, or hit-size bound is invalid",
			operationId,
		);
	}
	let opened: Awaited<ReturnType<typeof openProject>>;
	try {
		opened = await openProject(projectRoot);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"CORPUS_PROJECT_OPEN_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Research project could not be opened",
			operationId,
		);
	}
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"CORPUS_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const queryHash = hashCanonicalJson({
		query,
		scope: input.scope,
		filters: input.filters,
		limit: input.limit,
		maxCharsPerHit: input.maxCharsPerHit,
	}).value;
	const cursor = input.cursor === null ? null : cursorValue(input.cursor);
	if (
		input.cursor !== null &&
		(cursor === null || cursor.projectRevision !== opened.manifest.revision || cursor.queryHash !== queryHash)
	) {
		return failureResult(
			"DATA_CONFLICT",
			"CORPUS_CURSOR_STALE",
			"data_conflict",
			"Corpus query cursor does not match the current project revision and query",
			operationId,
		);
	}

	const candidates: QueryCandidate[] = [];
	const errors: ResearchError[] = [];
	const include = (scope: Exclude<CorpusQueryScope, "all">): boolean => input.scope === "all" || input.scope === scope;
	// ponytail: direct record scan; add a derived text index only when measured project size makes this too slow.
	if (include("sources")) {
		for (const sourceId of await listProjectRecordIds(opened.root, opened.manifest, "source")) {
			const result = await readRecord(opened.root, "source", sourceId);
			if (!result.ok || result.value.kind !== "source") {
				errors.push(...result.errors.map((error) => recordError(error, operationId)));
				continue;
			}
			const source = result.value;
			const revision = projectRecordRevision(source);
			const metadataIndex = queryMatch(source.title, query);
			if (metadataIndex >= 0) {
				candidates.push({
					hitKind: "source_metadata",
					record: { kind: "source", id: source.sourceId, revision },
					sourceId: source.sourceId,
					documentId: null,
					evidenceLevel: "metadata",
					validity: null,
					locator: null,
					text: source.title,
					truncated: false,
					warnings: [],
					sortKey: `0:${source.sourceId}`,
					matchIndex: metadataIndex,
				});
			}
			if (source.abstractText !== null && source.abstractRights === "display_allowed") {
				const abstractIndex = queryMatch(source.abstractText, query);
				if (abstractIndex >= 0) {
					candidates.push({
						hitKind: "source_abstract",
						record: { kind: "source", id: source.sourceId, revision },
						sourceId: source.sourceId,
						documentId: null,
						evidenceLevel: "abstract",
						validity: null,
						locator: null,
						text: source.abstractText,
						truncated: false,
						warnings: [],
						sortKey: `1:${source.sourceId}`,
						matchIndex: abstractIndex,
					});
				}
			}
		}
	}
	if (include("documents")) {
		for (const documentId of await listProjectRecordIds(opened.root, opened.manifest, "document")) {
			const result = await readRecord(opened.root, "document", documentId);
			if (!result.ok || result.value.kind !== "document") {
				errors.push(...result.errors.map((error) => recordError(error, operationId)));
				continue;
			}
			if (result.value.fullTextStatus !== "parsed" && result.value.fullTextStatus !== "parsed_with_warnings")
				continue;
			const parsed = await readParsedPdfDocument(opened.root, result.value, operationId);
			if (!parsed.ok) {
				errors.push(...parsed.errors);
				continue;
			}
			for (const page of parsed.value.pages) {
				for (const block of page.blocks) {
					const matchIndex = queryMatch(block.text, query);
					if (matchIndex < 0) continue;
					candidates.push({
						hitKind: "document_block",
						record: {
							kind: "document",
							id: result.value.documentId,
							revision: projectRecordRevision(result.value),
						},
						sourceId: result.value.sourceId,
						documentId: result.value.documentId,
						evidenceLevel: "fulltext_located",
						validity: null,
						locator: {
							locatorType: "paragraph",
							pageStart: block.pageNumber,
							pageEnd: block.pageNumber,
							sectionPath: [...block.sectionPath],
							label: block.blockId,
							charStart: block.charStart,
							charEnd: block.charEnd,
							anchorHash: block.anchorHash,
						},
						text: block.text,
						truncated: false,
						warnings: [...result.value.warnings],
						sortKey: `2:${result.value.documentId}:${String(block.pageNumber).padStart(8, "0")}:${block.blockId}`,
						matchIndex,
					});
				}
			}
		}
	}
	if (include("evidence")) {
		for (const evidenceId of await listProjectRecordIds(opened.root, opened.manifest, "evidence")) {
			const result = await readRecord(opened.root, "evidence", evidenceId);
			if (!result.ok || result.value.kind !== "evidence") {
				errors.push(...result.errors.map((error) => recordError(error, operationId)));
				continue;
			}
			const text = [result.value.evidenceStatement, result.value.paraphrase, result.value.excerpt ?? ""].join("\n");
			const matchIndex = queryMatch(text, query);
			if (matchIndex < 0) continue;
			candidates.push({
				hitKind: "evidence",
				record: { kind: "evidence", id: evidenceId, revision: projectRecordRevision(result.value) },
				sourceId: result.value.sourceId,
				documentId: result.value.documentId,
				evidenceLevel: result.value.evidenceLevel,
				validity: result.value.validity,
				locator: result.value.locator,
				text,
				truncated: false,
				warnings: [...result.value.confidence.limitations],
				sortKey: `3:${evidenceId}`,
				matchIndex,
			});
		}
	}
	if (include("claims")) {
		for (const claimId of await listProjectRecordIds(opened.root, opened.manifest, "claim")) {
			const result = await readRecord(opened.root, "claim", claimId);
			if (!result.ok || result.value.kind !== "claim") {
				errors.push(...result.errors.map((error) => recordError(error, operationId)));
				continue;
			}
			const text = `${result.value.text}\n${result.value.scope}`;
			const matchIndex = queryMatch(text, query);
			if (matchIndex < 0) continue;
			candidates.push({
				hitKind: "claim",
				record: { kind: "claim", id: claimId, revision: projectRecordRevision(result.value) },
				sourceId: null,
				documentId: null,
				evidenceLevel: null,
				validity: null,
				locator: null,
				text,
				truncated: false,
				warnings: [],
				sortKey: `4:${claimId}`,
				matchIndex,
			});
		}
	}

	const matched = candidates
		.filter((candidate) => matchesFilters(candidate, input.filters))
		.sort((left, right) => (left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0));
	const offset = cursor?.offset ?? 0;
	if (offset > matched.length) {
		return failureResult(
			"DATA_CONFLICT",
			"CORPUS_CURSOR_INVALID",
			"data_conflict",
			"Corpus query cursor points beyond the current result set",
			operationId,
		);
	}
	const hits = matched.slice(offset, offset + input.limit).map(({ sortKey: _sortKey, matchIndex, ...candidate }) => ({
		...candidate,
		...boundedText(candidate.text, matchIndex, input.maxCharsPerHit),
	}));
	const nextOffset = offset + hits.length;
	const value: CorpusQueryPage = {
		projectId: opened.manifest.projectId,
		projectRevision: opened.manifest.revision,
		hits,
		nextCursor:
			nextOffset < matched.length
				? encodedCursor({ version: 1, projectRevision: opened.manifest.revision, queryHash, offset: nextOffset })
				: null,
	};
	return errors.length === 0
		? { ok: true, status: "SUCCESS", value, errors: [], meta: { operationId, taskId: null, warnings: [] } }
		: {
				ok: true,
				status: "PARTIAL_SUCCESS",
				value,
				errors,
				meta: { operationId, taskId: null, warnings: errors.map(({ message }) => message) },
			};
}
