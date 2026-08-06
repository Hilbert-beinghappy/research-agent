// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from "node:fs/promises";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type AccessStatus,
	type DocumentRecord,
	type FileRef,
	type FullTextStatus,
	type HashValue,
	type JsonValue,
	RESEARCH_SCHEMA_VERSION,
	type ResearchError,
	type ResearchResult,
} from "../contracts/schemas.ts";
import { fetchDocumentOriginal } from "../documents/fetch.ts";
import type { DocumentLocationCandidate, DocumentLocationResult } from "../documents/locate.ts";
import {
	type ParsedPdfDocument,
	type PdfParserOptions,
	parsePdfBytes,
	pdfParserDescriptor,
	validatePdfParserOptions,
} from "../documents/pdf-parser.ts";
import { invalidateStaleEvidenceForDocument } from "../evidence/commit.ts";
import { hashBytes } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { createRecord, readRecord, updateRecord } from "../project/records.ts";
import { brokerProjectFile } from "../security/broker-files.ts";
import type { HttpReceipt, HttpRequestIntent } from "../security/broker-http.ts";

export interface RecordDocumentLocationInput {
	documentId: string;
	sourceId: string;
	operationId: string;
	expectedManifestRevision: number;
	location: DocumentLocationResult;
}

export interface AcquireDocumentInput {
	documentId: string;
	operationId: string;
	sessionId: string | null;
	expectedDocumentRevision: number;
	candidate: DocumentLocationCandidate;
	allowOpenAccessDownload: boolean;
	maxBytesPerFile: number;
	expectedContentHash: HashValue | null;
	requestHttp(request: HttpRequestIntent): Promise<ResearchResult<HttpReceipt>>;
}

function locationWarnings(location: DocumentLocationResult): string[] {
	const warnings: string[] = [];
	if (location.bestLocation?.licenseStatus === "unknown") warnings.push("Open-access location license is unknown");
	if (location.locations.length > 0 && !location.locations.some(({ kind }) => kind === "direct_pdf")) {
		warnings.push("No direct PDF location was verified");
	}
	return warnings;
}

export async function readDocument(
	projectRoot: string,
	documentId: string,
	operationId: string,
): Promise<ResearchResult<DocumentRecord>> {
	const result = await readRecord(projectRoot, "document", documentId);
	if (!result.ok) {
		return {
			...result,
			errors: result.errors.map((error) => ({ ...error, operationId })),
			meta: { ...result.meta, operationId },
		};
	}
	if (result.value.kind !== "document") {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_RECORD_INVALID",
			"integrity",
			`Record ${documentId} is not a document`,
			operationId,
		);
	}
	return successResult(result.value, operationId);
}

export interface ParseDocumentInput {
	documentId: string;
	operationId: string;
	sessionId: string | null;
	expectedDocumentRevision: number;
	options: PdfParserOptions;
}

export async function recordDocumentLocation(
	projectRoot: string,
	input: RecordDocumentLocationInput,
): Promise<ResearchResult<DocumentRecord>> {
	if (input.location.sourceId !== input.sourceId) {
		return failureResult(
			"DATA_CONFLICT",
			"DOCUMENT_LOCATION_SOURCE_CONFLICT",
			"data_conflict",
			"Document location belongs to a different source",
			input.operationId,
		);
	}
	const source = await readRecord(projectRoot, "source", input.sourceId);
	if (!source.ok) {
		return {
			...source,
			errors: source.errors.map((error) => ({ ...error, operationId: input.operationId })),
			meta: { ...source.meta, operationId: input.operationId },
		};
	}
	if (source.value.kind !== "source") {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_SOURCE_INVALID",
			"integrity",
			`Record ${input.sourceId} is not a source`,
			input.operationId,
		);
	}
	const now = new Date().toISOString();
	const best = input.location.bestLocation;
	const document: DocumentRecord = {
		kind: "document",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		documentId: input.documentId,
		sourceId: input.sourceId,
		acquisition: {
			method: "open_access_download",
			adapterId: input.location.adapterId,
			origin: best?.url ?? null,
			accessStatus: input.location.accessStatus,
			licenseExpression: best?.licenseExpression ?? null,
			termsReference: null,
			acquiredAt: null,
			approvalId: null,
		},
		localFile: null,
		originalFileName: null,
		immutableOriginal: false,
		fullTextStatus: input.location.fullTextStatus,
		textLayer: "unknown",
		parser: null,
		parsedOutput: null,
		pageCount: null,
		parsedAt: null,
		warnings: locationWarnings(input.location),
		failure: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: input.operationId,
			updatedByOperationId: input.operationId,
		},
	};
	const created = await createRecord(projectRoot, document, {
		expectedManifestRevision: input.expectedManifestRevision,
		operationId: input.operationId,
	});
	if (!created.ok) return created;
	return readDocument(projectRoot, input.documentId, input.operationId);
}

function failureState(
	error: ResearchError,
	currentAccessStatus: AccessStatus,
): { accessStatus: AccessStatus; fullTextStatus: FullTextStatus } {
	if (error.code === "DOCUMENT_PAYWALLED") return { accessStatus: "paywalled", fullTextStatus: "paywall_blocked" };
	if (error.code === "DOCUMENT_AUTHENTICATION_REQUIRED") {
		return { accessStatus: "authentication_required", fullTextStatus: "authentication_blocked" };
	}
	if (error.code === "DOCUMENT_LICENSE_RESTRICTED") {
		return { accessStatus: "license_restricted", fullTextStatus: "unavailable" };
	}
	if (error.code === "DOCUMENT_NOT_FOUND") return { accessStatus: "not_found", fullTextStatus: "unavailable" };
	if (error.code === "DOCUMENT_BLOCKED_BY_POLICY" || error.code === "DOCUMENT_REDIRECT_BLOCKED") {
		return { accessStatus: "blocked_by_policy", fullTextStatus: "located" };
	}
	if (error.code === "DOCUMENT_ACCESS_UNVERIFIED") {
		return { accessStatus: "unknown", fullTextStatus: "unavailable" };
	}
	return { accessStatus: currentAccessStatus, fullTextStatus: error.retryable ? "located" : "unavailable" };
}

function changes(value: Record<string, unknown>): Record<string, JsonValue> {
	const normalized = canonicalizeJson(value);
	if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
		throw new TypeError("Document changes must be a JSON object");
	}
	return normalized;
}

export async function acquireDocument(
	projectRoot: string,
	input: AcquireDocumentInput,
): Promise<ResearchResult<DocumentRecord>> {
	const current = await readDocument(projectRoot, input.documentId, input.operationId);
	if (!current.ok) return current;
	if (current.value.sourceId !== input.candidate.sourceId) {
		return failureResult(
			"DATA_CONFLICT",
			"DOCUMENT_CANDIDATE_SOURCE_CONFLICT",
			"data_conflict",
			"Document location belongs to a different source",
			input.operationId,
		);
	}
	const fetched = await fetchDocumentOriginal({
		projectRoot,
		operationId: input.operationId,
		sessionId: input.sessionId,
		candidate: input.candidate,
		allowOpenAccessDownload: input.allowOpenAccessDownload,
		maxBytesPerFile: input.maxBytesPerFile,
		expectedContentHash: input.expectedContentHash,
		requestHttp: input.requestHttp,
	});
	const manifest = await openProject(projectRoot);
	if (manifest.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			input.operationId,
		);
	}
	const update = fetched.ok
		? changes({
				acquisition: {
					method: "open_access_download",
					adapterId: input.candidate.adapterId,
					origin: fetched.value.sourceUrl,
					accessStatus: fetched.value.accessStatus,
					licenseExpression: fetched.value.licenseExpression,
					termsReference: null,
					acquiredAt: new Date().toISOString(),
					approvalId: fetched.value.approvalId,
				},
				localFile: fetched.value.originalFile,
				immutableOriginal: true,
				fullTextStatus: "acquired_unparsed",
				textLayer: "unknown",
				parser: null,
				parsedOutput: null,
				pageCount: null,
				parsedAt: null,
				warnings: [...new Set([...current.value.warnings, ...fetched.value.warnings])],
				failure: null,
			})
		: (() => {
				const error = fetched.errors[0];
				const state = failureState(error, current.value.acquisition.accessStatus);
				return changes({
					acquisition: {
						...current.value.acquisition,
						origin: input.candidate.url,
						accessStatus: state.accessStatus,
						licenseExpression: input.candidate.licenseExpression,
						acquiredAt: null,
						approvalId: null,
					},
					localFile: null,
					immutableOriginal: false,
					fullTextStatus: state.fullTextStatus,
					warnings: [...new Set([...current.value.warnings, error.message])],
					failure: error,
				});
			})();
	const updated = await updateRecord(projectRoot, "document", input.documentId, {
		expectedManifestRevision: manifest.manifest.revision,
		expectedRecordRevision: input.expectedDocumentRevision,
		operationId: input.operationId,
		changes: update,
	});
	if (!updated.ok) return updated;
	const document = await readDocument(projectRoot, input.documentId, input.operationId);
	if (!document.ok) return document;
	const invalidated = await invalidateStaleEvidenceForDocument(projectRoot, document.value, input.operationId);
	const errors = [...fetched.errors, ...invalidated.errors];
	if (errors.length === 0) return document;
	return {
		ok: true,
		status: "PARTIAL_SUCCESS",
		value: document.value,
		errors,
		meta: {
			operationId: input.operationId,
			taskId: null,
			warnings: errors.map(({ message }) => message),
		},
	};
}

async function parsedOutputFile(
	projectRoot: string,
	input: ParseDocumentInput,
	value: ParsedPdfDocument,
): Promise<ResearchResult<FileRef>> {
	const content = `${canonicalStringify(value)}\n`;
	const contentHash = hashBytes(content);
	const path = `sources/parsed/${contentHash.value}.json`;
	let existing: Uint8Array | null = null;
	try {
		existing = new Uint8Array(await readFile(await resolveProjectPath(projectRoot, path)));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return failureResult(
				"PERMANENT_FAILURE",
				"PDF_OUTPUT_READ_FAILED",
				"runtime",
				error instanceof Error ? error.message : "Parsed PDF output could not be read",
				input.operationId,
				{ path },
			);
		}
	}
	if (existing !== null && hashBytes(existing).value !== contentHash.value) {
		return failureResult(
			"DATA_CONFLICT",
			"PDF_OUTPUT_HASH_CONFLICT",
			"integrity",
			"Content-addressed parsed PDF output contains different bytes",
			input.operationId,
			{ path, expectedHash: contentHash.value, actualHash: hashBytes(existing).value },
		);
	}
	if (existing === null) {
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") {
			return failureResult(
				"PERMANENT_FAILURE",
				"PDF_PROJECT_READ_ONLY",
				"migration",
				"Research project schema is read-only",
				input.operationId,
			);
		}
		const stored = await brokerProjectFile(opened.root, {
			operationId: input.operationId,
			sessionId: input.sessionId,
			expectedManifestRevision: opened.manifest.revision,
			path,
			content,
			dataClasses: ["research_document_text"],
		});
		if (!stored.ok) return stored;
	}
	return successResult(
		{ path, hash: contentHash, mediaType: "application/json", bytes: Buffer.byteLength(content) },
		input.operationId,
	);
}

async function finishParse(
	projectRoot: string,
	input: ParseDocumentInput,
	update: Record<string, JsonValue>,
	errors: readonly ResearchError[],
): Promise<ResearchResult<DocumentRecord>> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"PDF_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			input.operationId,
		);
	}
	const updated = await updateRecord(projectRoot, "document", input.documentId, {
		expectedManifestRevision: opened.manifest.revision,
		expectedRecordRevision: input.expectedDocumentRevision,
		operationId: input.operationId,
		changes: update,
	});
	if (!updated.ok) return updated;
	const document = await readDocument(projectRoot, input.documentId, input.operationId);
	if (!document.ok) return document;
	const invalidated = await invalidateStaleEvidenceForDocument(projectRoot, document.value, input.operationId);
	const combinedErrors = [...errors, ...invalidated.errors];
	if (combinedErrors.length === 0) return document;
	return {
		ok: true,
		status: "PARTIAL_SUCCESS",
		value: document.value,
		errors: combinedErrors,
		meta: {
			operationId: input.operationId,
			taskId: null,
			warnings: combinedErrors.map(({ message }) => message),
		},
	};
}

async function finishParseFailure(
	projectRoot: string,
	input: ParseDocumentInput,
	current: DocumentRecord,
	error: ResearchError,
): Promise<ResearchResult<DocumentRecord>> {
	return finishParse(
		projectRoot,
		input,
		changes({
			fullTextStatus: "parse_failed",
			textLayer: "unknown",
			parser: pdfParserDescriptor(input.options),
			parsedOutput: null,
			pageCount: null,
			parsedAt: new Date().toISOString(),
			warnings: [...new Set([...current.warnings, error.message])],
			failure: error,
		}),
		[error],
	);
}

async function quarantineOriginal(
	projectRoot: string,
	input: ParseDocumentInput,
	current: DocumentRecord,
	error: ResearchError,
): Promise<ResearchResult<DocumentRecord>> {
	return finishParse(
		projectRoot,
		input,
		changes({
			fullTextStatus: "quarantined",
			textLayer: "unknown",
			parser: null,
			parsedOutput: null,
			pageCount: null,
			parsedAt: null,
			warnings: [...new Set([...current.warnings, error.message])],
			failure: error,
		}),
		[error],
	);
}

export async function parseDocument(
	projectRoot: string,
	input: ParseDocumentInput,
): Promise<ResearchResult<DocumentRecord>> {
	const current = await readDocument(projectRoot, input.documentId, input.operationId);
	if (!current.ok) return current;
	if (current.value.audit.revision !== input.expectedDocumentRevision) {
		return failureResult(
			"DATA_CONFLICT",
			"DOCUMENT_REVISION_CONFLICT",
			"data_conflict",
			`Expected document revision ${input.expectedDocumentRevision}, found ${current.value.audit.revision}`,
			input.operationId,
		);
	}
	const file = current.value.localFile;
	if (file === null || file.hash === null || file.bytes === null || file.mediaType !== "application/pdf") {
		return failureResult(
			"PERMANENT_FAILURE",
			"PDF_LOCAL_FILE_REQUIRED",
			"validation",
			"PDF parsing requires a complete local application/pdf file reference",
			input.operationId,
		);
	}
	const invalidOptions = validatePdfParserOptions<DocumentRecord>(input.options, input.operationId);
	if (invalidOptions !== null) return invalidOptions;
	let path: string;
	let fileSize: number;
	try {
		path = await resolveProjectPath(projectRoot, file.path);
		fileSize = (await stat(path)).size;
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"PDF_LOCAL_FILE_READ_FAILED",
			(error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "runtime",
			error instanceof Error ? error.message : "Local PDF could not be inspected",
			input.operationId,
			{ path: file.path },
		);
	}
	if (fileSize !== file.bytes) {
		const failed = failureResult<DocumentRecord>(
			"DATA_CONFLICT",
			"PDF_ORIGINAL_INTEGRITY_FAILED",
			"integrity",
			"Local PDF size no longer matches the immutable DocumentRecord reference",
			input.operationId,
			{ expectedBytes: file.bytes, actualBytes: fileSize, expectedHash: file.hash.value },
		);
		return quarantineOriginal(projectRoot, input, current.value, failed.errors[0]);
	}
	if (fileSize > input.options.maxBytes) {
		const failed = failureResult<DocumentRecord>(
			"PERMANENT_FAILURE",
			"PDF_TOO_LARGE",
			"validation",
			"PDF exceeds the configured byte limit",
			input.operationId,
			{ actualBytes: fileSize, maxBytes: input.options.maxBytes },
		);
		return finishParseFailure(projectRoot, input, current.value, failed.errors[0]);
	}
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(path));
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"PDF_LOCAL_FILE_READ_FAILED",
			(error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "runtime",
			error instanceof Error ? error.message : "Local PDF could not be read",
			input.operationId,
			{ path: file.path },
		);
	}
	const actualHash = hashBytes(bytes);
	if (bytes.byteLength !== file.bytes || actualHash.value !== file.hash.value) {
		const failed = failureResult<ParsedPdfDocument>(
			"DATA_CONFLICT",
			"PDF_ORIGINAL_INTEGRITY_FAILED",
			"integrity",
			"Local PDF bytes no longer match the immutable DocumentRecord reference",
			input.operationId,
			{
				expectedBytes: file.bytes,
				actualBytes: bytes.byteLength,
				expectedHash: file.hash.value,
				actualHash: actualHash.value,
			},
		);
		return quarantineOriginal(projectRoot, input, current.value, failed.errors[0]);
	}
	const parsed = await parsePdfBytes({
		documentId: input.documentId,
		sourceContentHash: file.hash,
		bytes,
		operationId: input.operationId,
		options: input.options,
	});
	const parsedAt = new Date().toISOString();
	if (!parsed.ok) {
		return finishParseFailure(projectRoot, input, current.value, parsed.errors[0]);
	}
	const output = await parsedOutputFile(projectRoot, input, parsed.value);
	if (!output.ok) return output;
	const fullTextStatus =
		parsed.value.textLayer === "absent"
			? "ocr_required"
			: parsed.value.textLayer === "partial"
				? "parsed_with_warnings"
				: "parsed";
	return finishParse(
		projectRoot,
		input,
		changes({
			fullTextStatus,
			textLayer: parsed.value.textLayer,
			parser: parsed.value.parser,
			parsedOutput: output.value,
			pageCount: parsed.value.pageCount,
			parsedAt,
			warnings: [...new Set([...current.value.warnings, ...parsed.value.warnings])],
			failure: parsed.errors[0] ?? null,
		}),
		parsed.errors,
	);
}
