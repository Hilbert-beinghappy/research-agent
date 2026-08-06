// SPDX-License-Identifier: Apache-2.0

import { chmod, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type {
	AnalysisSpecification,
	DatasetRecord,
	FileRef,
	JsonValue,
	ProjectSensitivity,
	RecordRef,
	ResearchResult,
	VariableRecord,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashBytes, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { createRecord, createRecords, readRecord, updateRecord } from "../project/records.ts";
import { brokerProjectFile } from "../security/broker-files.ts";

export interface ParsedCsv {
	headers: string[];
	rows: string[][];
}

export interface ImportDatasetRequest {
	path: string;
	title: string;
	sensitivity: ProjectSensitivity;
	expectedManifestRevision: number;
	operationId: string;
	sessionId: string | null;
}

export interface ImportDatasetValue {
	dataset: DatasetRecord;
	variables: VariableRecord[];
}

export interface CreateAnalysisSpecificationRequest {
	title: string;
	protocolId: string | null;
	datasetIds: string[];
	runtime: AnalysisSpecification["runtime"];
	scriptPath: string;
	environmentPath: string | null;
	parameters: JsonValue;
	randomSeed: number | null;
	commandArguments: string[];
	expectedOutputs: string[];
	timeoutSeconds: number;
	claimMode: AnalysisSpecification["claimMode"];
	expectedManifestRevision: number;
	operationId: string;
	sessionId: string | null;
}

export interface CreateAnalysisSpecificationValue {
	specification: AnalysisSpecification;
	inputs: RecordRef[];
}

function propagatedFailure<Value>(result: Extract<ResearchResult<unknown>, { ok: false }>): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, error.operationId, error.details);
}

export function parseCsv(text: string): ParsedCsv {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const input = text.replace(/^\uFEFF/, "");
	for (let index = 0; index < input.length; index += 1) {
		const character = input[index];
		if (quoted) {
			if (character === '"') {
				if (input[index + 1] === '"') {
					field += '"';
					index += 1;
				} else quoted = false;
			} else field += character;
			continue;
		}
		if (character === '"') {
			if (field.length > 0) throw new TypeError("CSV quote must begin at the start of a field");
			quoted = true;
		} else if (character === ",") {
			row.push(field);
			field = "";
		} else if (character === "\n" || character === "\r") {
			if (character === "\r" && input[index + 1] === "\n") index += 1;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += character;
	}
	if (quoted) throw new TypeError("CSV contains an unterminated quoted field");
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	if (rows.length === 0) throw new TypeError("CSV is empty");
	const [headers, ...dataRows] = rows;
	if (headers === undefined || headers.length === 0 || headers.some((header) => header.trim().length === 0)) {
		throw new TypeError("CSV requires a non-empty header for every column");
	}
	if (new Set(headers).size !== headers.length) throw new TypeError("CSV headers must be unique");
	for (const [index, dataRow] of dataRows.entries()) {
		if (dataRow.length !== headers.length) {
			throw new TypeError(`CSV row ${index + 2} has ${dataRow.length} fields; expected ${headers.length}`);
		}
	}
	return { headers, rows: dataRows };
}

function inferDataType(values: readonly string[]): VariableRecord["dataType"] {
	const present = values.map((value) => value.trim()).filter((value) => value.length > 0);
	if (present.length === 0) return "unknown";
	if (present.every((value) => /^(?:0|-?[1-9]\d*)$/.test(value))) return "integer";
	if (present.every((value) => Number.isFinite(Number(value)))) return "number";
	if (present.every((value) => /^(?:true|false)$/i.test(value))) return "boolean";
	if (present.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)))) return "date";
	if (present.every((value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)))) {
		return "datetime";
	}
	return "string";
}

async function currentHash(path: string) {
	try {
		return await hashFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function storeImmutableProjectInput(
	projectRoot: string,
	bytes: Uint8Array,
	path: string,
	mediaType: string,
	dataClass: string,
	operationId: string,
	sessionId: string | null,
): Promise<ResearchResult<FileRef>> {
	const contentHash = hashBytes(bytes);
	const target = await resolveProjectPath(projectRoot, path);
	const existing = await currentHash(target);
	if (existing !== null && existing.value !== contentHash.value) {
		return failureResult(
			"DATA_CONFLICT",
			"CONTENT_ADDRESS_CONFLICT",
			"data_conflict",
			`Content-addressed path contains different bytes: ${path}`,
			operationId,
		);
	}
	if (existing === null) {
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") {
			return failureResult(
				"PERMANENT_FAILURE",
				"ANALYSIS_PROJECT_READ_ONLY",
				"migration",
				"Research project schema is read-only",
				operationId,
			);
		}
		const stored = await brokerProjectFile(opened.root, {
			operationId,
			sessionId,
			expectedManifestRevision: opened.manifest.revision,
			path,
			content: bytes,
			dataClasses: [dataClass],
		});
		if (!stored.ok) return propagatedFailure(stored);
	}
	await chmod(target, 0o444);
	return successResult({ path, hash: contentHash, mediaType, bytes: bytes.byteLength }, operationId);
}

export async function importCsvDataset(
	projectRoot: string,
	request: ImportDatasetRequest,
): Promise<ResearchResult<ImportDatasetValue>> {
	try {
		const opened = await openProject(projectRoot, request.expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const bytes = new Uint8Array(await readFile(resolve(request.path)));
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const parsed = parseCsv(text);
		const contentHash = hashBytes(bytes);
		const stored = await storeImmutableProjectInput(
			opened.root,
			bytes,
			`sources/originals/datasets/${contentHash.value}.csv`,
			"text/csv",
			"research_dataset",
			request.operationId,
			request.sessionId,
		);
		if (!stored.ok) return stored;
		const now = new Date().toISOString();
		const datasetId = createOpaqueId("dataset");
		const variables: VariableRecord[] = parsed.headers.map((name, position) => {
			const values = parsed.rows.map((row) => row[position] ?? "");
			return {
				kind: "variable",
				schemaVersion: RESEARCH_SCHEMA_VERSION,
				variableId: createOpaqueId("variable"),
				datasetId,
				name,
				position,
				dataType: inferDataType(values),
				nullable: values.some((value) => value.trim().length === 0),
				missingCount: values.filter((value) => value.trim().length === 0).length,
				description: null,
				role: "other",
				audit: {
					createdAt: now,
					updatedAt: now,
					revision: 0,
					createdByOperationId: request.operationId,
					updatedByOperationId: request.operationId,
				},
			};
		});
		const dataset: DatasetRecord = {
			kind: "dataset",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			datasetId,
			title: request.title,
			format: "csv",
			encoding: "utf-8",
			sensitivity: request.sensitivity,
			sourceFile: stored.value,
			immutableOriginal: true,
			rowCount: parsed.rows.length,
			columnCount: parsed.headers.length,
			variableIds: variables.map(({ variableId }) => variableId),
			importedAt: now,
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: request.operationId,
				updatedByOperationId: request.operationId,
			},
		};
		const current = await openProject(opened.root);
		if (current.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const created = await createRecords(current.root, [dataset, ...variables], {
			expectedManifestRevision: current.manifest.revision,
			operationId: request.operationId,
		});
		return created.ok ? successResult({ dataset, variables }, request.operationId) : propagatedFailure(created);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Dataset import failed";
		return failureResult(
			message.startsWith("DATA_CONFLICT:") ? "DATA_CONFLICT" : "PERMANENT_FAILURE",
			message.startsWith("DATA_CONFLICT:") ? "DATASET_REVISION_CONFLICT" : "DATASET_IMPORT_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			message,
			request.operationId,
		);
	}
}

function scriptExtension(runtime: AnalysisSpecification["runtime"]): string {
	return runtime === "python" ? "py" : runtime === "r" ? "R" : "do";
}

export async function createAnalysisSpecification(
	projectRoot: string,
	request: CreateAnalysisSpecificationRequest,
): Promise<ResearchResult<CreateAnalysisSpecificationValue>> {
	try {
		const opened = await openProject(projectRoot, request.expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const datasets: DatasetRecord[] = [];
		for (const datasetId of request.datasetIds) {
			const result = await readRecord(opened.root, "dataset", datasetId);
			if (!result.ok) return propagatedFailure(result);
			if (result.value.kind !== "dataset") throw new TypeError(`Invalid dataset ${datasetId}`);
			datasets.push(result.value);
		}
		const scriptBytes = new Uint8Array(await readFile(resolve(request.scriptPath)));
		const scriptHash = hashBytes(scriptBytes);
		const script = await storeImmutableProjectInput(
			opened.root,
			scriptBytes,
			`sources/imports/analysis/${scriptHash.value}.${scriptExtension(request.runtime)}`,
			"text/plain",
			"analysis_script",
			request.operationId,
			request.sessionId,
		);
		if (!script.ok) return script;
		let environmentFile: FileRef | null = null;
		if (request.environmentPath !== null) {
			const environmentBytes = new Uint8Array(await readFile(resolve(request.environmentPath)));
			const environmentHash = hashBytes(environmentBytes);
			const extension = extname(request.environmentPath).slice(1) || "txt";
			const stored = await storeImmutableProjectInput(
				opened.root,
				environmentBytes,
				`sources/imports/analysis/${environmentHash.value}.${extension}`,
				"text/plain",
				"analysis_environment",
				request.operationId,
				request.sessionId,
			);
			if (!stored.ok) return stored;
			environmentFile = stored.value;
		}
		const now = new Date().toISOString();
		const specification: AnalysisSpecification = {
			kind: "analysis_specification",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			analysisSpecificationId: createOpaqueId("analysis_specification"),
			title: request.title,
			protocolId: request.protocolId,
			inputDatasetIds: datasets.map(({ datasetId }) => datasetId),
			inputFiles: datasets.map(({ sourceFile }) => sourceFile),
			runtime: request.runtime,
			script: script.value,
			environmentFile,
			parameters: request.parameters,
			randomSeed: request.randomSeed,
			commandArguments: [...request.commandArguments],
			expectedOutputs: [...request.expectedOutputs],
			timeoutSeconds: request.timeoutSeconds,
			claimMode: request.claimMode,
			status: "awaiting_confirmation",
			confirmation: { decision: null, decidedAt: null, decidedBy: null, note: null },
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: request.operationId,
				updatedByOperationId: request.operationId,
			},
		};
		const current = await openProject(opened.root);
		if (current.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const created = await createRecord(current.root, specification, {
			expectedManifestRevision: current.manifest.revision,
			operationId: request.operationId,
		});
		if (!created.ok) return propagatedFailure(created);
		return successResult(
			{
				specification,
				inputs: datasets.map((dataset) => ({
					kind: "dataset",
					id: dataset.datasetId,
					revision: dataset.audit.revision,
				})),
			},
			request.operationId,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"ANALYSIS_SPECIFICATION_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Analysis specification failed",
			request.operationId,
		);
	}
}

export async function decideAnalysisSpecification(
	projectRoot: string,
	analysisSpecificationId: string,
	expectedManifestRevision: number,
	expectedRecordRevision: number,
	decision: "confirmed" | "rejected",
	note: string | null,
	operationId: string,
): Promise<ResearchResult<RecordRef>> {
	const current = await readRecord(projectRoot, "analysis_specification", analysisSpecificationId);
	if (!current.ok) return propagatedFailure(current);
	if (current.value.kind !== "analysis_specification" || current.value.status !== "awaiting_confirmation") {
		return failureResult(
			"PERMANENT_FAILURE",
			"ANALYSIS_SPECIFICATION_NOT_REVIEWABLE",
			"validation",
			"Analysis specification is not awaiting confirmation",
			operationId,
		);
	}
	return updateRecord(projectRoot, "analysis_specification", analysisSpecificationId, {
		expectedManifestRevision,
		expectedRecordRevision,
		operationId,
		changes: {
			status: decision,
			confirmation: { decision, decidedAt: new Date().toISOString(), decidedBy: "user", note },
		},
	});
}
