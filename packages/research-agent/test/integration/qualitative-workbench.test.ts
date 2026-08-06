// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	CodebookVersion,
	CodingDecision,
	FileRef,
	ModelSuggestion,
	QualitativeMaterial,
	QualitativeSegment,
	RecordRef,
	ResearchResult,
	ThemeSynthesis,
} from "../../src/contracts/schemas.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { projectRecordId, projectRecordRevision } from "../../src/project/record-index.ts";
import { readRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";
import { finishOperation, startOperation } from "../../src/tools/operations.ts";
import {
	createCodebookVersion,
	createThemeSynthesis,
	decideQualitativeSynthesis,
	importQualitativeMaterial,
	recordCodingDecision,
	recordModelSuggestion,
	renderQualitativeAudit,
	segmentQualitativeMaterial,
} from "../../src/tools/qualitative.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-qualitative-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Synthetic public-service interviews" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function begin(name: string): Promise<string> {
	const started = await startOperation(projectRoot, {
		operationKind: "tool",
		name,
		implementationVersion: "0.3.0",
		session: null,
	});
	if (!started.ok) throw new Error(started.errors[0].message);
	return started.value.operationId;
}

async function finish(
	operationId: string,
	result: ResearchResult<unknown>,
	outputs: RecordRef[] = [],
	outputFiles: FileRef[] = [],
): Promise<void> {
	const finished = await finishOperation(projectRoot, operationId, result, outputs, outputFiles);
	if (!finished.ok) throw new Error(finished.errors[0].message);
}

async function currentRevision(): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	return opened.manifest.revision;
}

function ref(
	record:
		| QualitativeMaterial
		| QualitativeSegment
		| CodebookVersion
		| ModelSuggestion
		| CodingDecision
		| ThemeSynthesis,
): RecordRef {
	return { kind: record.kind, id: projectRecordId(record), revision: projectRecordRevision(record) };
}

async function confirm(kind: "codebook_version" | "theme_synthesis", id: string, revision: number): Promise<RecordRef> {
	const operationId = await begin(`research.qualitative.confirm_${kind}`);
	const result = await decideQualitativeSynthesis(
		projectRoot,
		kind,
		id,
		await currentRevision(),
		revision,
		"confirmed",
		"Confirmed by the synthetic human-review fixture",
		operationId,
	);
	if (!result.ok) throw new Error(result.errors[0].message);
	await finish(operationId, result, [result.value]);
	return result.value;
}

async function suggest(
	segment: QualitativeSegment,
	codebook: CodebookVersion,
	codeIds: string[],
): Promise<ModelSuggestion> {
	const operationId = await begin("research.qualitative.model_suggestion");
	const result = await recordModelSuggestion(
		projectRoot,
		segment.qualitativeSegmentId,
		codebook.codebookVersionId,
		codeIds,
		"Structured suggestion for human review",
		{ provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "off" },
		await currentRevision(),
		operationId,
	);
	if (!result.ok) throw new Error(result.errors[0].message);
	await finish(operationId, result, [ref(result.value)]);
	return result.value;
}

async function code(
	segment: QualitativeSegment,
	codebook: CodebookVersion,
	suggestion: ModelSuggestion | null,
	decision: CodingDecision["decision"],
	assignedCodeIds: string[],
	supersedes: CodingDecision | null = null,
): Promise<CodingDecision> {
	const operationId = await begin("research.qualitative.human_coding_decision");
	const result = await recordCodingDecision(
		projectRoot,
		segment.qualitativeSegmentId,
		codebook.codebookVersionId,
		suggestion?.modelSuggestionId ?? null,
		decision,
		assignedCodeIds,
		"Recorded by the synthetic human-review fixture",
		supersedes?.codingDecisionId ?? null,
		await currentRevision(),
		operationId,
	);
	if (!result.ok) throw new Error(result.errors[0].message);
	await finish(operationId, result, [ref(result.value)]);
	return result.value;
}

describe("qualitative coding and audit workbench", () => {
	it("preserves stable locators, model suggestions, human edits, negative cases, and reruns", async () => {
		const materialPath = join(temporaryDirectory, "interviews.txt");
		await writeFile(
			materialPath,
			"Participant A: The explanation helped me trust the service.\n\nParticipant B: The notice was visible, but I still doubted the decision.\n\nParticipant C: I saw no useful explanation and rejected the process.\n",
		);
		const importOperationId = await begin("research.qualitative.import_material");
		const imported = await importQualitativeMaterial(projectRoot, {
			path: materialPath,
			title: "De-identified synthetic interviews",
			sensitivity: "public",
			deidentified: true,
			expectedManifestRevision: await currentRevision(),
			operationId: importOperationId,
			sessionId: null,
		});
		if (!imported.ok) throw new Error(imported.errors[0].message);
		await finish(importOperationId, imported, [ref(imported.value)], [imported.value.sourceFile]);

		const segmentOperationId = await begin("research.qualitative.segment_material");
		const segmented = await segmentQualitativeMaterial(
			projectRoot,
			imported.value.qualitativeMaterialId,
			await currentRevision(),
			segmentOperationId,
		);
		if (!segmented.ok) throw new Error(segmented.errors[0].message);
		await finish(segmentOperationId, segmented, segmented.value.map(ref));
		expect(segmented.value).toHaveLength(3);
		for (const segment of segmented.value) {
			expect(segment.locator.charEnd - segment.locator.charStart).toBe(segment.text.length);
		}

		const codebookOperationId = await begin("research.qualitative.create_codebook");
		const codebookResult = await createCodebookVersion(
			projectRoot,
			"Trust response codebook",
			[
				{
					codeId: "trust",
					label: "Trust",
					definition: "The participant expresses increased institutional trust",
					inclusionCriteria: ["Explicit positive trust statement"],
					exclusionCriteria: ["Mere awareness without trust"],
				},
				{
					codeId: "skepticism",
					label: "Skepticism",
					definition: "The participant doubts the explanation or decision",
					inclusionCriteria: ["Explicit doubt or rejection"],
					exclusionCriteria: ["Unqualified positive trust"],
				},
			],
			null,
			await currentRevision(),
			codebookOperationId,
		);
		if (!codebookResult.ok) throw new Error(codebookResult.errors[0].message);
		await finish(codebookOperationId, codebookResult, [ref(codebookResult.value)]);
		await confirm("codebook_version", codebookResult.value.codebookVersionId, 0);
		const storedCodebook = await readRecord(projectRoot, "codebook_version", codebookResult.value.codebookVersionId);
		if (!storedCodebook.ok || storedCodebook.value.kind !== "codebook_version") {
			throw new Error("Confirmed codebook missing");
		}
		const codebook = storedCodebook.value;

		const suggestions: ModelSuggestion[] = [];
		for (const segment of segmented.value) suggestions.push(await suggest(segment, codebook, ["trust"]));
		const accepted = await code(segmented.value[0], codebook, suggestions[0], "accepted", ["trust"]);
		const edited = await code(segmented.value[1], codebook, suggestions[1], "edited", ["skepticism"]);
		const rejected = await code(segmented.value[2], codebook, suggestions[2], "rejected", []);
		expect(edited.assignedCodeIds).toEqual(["skepticism"]);
		expect(suggestions[1].suggestedCodeIds).toEqual(["trust"]);

		const revised = await code(
			segmented.value[1],
			codebook,
			suggestions[1],
			"edited",
			["trust", "skepticism"],
			edited,
		);
		const synthesisOperationId = await begin("research.qualitative.create_theme_synthesis");
		const synthesis = await createThemeSynthesis(
			projectRoot,
			codebook.codebookVersionId,
			"Transparency produces mixed trust responses",
			[
				{
					themeId: "mixed-trust",
					label: "Mixed trust response",
					statement: "Explanations can support trust but do not eliminate skepticism",
					codeIds: ["trust", "skepticism"],
					qualitativeSegmentIds: segmented.value.map(({ qualitativeSegmentId }) => qualitativeSegmentId),
					negativeCaseSegmentIds: [segmented.value[2].qualitativeSegmentId],
				},
			],
			[accepted.codingDecisionId, revised.codingDecisionId, rejected.codingDecisionId],
			null,
			await currentRevision(),
			synthesisOperationId,
		);
		if (!synthesis.ok) throw new Error(synthesis.errors[0].message);
		await finish(synthesisOperationId, synthesis, [ref(synthesis.value)]);
		await confirm("theme_synthesis", synthesis.value.themeSynthesisId, 0);

		const rerunOperationId = await begin("research.qualitative.create_theme_synthesis");
		const rerun = await createThemeSynthesis(
			projectRoot,
			codebook.codebookVersionId,
			"Revised mixed trust synthesis",
			[
				{
					themeId: "mixed-trust-revised",
					label: "Conditional trust",
					statement: "Visibility alone is insufficient; perceived usefulness conditions trust",
					codeIds: ["trust", "skepticism"],
					qualitativeSegmentIds: segmented.value.map(({ qualitativeSegmentId }) => qualitativeSegmentId),
					negativeCaseSegmentIds: [segmented.value[2].qualitativeSegmentId],
				},
			],
			[accepted.codingDecisionId, revised.codingDecisionId, rejected.codingDecisionId],
			synthesis.value.themeSynthesisId,
			await currentRevision(),
			rerunOperationId,
		);
		if (!rerun.ok) throw new Error(rerun.errors[0].message);
		await finish(rerunOperationId, rerun, [ref(rerun.value)]);
		await confirm("theme_synthesis", rerun.value.themeSynthesisId, 0);

		const audit = await renderQualitativeAudit(projectRoot);
		expect(audit.ok).toBe(true);
		if (!audit.ok) throw new Error(audit.errors[0].message);
		expect(audit.value.markdown).toContain("negative cases");
		expect(audit.value.json).toContain(edited.codingDecisionId);
		expect(audit.value.json).toContain(revised.codingDecisionId);
		expect(audit.value.json).toContain(synthesis.value.themeSynthesisId);
		expect(audit.value.json).toContain(rerun.value.themeSynthesisId);
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	}, 20_000);
});
