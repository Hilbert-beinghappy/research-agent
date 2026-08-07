// SPDX-License-Identifier: Apache-2.0

import { getDocument, version as pdfjsVersion, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextContent } from "pdfjs-dist/types/src/display/api.d.ts";
import type { HashValue, ResearchResult } from "../contracts/schemas.ts";
import { hashBytes, hashCanonicalJson } from "../kernel/integrity.ts";
import { failureResult, successResult } from "../kernel/results.ts";

export const PARSED_PDF_FORMAT_VERSION = "0.1.0" as const;
const MIN_USABLE_PAGE_TEXT_CHARACTERS = 32;
const PDF_SCRIPTING_ENABLED = false;

export interface PdfParserOptions {
	maxBytes: number;
	maxPages: number;
}

export interface PdfParserDescriptor {
	id: "pdfjs-dist";
	version: string;
	optionsHash: HashValue;
}

export interface ParsedPdfBlock {
	blockId: string;
	pageNumber: number;
	sectionPath: string[];
	text: string;
	charStart: number;
	charEnd: number;
	anchorHash: HashValue;
}

export interface ParsedPdfPage {
	pageNumber: number;
	text: string;
	charStart: number;
	charEnd: number;
	textHash: HashValue;
	blocks: ParsedPdfBlock[];
}

export interface ParsedPdfDocument {
	formatVersion: typeof PARSED_PDF_FORMAT_VERSION;
	documentId: string;
	sourceContentHash: HashValue;
	parser: PdfParserDescriptor;
	textLayer: "present" | "absent" | "partial";
	pageCount: number;
	text: string;
	textHash: HashValue;
	pages: ParsedPdfPage[];
	warnings: string[];
}

interface TextLine {
	text: string;
	height: number;
}

const pdfjsModuleUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const pdfjsAssets = {
	cMapPacked: true,
	cMapUrl: new URL("../../cmaps/", pdfjsModuleUrl).href,
	standardFontDataUrl: new URL("../../standard_fonts/", pdfjsModuleUrl).href,
	wasmUrl: new URL("../../wasm/", pdfjsModuleUrl).href,
} as const;

export function pdfParserDescriptor(options: PdfParserOptions): PdfParserDescriptor {
	return {
		id: "pdfjs-dist",
		version: pdfjsVersion,
		optionsHash: hashCanonicalJson({
			formatVersion: PARSED_PDF_FORMAT_VERSION,
			headingScale: 1.2,
			maxBytes: options.maxBytes,
			maxPages: options.maxPages,
			minUsablePageTextCharacters: MIN_USABLE_PAGE_TEXT_CHARACTERS,
			normalizeWhitespace: true,
			scripting: PDF_SCRIPTING_ENABLED,
		}),
	};
}

export function validatePdfParserOptions<Value>(
	options: PdfParserOptions,
	operationId: string,
): ResearchResult<Value> | null {
	if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
		return failureResult(
			"PERMANENT_FAILURE",
			"PDF_BYTE_LIMIT_INVALID",
			"validation",
			"PDF byte limit must be a positive integer",
			operationId,
		);
	}
	if (!Number.isInteger(options.maxPages) || options.maxPages < 1) {
		return failureResult(
			"PERMANENT_FAILURE",
			"PDF_PAGE_LIMIT_INVALID",
			"validation",
			"PDF page limit must be a positive integer",
			operationId,
		);
	}
	return null;
}

function normalizedText(value: string): string {
	return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function linesFromTextContent(items: TextContent["items"]): TextLine[] {
	const lines: TextLine[] = [];
	let parts: string[] = [];
	let height = 0;
	let lastY: number | null = null;
	const flush = (): void => {
		const text = normalizedText(parts.join(" "));
		if (text.length > 0) lines.push({ text, height });
		parts = [];
		height = 0;
		lastY = null;
	};
	for (const value of items) {
		if (typeof value !== "object" || value === null || !("str" in value) || typeof value.str !== "string") continue;
		const itemHeight = "height" in value && typeof value.height === "number" ? value.height : 0;
		const transform = "transform" in value && Array.isArray(value.transform) ? value.transform : [];
		const y = typeof transform[5] === "number" ? transform[5] : null;
		if (parts.length > 0 && y !== null && lastY !== null && Math.abs(y - lastY) > Math.max(1, itemHeight / 2)) {
			flush();
		}
		const text = normalizedText(value.str);
		if (text.length > 0) {
			parts.push(text);
			height = Math.max(height, itemHeight);
			lastY = y;
		}
		if ("hasEOL" in value && value.hasEOL === true) flush();
	}
	flush();
	return lines;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

function isHeading(line: TextLine, bodyHeight: number): boolean {
	return (
		bodyHeight > 0 &&
		line.height >= bodyHeight * 1.2 &&
		line.text.length <= 160 &&
		!/[.!?;。！？；]$/u.test(line.text)
	);
}

function parsedDocument(
	documentId: string,
	sourceContentHash: HashValue,
	parser: PdfParserDescriptor,
	rawPages: readonly TextLine[][],
): ParsedPdfDocument {
	const bodyHeight = median(
		rawPages
			.flat()
			.map(({ height }) => height)
			.filter((height) => height > 0),
	);
	const pages: ParsedPdfPage[] = [];
	const textParts: string[] = [];
	let fullTextLength = 0;
	let sectionPath: string[] = [];
	for (const [pageIndex, lines] of rawPages.entries()) {
		const pageNumber = pageIndex + 1;
		const groups: { sectionPath: string[]; lines: string[] }[] = [];
		for (const line of lines) {
			if (isHeading(line, bodyHeight)) sectionPath = [line.text];
			const current = groups.at(-1);
			if (current === undefined || current.sectionPath[0] !== sectionPath[0]) {
				groups.push({ sectionPath: [...sectionPath], lines: [line.text] });
			} else {
				current.lines.push(line.text);
			}
		}
		const pageText = groups.map(({ lines: blockLines }) => blockLines.join("\n")).join("\n\n");
		const pageSeparator = pageIndex === 0 ? "" : "\n\n";
		const pageStart = fullTextLength + pageSeparator.length;
		let blockOffset = pageStart;
		const blocks = groups.map((group, blockIndex) => {
			const text = group.lines.join("\n");
			const block: ParsedPdfBlock = {
				blockId: `p${pageNumber}-b${blockIndex + 1}`,
				pageNumber,
				sectionPath: group.sectionPath,
				text,
				charStart: blockOffset,
				charEnd: blockOffset + text.length,
				anchorHash: hashCanonicalJson({ pageNumber, sectionPath: group.sectionPath, sourceContentHash, text }),
			};
			blockOffset = block.charEnd + 2;
			return block;
		});
		textParts.push(`${pageSeparator}${pageText}`);
		fullTextLength = pageStart + pageText.length;
		pages.push({
			pageNumber,
			text: pageText,
			charStart: pageStart,
			charEnd: fullTextLength,
			textHash: hashBytes(pageText),
			blocks,
		});
	}
	const textPages = pages.filter(({ text }) => text.length > 0).length;
	const textLayer = textPages === 0 ? "absent" : textPages === pages.length ? "present" : "partial";
	const warnings =
		textLayer === "partial"
			? [
					`Pages without a usable text layer: ${pages
						.filter(({ text }) => text.length === 0)
						.map(({ pageNumber }) => pageNumber)
						.join(", ")}`,
				]
			: textLayer === "absent"
				? ["No page contains a usable text layer; OCR is required"]
				: [];
	const text = textParts.join("");
	return {
		formatVersion: PARSED_PDF_FORMAT_VERSION,
		documentId,
		sourceContentHash,
		parser,
		textLayer,
		pageCount: pages.length,
		text,
		textHash: hashBytes(text),
		pages,
		warnings,
	};
}

function partialResult(
	value: ParsedPdfDocument,
	code: "PDF_OCR_REQUIRED" | "PDF_TEXT_LAYER_PARTIAL",
	message: string,
	operationId: string,
): ResearchResult<ParsedPdfDocument> {
	const failure = failureResult<ParsedPdfDocument>("PERMANENT_FAILURE", code, "parse", message, operationId);
	return {
		ok: true,
		status: "PARTIAL_SUCCESS",
		value,
		errors: failure.errors,
		meta: { operationId, taskId: null, warnings: [message] },
	};
}

export async function parsePdfBytes(input: {
	documentId: string;
	sourceContentHash: HashValue;
	bytes: Uint8Array;
	operationId: string;
	options: PdfParserOptions;
}): Promise<ResearchResult<ParsedPdfDocument>> {
	const invalidOptions = validatePdfParserOptions<ParsedPdfDocument>(input.options, input.operationId);
	if (invalidOptions !== null) return invalidOptions;
	if (input.bytes.byteLength > input.options.maxBytes) {
		return failureResult(
			"PERMANENT_FAILURE",
			"PDF_TOO_LARGE",
			"validation",
			"PDF exceeds the configured byte limit",
			input.operationId,
			{ actualBytes: input.bytes.byteLength, maxBytes: input.options.maxBytes },
		);
	}
	const actualSourceHash = hashBytes(input.bytes);
	if (actualSourceHash.value !== input.sourceContentHash.value) {
		return failureResult(
			"DATA_CONFLICT",
			"PDF_SOURCE_HASH_MISMATCH",
			"integrity",
			"PDF bytes do not match the declared source content hash",
			input.operationId,
			{ expectedHash: input.sourceContentHash.value, actualHash: actualSourceHash.value },
		);
	}
	const parser = pdfParserDescriptor(input.options);
	const loadingTask = getDocument({
		data: input.bytes,
		...pdfjsAssets,
		disableAutoFetch: true,
		disableRange: true,
		verbosity: VerbosityLevel.ERRORS,
	});
	try {
		const document = await loadingTask.promise;
		try {
			if (!PDF_SCRIPTING_ENABLED && (await document.hasJSActions())) {
				return failureResult(
					"PERMANENT_FAILURE",
					"PDF_SCRIPTING_FORBIDDEN",
					"validation",
					"PDF contains JavaScript actions, which are disabled by parser policy",
					input.operationId,
				);
			}
			if (document.numPages > input.options.maxPages) {
				return failureResult(
					"PERMANENT_FAILURE",
					"PDF_PAGE_LIMIT_EXCEEDED",
					"validation",
					"PDF exceeds the configured page limit",
					input.operationId,
					{ actualPages: document.numPages, maxPages: input.options.maxPages },
				);
			}
			const rawPages: TextLine[][] = [];
			for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
				const page = await document.getPage(pageNumber);
				const content = await page.getTextContent();
				rawPages.push(linesFromTextContent(content.items));
			}
			const usablePages = rawPages.map((lines) =>
				normalizedText(lines.map(({ text }) => text).join(" ")).length >= MIN_USABLE_PAGE_TEXT_CHARACTERS
					? lines
					: [],
			);
			const value = parsedDocument(input.documentId, input.sourceContentHash, parser, usablePages);
			if (value.textLayer === "absent") {
				return partialResult(value, "PDF_OCR_REQUIRED", value.warnings[0] ?? "OCR is required", input.operationId);
			}
			if (value.textLayer === "partial") {
				return partialResult(
					value,
					"PDF_TEXT_LAYER_PARTIAL",
					value.warnings[0] ?? "PDF text layer is partial",
					input.operationId,
				);
			}
			return successResult(value, input.operationId);
		} finally {
			await loadingTask.destroy();
		}
	} catch (error) {
		const name = error instanceof Error ? error.name : "UnknownError";
		const message = error instanceof Error ? error.message : "PDF could not be parsed";
		return failureResult(
			"PERMANENT_FAILURE",
			name === "PasswordException"
				? "PDF_ENCRYPTED"
				: name === "InvalidPDFException"
					? "PDF_INVALID"
					: "PDF_PARSE_FAILED",
			"parse",
			message,
			input.operationId,
			{ parserId: parser.id, parserVersion: parser.version, optionsHash: parser.optionsHash.value },
		);
	}
}
