// SPDX-License-Identifier: Apache-2.0

import { chmod } from "node:fs/promises";
import type { FileRef, HashValue, ResearchResult } from "../contracts/schemas.ts";
import { hashBytes, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { brokerProjectFile } from "../security/broker-files.ts";
import type { HttpReceipt, HttpRequestIntent } from "../security/broker-http.ts";
import type { DocumentLocationCandidate } from "./locate.ts";

export interface FetchDocumentInput {
	projectRoot: string;
	operationId: string;
	sessionId: string | null;
	candidate: DocumentLocationCandidate;
	allowOpenAccessDownload: boolean;
	maxBytesPerFile: number;
	expectedContentHash: HashValue | null;
	requestHttp(request: HttpRequestIntent): Promise<ResearchResult<HttpReceipt>>;
}

export interface FetchedDocument {
	sourceId: string;
	sourceUrl: string;
	accessStatus: "open_access";
	licenseExpression: string | null;
	originalFile: FileRef;
	immutableOriginal: true;
	approvalId: string | null;
	rawRequest: FileRef;
	rawResponse: FileRef;
	etag: string | null;
	lastModified: string | null;
	warnings: string[];
}

function blockedByAccess(input: FetchDocumentInput): ResearchResult<FetchedDocument> | null {
	const { accessStatus } = input.candidate;
	if (!input.allowOpenAccessDownload) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"DOCUMENT_BLOCKED_BY_POLICY",
			"permission",
			"Project acquisition policy does not allow open-access downloads",
			input.operationId,
		);
	}
	if (accessStatus === "open_access") return null;
	const values = {
		paywalled: ["DOCUMENT_PAYWALLED", "Document location is paywalled"],
		authentication_required: ["DOCUMENT_AUTHENTICATION_REQUIRED", "Document location requires authentication"],
		license_restricted: ["DOCUMENT_LICENSE_RESTRICTED", "Document license does not permit acquisition"],
		blocked_by_policy: ["DOCUMENT_BLOCKED_BY_POLICY", "Document acquisition is blocked by project policy"],
	} as const;
	const blocked = accessStatus in values ? values[accessStatus as keyof typeof values] : null;
	return failureResult(
		"PERMISSION_BLOCKED",
		blocked?.[0] ?? "DOCUMENT_ACCESS_UNVERIFIED",
		"permission",
		blocked?.[1] ?? "Document location is not verified as open access",
		input.operationId,
		{ accessStatus },
	);
}

function mappedHttpFailure(
	result: Exclude<ResearchResult<HttpReceipt>, { ok: true }>,
): ResearchResult<FetchedDocument> {
	const codeMap: Record<string, string> = {
		ACTION_DENIED: "DOCUMENT_BLOCKED_BY_POLICY",
		APPROVAL_REQUIRED: "DOCUMENT_BLOCKED_BY_POLICY",
		HTTP_AUTHENTICATION_FAILED: "DOCUMENT_AUTHENTICATION_REQUIRED",
		HTTP_NOT_FOUND: "DOCUMENT_NOT_FOUND",
		HTTP_REDIRECT_BLOCKED: "DOCUMENT_REDIRECT_BLOCKED",
		HTTP_RESPONSE_TOO_LARGE: "DOCUMENT_TOO_LARGE",
		POLICY_SNAPSHOT_CHANGED: "DOCUMENT_BLOCKED_BY_POLICY",
	};
	return {
		...result,
		errors: result.errors.map((error) => ({
			...error,
			code: codeMap[error.code] ?? error.code,
			source: "document-fetch",
		})),
	};
}

async function currentHash(path: string): Promise<HashValue | null> {
	try {
		return await hashFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function storeOriginal(
	input: FetchDocumentInput,
	bytes: Uint8Array,
	contentHash: HashValue,
): Promise<ResearchResult<FileRef>> {
	const path = `sources/originals/${contentHash.value}.pdf`;
	try {
		const target = await resolveProjectPath(input.projectRoot, path);
		const existing = await currentHash(target);
		if (existing !== null && existing.value !== contentHash.value) {
			return failureResult(
				"DATA_CONFLICT",
				"DOCUMENT_CONTENT_ADDRESS_CONFLICT",
				"integrity",
				"Content-addressed original path contains different bytes",
				input.operationId,
				{ path, expected: contentHash, actual: existing },
			);
		}
		if (existing === null) {
			const opened = await openProject(input.projectRoot);
			if (opened.compatibility !== "current") {
				return failureResult(
					"PERMANENT_FAILURE",
					"DOCUMENT_PROJECT_READ_ONLY",
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
				content: bytes,
				dataClasses: ["public_document"],
			});
			if (!stored.ok) return stored;
		}
		await chmod(target, 0o444);
		const storedHash = await hashFile(target);
		if (storedHash.value !== contentHash.value) {
			return failureResult(
				"DATA_CONFLICT",
				"DOCUMENT_STORED_HASH_MISMATCH",
				"integrity",
				"Stored document hash differs from the downloaded content",
				input.operationId,
				{ path, expected: contentHash, actual: storedHash },
			);
		}
		return successResult(
			{ path, hash: contentHash, mediaType: "application/pdf", bytes: bytes.byteLength },
			input.operationId,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_STORE_FAILED",
			(error as NodeJS.ErrnoException).code === "EACCES" ? "permission" : "runtime",
			error instanceof Error ? error.message : "Document original could not be stored",
			input.operationId,
			{ path },
		);
	}
}

export async function fetchDocumentOriginal(input: FetchDocumentInput): Promise<ResearchResult<FetchedDocument>> {
	if (!Number.isInteger(input.maxBytesPerFile) || input.maxBytesPerFile < 1) {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_BYTE_LIMIT_INVALID",
			"validation",
			"Document byte limit must be a positive integer",
			input.operationId,
		);
	}
	const accessBlocked = blockedByAccess(input);
	if (accessBlocked !== null) return accessBlocked;
	if (input.candidate.kind !== "direct_pdf") {
		return failureResult(
			"PERMISSION_BLOCKED",
			"DOCUMENT_DIRECT_PDF_REQUIRED",
			"permission",
			"Landing pages and unknown locations are not downloaded as PDF files",
			input.operationId,
			{ kind: input.candidate.kind, url: input.candidate.url },
		);
	}
	let url: URL;
	try {
		url = new URL(input.candidate.url);
	} catch {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_URL_INVALID",
			"validation",
			"Document URL is invalid",
			input.operationId,
		);
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
		return failureResult(
			"PERMISSION_BLOCKED",
			"DOCUMENT_URL_UNSAFE",
			"permission",
			"Document downloads require an HTTPS URL without credentials or fragments",
			input.operationId,
		);
	}
	// ponytail: Base64 reuses the audited HTTP receipt path; split binary payloads only when real PDF receipts are a measured bottleneck.
	const result = await input.requestHttp({
		method: "GET",
		url: url.toString(),
		headers: { accept: "application/pdf" },
		body: null,
		credential: null,
		dataClasses: ["public_document"],
		paid: false,
		estimatedCost: null,
		costPerRequest: { amount: 0, currency: "USD" },
		maxAttempts: 3,
		idempotencyKey: `document:${hashBytes(url.toString()).value}`,
		responseBody: "base64",
		maxResponseBytes: input.maxBytesPerFile,
	});
	if (!result.ok) return mappedHttpFailure(result);
	if (result.value.bodyEncoding !== "base64") {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_BODY_ENCODING_INVALID",
			"integrity",
			"Document HTTP response was not recorded as binary data",
			input.operationId,
			{ rawResponse: result.value.responseFile },
		);
	}
	const bytes = new Uint8Array(Buffer.from(result.value.body, "base64"));
	if (bytes.byteLength !== result.value.bodyBytes || bytes.byteLength > input.maxBytesPerFile) {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_SIZE_INVALID",
			"integrity",
			"Document byte count does not match its governed HTTP receipt",
			input.operationId,
			{ receiptBytes: result.value.bodyBytes, decodedBytes: bytes.byteLength },
		);
	}
	const mediaType = result.value.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
	if (mediaType !== "application/pdf" && mediaType !== "application/octet-stream") {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_MEDIA_TYPE_INVALID",
			"integrity",
			"Document response is not a PDF media type",
			input.operationId,
			{ mediaType, rawResponse: result.value.responseFile },
		);
	}
	if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_PDF_SIGNATURE_INVALID",
			"integrity",
			"Document response does not contain a PDF signature",
			input.operationId,
			{ mediaType, rawResponse: result.value.responseFile },
		);
	}
	const contentHash = hashBytes(bytes);
	if (input.expectedContentHash !== null && input.expectedContentHash.value !== contentHash.value) {
		return failureResult(
			"DATA_CONFLICT",
			"DOCUMENT_HASH_MISMATCH",
			"integrity",
			"Downloaded document differs from the expected content hash",
			input.operationId,
			{ expected: input.expectedContentHash, actual: contentHash, rawResponse: result.value.responseFile },
		);
	}
	const stored = await storeOriginal(input, bytes, contentHash);
	if (!stored.ok) return stored;
	const warnings = mediaType === "application/octet-stream" ? ["PDF was served as application/octet-stream"] : [];
	return successResult(
		{
			sourceId: input.candidate.sourceId,
			sourceUrl: url.toString(),
			accessStatus: "open_access",
			licenseExpression: input.candidate.licenseExpression,
			originalFile: stored.value,
			immutableOriginal: true,
			approvalId: result.value.approvalId,
			rawRequest: result.value.requestFile,
			rawResponse: result.value.responseFile,
			etag: result.value.headers.etag ?? null,
			lastModified: result.value.headers["last-modified"] ?? null,
			warnings,
		},
		input.operationId,
	);
}
