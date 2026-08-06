// SPDX-License-Identifier: Apache-2.0

import { chmod, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	detectImportFormat,
	type ImportedDocumentCandidate,
	type ImportedSourceCandidate,
	type ImportFormat,
	type ImportMode,
	importExtension,
	importMediaType,
	parseLocalImport,
	type RawImportFile,
} from "../adapters/import/local.ts";
import type { HashValue, JsonValue, ResearchError, ResearchResult } from "../contracts/schemas.ts";
import { isOpaqueId } from "../kernel/identity.ts";
import { hashBytes, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { brokerProjectFile } from "../security/broker-files.ts";

export interface ImportSourceInput {
	path: string;
	format: "auto" | ImportFormat;
	mode: ImportMode;
}

export interface ImportSourcesRequest {
	inputs: ImportSourceInput[];
	operationId: string;
	sessionId: string | null;
	expectedManifestRevision: number;
}

export interface ImportSourcesValue {
	rawInputs: RawImportFile[];
	sourceCandidates: ImportedSourceCandidate[];
	documentCandidates: ImportedDocumentCandidate[];
	manifestRevision: number;
}

function importError(
	request: ImportSourcesRequest,
	inputIndex: number,
	code: string,
	category: ResearchError["category"],
	message: string,
	details: JsonValue = null,
): ResearchError {
	return {
		code,
		category,
		message,
		retryable: false,
		source: "import-sources",
		operationId: request.operationId,
		taskId: null,
		details: { inputIndex, cause: details },
		occurredAt: new Date().toISOString(),
		causeCode: null,
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

function partialResult(
	request: ImportSourcesRequest,
	value: ImportSourcesValue,
	errors: ResearchError[],
): ResearchResult<ImportSourcesValue> {
	return errors.length === 0
		? {
				ok: true,
				status: "SUCCESS",
				value,
				errors: [],
				meta: { operationId: request.operationId, taskId: null, warnings: [] },
			}
		: {
				ok: true,
				status: "PARTIAL_SUCCESS",
				value,
				errors,
				meta: {
					operationId: request.operationId,
					taskId: null,
					warnings: errors.map(({ message }) => message),
				},
			};
}

export async function importSourceFiles(
	projectRoot: string,
	request: ImportSourcesRequest,
): Promise<ResearchResult<ImportSourcesValue>> {
	if (!isOpaqueId(request.operationId, "operation")) {
		return failureResult(
			"PERMANENT_FAILURE",
			"IMPORT_OPERATION_INVALID",
			"validation",
			"Import operation ID is invalid",
			request.operationId,
		);
	}
	if (request.inputs.length === 0) {
		return failureResult(
			"PERMANENT_FAILURE",
			"IMPORT_INPUTS_REQUIRED",
			"validation",
			"At least one import input is required",
			request.operationId,
		);
	}
	let opened: Awaited<ReturnType<typeof openProject>>;
	try {
		opened = await openProject(projectRoot, request.expectedManifestRevision);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Research project cannot be opened";
		return failureResult(
			message.startsWith("DATA_CONFLICT:") ? "DATA_CONFLICT" : "PERMANENT_FAILURE",
			message.startsWith("DATA_CONFLICT:") ? "IMPORT_REVISION_CONFLICT" : "IMPORT_PROJECT_OPEN_FAILED",
			message.startsWith("DATA_CONFLICT:") ? "data_conflict" : "runtime",
			message,
			request.operationId,
		);
	}
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"IMPORT_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			request.operationId,
		);
	}

	let manifestRevision = opened.manifest.revision;
	const rawInputs: RawImportFile[] = [];
	const sourceCandidates: ImportedSourceCandidate[] = [];
	const documentCandidates: ImportedDocumentCandidate[] = [];
	const errors: ResearchError[] = [];

	for (const [inputIndex, input] of request.inputs.entries()) {
		if (input.path.trim().length === 0) {
			errors.push(importError(request, inputIndex, "IMPORT_PATH_REQUIRED", "validation", "Import path is empty"));
			continue;
		}
		const absolutePath = resolve(input.path);
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await readFile(absolutePath));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			errors.push(
				importError(
					request,
					inputIndex,
					code === "ENOENT" ? "IMPORT_INPUT_NOT_FOUND" : "IMPORT_READ_FAILED",
					code === "ENOENT" ? "not_found" : code === "EACCES" ? "permission" : "runtime",
					error instanceof Error ? error.message : "Import input cannot be read",
				),
			);
			continue;
		}
		let format: ImportFormat;
		try {
			format = input.format === "auto" ? detectImportFormat(absolutePath, bytes) : input.format;
		} catch (error) {
			errors.push(
				importError(
					request,
					inputIndex,
					"IMPORT_FORMAT_INVALID",
					"validation",
					error instanceof Error ? error.message : "Import format is invalid",
				),
			);
			continue;
		}
		const contentHash = hashBytes(bytes);
		const mediaType = importMediaType(format);
		let storedFile = null;
		if (input.mode === "copy") {
			const directory = format === "pdf" ? "sources/originals" : "sources/imports";
			const path = `${directory}/${contentHash.value}.${importExtension(format)}`;
			let oldHash: HashValue | null;
			try {
				oldHash = await currentHash(await resolveProjectPath(opened.root, path));
			} catch (error) {
				errors.push(
					importError(
						request,
						inputIndex,
						"IMPORT_TARGET_CHECK_FAILED",
						"runtime",
						error instanceof Error ? error.message : "Import target cannot be checked",
					),
				);
				continue;
			}
			if (oldHash !== null && oldHash.value !== contentHash.value) {
				errors.push(
					importError(
						request,
						inputIndex,
						"IMPORT_CONTENT_ADDRESS_CONFLICT",
						"data_conflict",
						"Content-addressed import path contains different bytes",
						{ path, expected: contentHash, actual: oldHash },
					),
				);
				continue;
			}
			if (oldHash === null) {
				const write = await brokerProjectFile(opened.root, {
					operationId: request.operationId,
					sessionId: request.sessionId,
					expectedManifestRevision: manifestRevision,
					path,
					content: bytes,
					dataClasses: [format === "pdf" ? "user_provided_document" : "bibliographic_metadata"],
				});
				if (!write.ok) {
					errors.push(
						...write.errors.map((error) => ({
							...error,
							details: { inputIndex, cause: error.details },
						})),
					);
					continue;
				}
				manifestRevision += 1;
			}
			if (format === "pdf") {
				try {
					await chmod(await resolveProjectPath(opened.root, path), 0o444);
				} catch (error) {
					errors.push(
						importError(
							request,
							inputIndex,
							"IMPORT_IMMUTABLE_MARK_FAILED",
							"runtime",
							error instanceof Error ? error.message : "Imported PDF could not be marked read-only",
						),
					);
					continue;
				}
			}
			storedFile = { path, hash: contentHash, mediaType, bytes: bytes.byteLength };
		}
		const raw: RawImportFile = {
			inputIndex,
			originalFileName: basename(absolutePath),
			format,
			mode: input.mode,
			contentHash,
			bytes: bytes.byteLength,
			mediaType,
			storedFile,
			referencePath: input.mode === "reference" ? absolutePath : null,
			portable: input.mode === "copy",
		};
		rawInputs.push(raw);
		try {
			const parsed = parseLocalImport(raw, bytes);
			sourceCandidates.push(...parsed.sourceCandidates);
			documentCandidates.push(...parsed.documentCandidates);
		} catch (error) {
			errors.push(
				importError(
					request,
					inputIndex,
					"IMPORT_PARSE_FAILED",
					"parse",
					error instanceof Error ? error.message : "Import input cannot be parsed",
					{ contentHash, format },
				),
			);
		}
	}

	if (rawInputs.length === 0) {
		return {
			ok: false,
			status: "PERMANENT_FAILURE",
			value: null,
			errors,
			meta: { operationId: request.operationId, taskId: null, warnings: [] },
		};
	}
	return partialResult(request, { rawInputs, sourceCandidates, documentCandidates, manifestRevision }, errors);
}
