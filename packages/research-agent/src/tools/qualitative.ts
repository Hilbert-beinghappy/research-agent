// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import type {
	CodebookCode,
	CodebookVersion,
	CodingDecision,
	ModelSuggestion,
	ProjectSensitivity,
	QualitativeMaterial,
	QualitativeSegment,
	RecordRef,
	ResearchResult,
	Theme,
	ThemeSynthesis,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds, type ProjectRecord } from "../project/record-index.ts";
import { createRecord, createRecords, readRecord, updateRecord } from "../project/records.ts";
import { storeImmutableProjectInput } from "./analysis.ts";

export interface ImportQualitativeMaterialRequest {
	path: string;
	title: string;
	sensitivity: ProjectSensitivity;
	deidentified: boolean;
	expectedManifestRevision: number;
	operationId: string;
	sessionId: string | null;
}

export interface ModelProvenanceInput {
	provider: string;
	modelId: string;
	thinkingLevel: string | null;
}

export interface QualitativeAudit {
	markdown: string;
	json: string;
	recordCount: number;
}

interface TextSegment {
	text: string;
	charStart: number;
	charEnd: number;
}

function propagatedFailure<Value>(result: Extract<ResearchResult<unknown>, { ok: false }>): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, error.operationId, error.details);
}

export function segmentParagraphs(text: string): TextSegment[] {
	const segments: TextSegment[] = [];
	const separator = /\r?\n[\t ]*\r?\n/gu;
	let start = 0;
	const append = (end: number) => {
		let left = start;
		let right = end;
		while (left < right && /\s/u.test(text[left] ?? "")) left += 1;
		while (right > left && /\s/u.test(text[right - 1] ?? "")) right -= 1;
		if (left < right) segments.push({ text: text.slice(left, right), charStart: left, charEnd: right });
	};
	for (const match of text.matchAll(separator)) {
		append(match.index);
		start = match.index + match[0].length;
	}
	append(text.length);
	return segments;
}

export async function importQualitativeMaterial(
	projectRoot: string,
	request: ImportQualitativeMaterialRequest,
): Promise<ResearchResult<QualitativeMaterial>> {
	try {
		const opened = await openProject(projectRoot, request.expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const bytes = new Uint8Array(await readFile(resolve(request.path)));
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (text.trim().length === 0) throw new TypeError("Qualitative material is empty");
		const contentHash = hashBytes(bytes);
		const stored = await storeImmutableProjectInput(
			opened.root,
			bytes,
			`sources/originals/materials/${contentHash.value}.txt`,
			"text/plain",
			"qualitative_material",
			request.operationId,
			request.sessionId,
		);
		if (!stored.ok) return stored;
		const now = new Date().toISOString();
		const material: QualitativeMaterial = {
			kind: "qualitative_material",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			qualitativeMaterialId: createOpaqueId("qualitative_material"),
			title: request.title,
			format: "text",
			encoding: "utf-8",
			sensitivity: request.sensitivity,
			sourceFile: stored.value,
			deidentified: request.deidentified,
			immutableOriginal: true,
			characterCount: text.length,
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
		const created = await createRecord(current.root, material, {
			expectedManifestRevision: current.manifest.revision,
			operationId: request.operationId,
		});
		return created.ok ? successResult(material, request.operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"QUALITATIVE_IMPORT_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Qualitative material import failed",
			request.operationId,
		);
	}
}

export async function segmentQualitativeMaterial(
	projectRoot: string,
	qualitativeMaterialId: string,
	expectedManifestRevision: number,
	operationId: string,
): Promise<ResearchResult<QualitativeSegment[]>> {
	try {
		const opened = await openProject(projectRoot, expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const materialResult = await readRecord(opened.root, "qualitative_material", qualitativeMaterialId);
		if (!materialResult.ok) return propagatedFailure(materialResult);
		if (materialResult.value.kind !== "qualitative_material") throw new TypeError("Qualitative material is invalid");
		// ponytail: O(n) record scan; add a derived material index only after the 1,000-segment gate is exceeded.
		for (const id of await listProjectRecordIds(opened.root, opened.manifest, "qualitative_segment")) {
			const existing = await readRecord(opened.root, "qualitative_segment", id);
			if (
				existing.ok &&
				existing.value.kind === "qualitative_segment" &&
				existing.value.qualitativeMaterialId === qualitativeMaterialId
			) {
				return failureResult(
					"DATA_CONFLICT",
					"QUALITATIVE_MATERIAL_ALREADY_SEGMENTED",
					"data_conflict",
					"Material already has stable segments",
					operationId,
				);
			}
		}
		const text = await readFile(await resolveProjectPath(opened.root, materialResult.value.sourceFile.path), "utf8");
		const parsed = segmentParagraphs(text);
		if (parsed.length === 0) throw new TypeError("Material contains no non-empty paragraphs");
		const now = new Date().toISOString();
		const segments: QualitativeSegment[] = parsed.map((segment, ordinal) => ({
			kind: "qualitative_segment",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			qualitativeSegmentId: createOpaqueId("qualitative_segment"),
			qualitativeMaterialId,
			ordinal,
			text: segment.text,
			locator: {
				charStart: segment.charStart,
				charEnd: segment.charEnd,
				anchorHash: hashBytes(segment.text),
			},
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: operationId,
				updatedByOperationId: operationId,
			},
		}));
		const created = await createRecords(opened.root, segments, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		return created.ok ? successResult(segments, operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"QUALITATIVE_SEGMENTATION_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Qualitative segmentation failed",
			operationId,
		);
	}
}

export async function createCodebookVersion(
	projectRoot: string,
	title: string,
	codes: CodebookCode[],
	supersedesCodebookVersionId: string | null,
	expectedManifestRevision: number,
	operationId: string,
): Promise<ResearchResult<CodebookVersion>> {
	try {
		const opened = await openProject(projectRoot, expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		let codebookSeriesId = `codebook-series-${createOpaqueId("codebook_version")}`;
		let version = 1;
		if (supersedesCodebookVersionId !== null) {
			const previous = await readRecord(opened.root, "codebook_version", supersedesCodebookVersionId);
			if (!previous.ok) return propagatedFailure(previous);
			if (previous.value.kind !== "codebook_version" || previous.value.status !== "confirmed") {
				throw new TypeError("Only a confirmed codebook version can be superseded");
			}
			codebookSeriesId = previous.value.codebookSeriesId;
			version = previous.value.version + 1;
		}
		const now = new Date().toISOString();
		const codebook: CodebookVersion = {
			kind: "codebook_version",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			codebookVersionId: createOpaqueId("codebook_version"),
			codebookSeriesId,
			version,
			title,
			codes: [...codes],
			status: "awaiting_confirmation",
			confirmation: { decision: null, decidedAt: null, decidedBy: null, note: null },
			supersedesCodebookVersionId,
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: operationId,
				updatedByOperationId: operationId,
			},
		};
		const created = await createRecord(opened.root, codebook, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		return created.ok ? successResult(codebook, operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"CODEBOOK_CREATE_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Codebook creation failed",
			operationId,
		);
	}
}

export async function decideQualitativeSynthesis(
	projectRoot: string,
	kind: "codebook_version" | "theme_synthesis",
	id: string,
	expectedManifestRevision: number,
	expectedRecordRevision: number,
	decision: "confirmed" | "rejected",
	note: string | null,
	operationId: string,
): Promise<ResearchResult<RecordRef>> {
	const current = await readRecord(projectRoot, kind, id);
	if (!current.ok) return propagatedFailure(current);
	if (
		(current.value.kind !== "codebook_version" && current.value.kind !== "theme_synthesis") ||
		current.value.status !== "awaiting_confirmation"
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"QUALITATIVE_RECORD_NOT_REVIEWABLE",
			"validation",
			"Qualitative record is not awaiting confirmation",
			operationId,
		);
	}
	return updateRecord(projectRoot, kind, id, {
		expectedManifestRevision,
		expectedRecordRevision,
		operationId,
		changes: {
			status: decision,
			confirmation: { decision, decidedAt: new Date().toISOString(), decidedBy: "user", note },
		},
	});
}

export async function recordModelSuggestion(
	projectRoot: string,
	qualitativeSegmentId: string,
	codebookVersionId: string,
	suggestedCodeIds: string[],
	rationale: string,
	model: ModelProvenanceInput,
	expectedManifestRevision: number,
	operationId: string,
): Promise<ResearchResult<ModelSuggestion>> {
	try {
		const opened = await openProject(projectRoot, expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const [segment, codebook] = await Promise.all([
			readRecord(opened.root, "qualitative_segment", qualitativeSegmentId),
			readRecord(opened.root, "codebook_version", codebookVersionId),
		]);
		if (!segment.ok) return propagatedFailure(segment);
		if (!codebook.ok) return propagatedFailure(codebook);
		if (segment.value.kind !== "qualitative_segment") throw new TypeError("Qualitative segment is invalid");
		if (codebook.value.kind !== "codebook_version" || codebook.value.status !== "confirmed") {
			throw new TypeError("Model suggestions require a confirmed codebook version");
		}
		const codeIds = new Set(codebook.value.codes.map(({ codeId }) => codeId));
		if (suggestedCodeIds.some((id) => !codeIds.has(id))) {
			throw new TypeError("Suggested code is not present in the confirmed codebook");
		}
		const now = new Date().toISOString();
		const suggestion: ModelSuggestion = {
			kind: "model_suggestion",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			modelSuggestionId: createOpaqueId("model_suggestion"),
			qualitativeSegmentId,
			codebookVersionId,
			suggestedCodeIds: [...suggestedCodeIds],
			rationale,
			provenance: {
				operationId,
				provider: model.provider,
				modelId: model.modelId,
				thinkingLevel: model.thinkingLevel,
				structuredInputHash: hashCanonicalJson({
					qualitativeSegmentId,
					codebookVersionId,
					suggestedCodeIds,
					rationale,
				}),
				captureScope: "tool_arguments",
			},
			status: "recorded",
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: operationId,
				updatedByOperationId: operationId,
			},
		};
		const created = await createRecord(opened.root, suggestion, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		return created.ok ? successResult(suggestion, operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"MODEL_SUGGESTION_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Model suggestion could not be recorded",
			operationId,
		);
	}
}

export async function recordCodingDecision(
	projectRoot: string,
	qualitativeSegmentId: string,
	codebookVersionId: string,
	modelSuggestionId: string | null,
	decision: CodingDecision["decision"],
	assignedCodeIds: string[],
	note: string | null,
	supersedesCodingDecisionId: string | null,
	expectedManifestRevision: number,
	operationId: string,
): Promise<ResearchResult<CodingDecision>> {
	try {
		const opened = await openProject(projectRoot, expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const codebook = await readRecord(opened.root, "codebook_version", codebookVersionId);
		if (!codebook.ok) return propagatedFailure(codebook);
		if (codebook.value.kind !== "codebook_version" || codebook.value.status !== "confirmed") {
			throw new TypeError("Coding decisions require a confirmed codebook version");
		}
		const codeIds = new Set(codebook.value.codes.map(({ codeId }) => codeId));
		if (assignedCodeIds.some((id) => !codeIds.has(id))) {
			throw new TypeError("Assigned code is not present in the confirmed codebook");
		}
		const segment = await readRecord(opened.root, "qualitative_segment", qualitativeSegmentId);
		if (!segment.ok) return propagatedFailure(segment);
		if (segment.value.kind !== "qualitative_segment") throw new TypeError("Qualitative segment is invalid");
		if (modelSuggestionId !== null) {
			const suggestion = await readRecord(opened.root, "model_suggestion", modelSuggestionId);
			if (!suggestion.ok) return propagatedFailure(suggestion);
			if (
				suggestion.value.kind !== "model_suggestion" ||
				suggestion.value.qualitativeSegmentId !== qualitativeSegmentId ||
				suggestion.value.codebookVersionId !== codebookVersionId
			) {
				throw new TypeError("Model suggestion does not match this segment and codebook");
			}
		}
		if (supersedesCodingDecisionId !== null) {
			const previous = await readRecord(opened.root, "coding_decision", supersedesCodingDecisionId);
			if (!previous.ok) return propagatedFailure(previous);
			if (
				previous.value.kind !== "coding_decision" ||
				previous.value.qualitativeSegmentId !== qualitativeSegmentId ||
				previous.value.codebookVersionId !== codebookVersionId
			) {
				throw new TypeError("Superseded coding decision does not match this segment and codebook");
			}
		}
		const now = new Date().toISOString();
		const coding: CodingDecision = {
			kind: "coding_decision",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			codingDecisionId: createOpaqueId("coding_decision"),
			qualitativeSegmentId,
			codebookVersionId,
			modelSuggestionId,
			decision,
			assignedCodeIds: [...assignedCodeIds],
			note,
			decidedAt: now,
			decidedBy: "user",
			supersedesCodingDecisionId,
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: operationId,
				updatedByOperationId: operationId,
			},
		};
		const created = await createRecord(opened.root, coding, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		return created.ok ? successResult(coding, operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"CODING_DECISION_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Coding decision could not be recorded",
			operationId,
		);
	}
}

export async function createThemeSynthesis(
	projectRoot: string,
	codebookVersionId: string,
	title: string,
	themes: Theme[],
	codingDecisionIds: string[],
	supersedesThemeSynthesisId: string | null,
	expectedManifestRevision: number,
	operationId: string,
): Promise<ResearchResult<ThemeSynthesis>> {
	try {
		const opened = await openProject(projectRoot, expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const codebook = await readRecord(opened.root, "codebook_version", codebookVersionId);
		if (!codebook.ok) return propagatedFailure(codebook);
		if (codebook.value.kind !== "codebook_version" || codebook.value.status !== "confirmed") {
			throw new TypeError("Theme synthesis requires a confirmed codebook version");
		}
		for (const codingDecisionId of codingDecisionIds) {
			const coding = await readRecord(opened.root, "coding_decision", codingDecisionId);
			if (!coding.ok) return propagatedFailure(coding);
			if (coding.value.kind !== "coding_decision" || coding.value.codebookVersionId !== codebookVersionId) {
				throw new TypeError("Theme synthesis contains a coding decision from another codebook version");
			}
		}
		if (supersedesThemeSynthesisId !== null) {
			const previous = await readRecord(opened.root, "theme_synthesis", supersedesThemeSynthesisId);
			if (!previous.ok) return propagatedFailure(previous);
			if (previous.value.kind !== "theme_synthesis" || previous.value.codebookVersionId !== codebookVersionId) {
				throw new TypeError("Superseded theme synthesis uses another codebook version");
			}
		}
		const now = new Date().toISOString();
		const synthesis: ThemeSynthesis = {
			kind: "theme_synthesis",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			themeSynthesisId: createOpaqueId("theme_synthesis"),
			codebookVersionId,
			title,
			themes: [...themes],
			codingDecisionIds: [...codingDecisionIds],
			status: "awaiting_confirmation",
			confirmation: { decision: null, decidedAt: null, decidedBy: null, note: null },
			supersedesThemeSynthesisId,
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: operationId,
				updatedByOperationId: operationId,
			},
		};
		const created = await createRecord(opened.root, synthesis, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		return created.ok ? successResult(synthesis, operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"THEME_SYNTHESIS_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Theme synthesis could not be created",
			operationId,
		);
	}
}

async function qualitativeRecords(projectRoot: string): Promise<ProjectRecord[]> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const kinds = [
		"qualitative_material",
		"qualitative_segment",
		"codebook_version",
		"model_suggestion",
		"coding_decision",
		"theme_synthesis",
	] as const;
	const records: ProjectRecord[] = [];
	for (const kind of kinds) {
		for (const id of await listProjectRecordIds(opened.root, opened.manifest, kind)) {
			const record = await readRecord(opened.root, kind, id);
			if (!record.ok) throw new TypeError(record.errors[0].message);
			records.push(record.value);
		}
	}
	return records;
}

function cell(value: string): string {
	return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

export async function renderQualitativeAudit(projectRoot: string): Promise<ResearchResult<QualitativeAudit>> {
	try {
		const records = await qualitativeRecords(projectRoot);
		const materials = records.filter((record) => record.kind === "qualitative_material");
		const segments = records.filter((record) => record.kind === "qualitative_segment");
		const codebooks = records.filter((record) => record.kind === "codebook_version");
		const suggestions = records.filter((record) => record.kind === "model_suggestion");
		const decisions = records.filter((record) => record.kind === "coding_decision");
		const syntheses = records.filter((record) => record.kind === "theme_synthesis");
		const lines = [
			"# Qualitative audit trail",
			"",
			`Materials: ${materials.length}; segments: ${segments.length}; codebooks: ${codebooks.length}; suggestions: ${suggestions.length}; human decisions: ${decisions.length}; syntheses: ${syntheses.length}.`,
			"",
			"## Coding decisions",
			"",
			"| Segment | Suggestion | Human decision | Codes | Supersedes |",
			"| --- | --- | --- | --- | --- |",
			...decisions.map(
				(decision) =>
					`| ${decision.qualitativeSegmentId} | ${decision.modelSuggestionId ?? "none"} | ${decision.decision} | ${cell(decision.assignedCodeIds.join(", ")) || "none"} | ${decision.supersedesCodingDecisionId ?? "none"} |`,
			),
			"",
			"## Themes and negative cases",
			"",
			"| Synthesis | Theme | Codes | Segments | Negative cases | Status |",
			"| --- | --- | --- | --- | --- | --- |",
			...syntheses.flatMap((synthesis) =>
				synthesis.themes.map(
					(theme) =>
						`| ${synthesis.themeSynthesisId} | ${cell(theme.label)} | ${cell(theme.codeIds.join(", "))} | ${cell(theme.qualitativeSegmentIds.join(", "))} | ${cell(theme.negativeCaseSegmentIds.join(", ")) || "none"} | ${synthesis.status} |`,
				),
			),
			"",
		];
		return successResult(
			{
				markdown: `${lines.join("\n")}\n`,
				json: `${canonicalStringify({ format: "pi-research-qualitative-audit", version: 1, records })}\n`,
				recordCount: records.length,
			},
			null,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"QUALITATIVE_AUDIT_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Qualitative audit could not be rendered",
			null,
		);
	}
}
