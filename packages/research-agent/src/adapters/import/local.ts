// SPDX-License-Identifier: Apache-2.0

import { extname } from "node:path";
import { plugins } from "@citation-js/core";
import "@citation-js/plugin-bibtex";
import "@citation-js/plugin-ris";
import { canonicalizeJson } from "../../contracts/canonical-json.ts";
import type { FileRef, HashValue, JsonValue } from "../../contracts/schemas.ts";

export type ImportFormat = "ris" | "bibtex" | "csl-json" | "pdf";
export type ImportMode = "copy" | "reference";

export interface RawImportFile {
	inputIndex: number;
	originalFileName: string;
	format: ImportFormat;
	mode: ImportMode;
	contentHash: HashValue;
	bytes: number;
	mediaType: string;
	storedFile: FileRef | null;
	referencePath: string | null;
	portable: boolean;
}

export interface ImportedSourceCandidate {
	candidateKey: string;
	inputIndex: number;
	entryIndex: number | null;
	format: ImportFormat;
	metadataStatus: "provided" | "missing";
	metadata: { [key: string]: JsonValue } | null;
	sourceIdHint: string | null;
	requiresBibliographicMatch: boolean;
}

export interface ImportedDocumentCandidate {
	candidateKey: string;
	sourceCandidateKey: string;
	inputIndex: number;
	originalFileName: string;
	contentHash: HashValue;
	localFile: FileRef | null;
	referencePath: string | null;
	portable: boolean;
	acquisition: {
		method: "local_import";
		accessStatus: "user_provided";
		licenseExpression: null;
		termsReference: null;
	};
	immutableOriginal: boolean;
	fullTextStatus: "acquired_unparsed";
	textLayer: "unknown";
}

export interface ParsedImport {
	sourceCandidates: ImportedSourceCandidate[];
	documentCandidates: ImportedDocumentCandidate[];
}

const MEDIA_TYPES: Record<ImportFormat, string> = {
	ris: "application/x-research-info-systems",
	bibtex: "application/x-bibtex",
	"csl-json": "application/vnd.citationstyles.csl+json",
	pdf: "application/pdf",
};

const EXTENSIONS: Record<ImportFormat, string> = {
	ris: "ris",
	bibtex: "bib",
	"csl-json": "json",
	pdf: "pdf",
};

export function importMediaType(format: ImportFormat): string {
	return MEDIA_TYPES[format];
}

export function importExtension(format: ImportFormat): string {
	return EXTENSIONS[format];
}

export function detectImportFormat(path: string, bytes: Uint8Array): ImportFormat {
	const extension = extname(path).toLowerCase();
	if (extension === ".ris") return "ris";
	if (extension === ".bib" || extension === ".bibtex") return "bibtex";
	if (extension === ".json" || extension === ".csl" || extension === ".csljson") return "csl-json";
	if (extension === ".pdf") return "pdf";
	const prefix = new TextDecoder().decode(bytes.subarray(0, 4_096));
	if (prefix.startsWith("%PDF-")) return "pdf";
	if (/^TY {2}- /m.test(prefix)) return "ris";
	if (/^\s*@\w+\s*[{(]/.test(prefix)) return "bibtex";
	if (/^\s*[[{]/.test(prefix)) return "csl-json";
	throw new TypeError("Import format cannot be detected");
}

function decodeBibliography(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
}

function bibliographyInput(format: Exclude<ImportFormat, "pdf">, text: string): unknown {
	if (format !== "csl-json") return text;
	const parsed = JSON.parse(text) as unknown;
	if (parsed === null || typeof parsed !== "object") throw new TypeError("CSL-JSON must be an object or array");
	return Array.isArray(parsed) ? parsed : [parsed];
}

function parseBibliography(format: Exclude<ImportFormat, "pdf">, bytes: Uint8Array): JsonValue[] {
	const forceType = format === "ris" ? "@ris/file" : format === "bibtex" ? "@bibtex/text" : "@csl/list+object";
	const entries = plugins.input.chain(bibliographyInput(format, decodeBibliography(bytes)), {
		forceType,
		generateGraph: false,
		strict: true,
	});
	if (entries.length === 0) throw new TypeError("Import contains no bibliographic entries");
	return entries.map(canonicalizeJson);
}

function metadataObject(value: JsonValue): { [key: string]: JsonValue } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Citation parser returned a non-object entry");
	}
	return value;
}

function sourceIdHint(metadata: { [key: string]: JsonValue }): string | null {
	if (typeof metadata.note !== "string") return null;
	return /^Pi-Research-Source-ID:\s*(src_[0-9a-f-]{36})$/u.exec(metadata.note)?.[1] ?? null;
}

export function parseLocalImport(raw: RawImportFile, bytes: Uint8Array): ParsedImport {
	if (raw.format === "pdf") {
		if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
			throw new TypeError("PDF import is missing the PDF signature");
		}
		const sourceCandidateKey = `pdf:${raw.contentHash.value}`;
		return {
			sourceCandidates: [
				{
					candidateKey: sourceCandidateKey,
					inputIndex: raw.inputIndex,
					entryIndex: null,
					format: "pdf",
					metadataStatus: "missing",
					metadata: null,
					sourceIdHint: null,
					requiresBibliographicMatch: true,
				},
			],
			documentCandidates: [
				{
					candidateKey: `document:${raw.contentHash.value}`,
					sourceCandidateKey,
					inputIndex: raw.inputIndex,
					originalFileName: raw.originalFileName,
					contentHash: raw.contentHash,
					localFile: raw.storedFile,
					referencePath: raw.referencePath,
					portable: raw.portable,
					acquisition: {
						method: "local_import",
						accessStatus: "user_provided",
						licenseExpression: null,
						termsReference: null,
					},
					immutableOriginal: raw.mode === "copy",
					fullTextStatus: "acquired_unparsed",
					textLayer: "unknown",
				},
			],
		};
	}
	return {
		sourceCandidates: parseBibliography(raw.format, bytes).map((entry, entryIndex) => {
			const metadata = metadataObject(entry);
			return {
				candidateKey: `${raw.format}:${raw.contentHash.value}:${entryIndex}`,
				inputIndex: raw.inputIndex,
				entryIndex,
				format: raw.format,
				metadataStatus: "provided",
				metadata,
				sourceIdHint: sourceIdHint(metadata),
				requiresBibliographicMatch: false,
			};
		}),
		documentCandidates: [],
	};
}
