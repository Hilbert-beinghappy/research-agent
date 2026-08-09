// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStatus } from "../../src/extension/commands.ts";
import { registerResearchTools } from "../../src/extension/tools.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { listProjectRecordIds } from "../../src/project/record-index.ts";
import { commitProjectTransaction } from "../../src/project/transactions.ts";
import { validateProject } from "../../src/project/validate.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-writing-tools-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Writing tool fixture" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function harness(hasUI = true) {
	const tools = new Map<string, ToolDefinition>();
	const confirm = vi.fn(async () => true);
	const pi = {
		registerTool(tool: ToolDefinition): void {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerResearchTools(pi, {
		version: "0.4.0",
		async requireProject() {
			const opened = await openProject(projectRoot);
			if (opened.compatibility !== "current") throw new Error("Expected current project");
			return opened;
		},
		appendProjectLink(): void {},
	});
	const context = {
		cwd: projectRoot,
		hasUI,
		mode: "tui",
		model: { provider: "deepseek", id: "deepseek-v4-flash" },
		thinkingLevel: "medium",
		signal: new AbortController().signal,
		ui: { confirm, notify: vi.fn(), select: vi.fn(), setStatus: vi.fn() },
		sessionManager: {
			getSessionId: () => "writing-session",
			getSessionFile: () => join(projectRoot, "session.jsonl"),
			getEntries: () => [],
		},
	} as unknown as ExtensionContext;
	return { tools, confirm, context };
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}

async function revision(): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	return opened.manifest.revision;
}

async function callTool(
	testHarness: ReturnType<typeof harness>,
	name: "research_artifacts" | "research_manuscript" | "research_review",
	params: object,
): Promise<Record<string, unknown>> {
	const tool = testHarness.tools.get(name);
	if (tool === undefined) throw new Error(`Missing ${name}`);
	const response = await tool.execute("writing-call", params, undefined, undefined, testHarness.context);
	const content = response.content[0];
	if (content?.type !== "text") throw new Error("Tool did not return JSON text");
	return object(JSON.parse(content.text));
}

async function createRevision(
	testHarness: ReturnType<typeof harness>,
	content: string,
	supersedesManuscriptId: string | null,
): Promise<Record<string, unknown>> {
	return callTool(testHarness, "research_manuscript", {
		action: "create_revision",
		expectedRevision: await revision(),
		title: "Auditable public-management manuscript",
		paperType: "conceptual",
		abstract: "A synthetic manuscript used to test the writing contract.",
		bibliography: [],
		methodRecords: [],
		sections: [
			{
				sectionKey: "introduction",
				title: "Introduction",
				order: 0,
				content,
				occurrences: [],
			},
		],
		supersedesManuscriptId,
		authoringOrigin: "model",
	});
}

function manuscriptFrom(result: Record<string, unknown>): Record<string, unknown> {
	return object(object(result.value).manuscript);
}

describe("Pi manuscript and review tools", () => {
	it("connects immutable drafting, review, revision, disclosure, and submission approval", async () => {
		const testHarness = harness();
		const first = await createRevision(testHarness, "The first immutable draft.", null);
		expect(first).toMatchObject({
			ok: true,
			value: { manuscript: { version: 1, authoring: { provider: "deepseek", modelId: "deepseek-v4-flash" } } },
		});
		const firstManuscript = manuscriptFrom(first);
		const firstId = firstManuscript.manuscriptId;
		if (typeof firstId !== "string") throw new Error("Missing first manuscript ID");

		const reviewed = await callTool(testHarness, "research_review", {
			action: "record_findings",
			expectedRevision: await revision(),
			manuscriptId: firstId,
			findings: [
				{
					reviewerRole: "editor",
					findingType: "stylistic_suggestion",
					severity: "P1",
					title: "Clarify scope",
					message: "State that the example is synthetic.",
					sectionId: null,
					claimOccurrenceId: null,
				},
			],
		});
		expect(reviewed).toMatchObject({
			ok: true,
			value: [{ source: "model", model: { provider: "deepseek", modelId: "deepseek-v4-flash" } }],
		});
		const finding = object((reviewed.value as unknown[])[0]);
		if (typeof finding.reviewFindingId !== "string") throw new Error("Missing review finding ID");
		const disposition = await callTool(testHarness, "research_review", {
			action: "decide_finding",
			expectedRevision: await revision(),
			manuscriptId: firstId,
			reviewFindingId: finding.reviewFindingId,
			decision: "accept",
			rationale: "The next immutable revision will state the boundary.",
		});
		expect(disposition).toMatchObject({ ok: true, value: { decision: "accept", decidedBy: "user" } });

		const second = await createRevision(
			testHarness,
			"The second immutable draft uses only synthetic examples.",
			firstId,
		);
		expect(second).toMatchObject({
			ok: true,
			value: { manuscript: { version: 2, supersedesManuscriptId: firstId } },
		});
		const secondManuscript = manuscriptFrom(second);
		const secondId = secondManuscript.manuscriptId;
		if (typeof secondId !== "string") throw new Error("Missing second manuscript ID");
		const diff = await callTool(testHarness, "research_manuscript", {
			action: "diff",
			expectedRevision: await revision(),
			fromManuscriptId: firstId,
			toManuscriptId: secondId,
		});
		expect(diff).toMatchObject({ ok: true, value: { changed: [{ sectionKey: "introduction" }] } });
		const rollback = await callTool(testHarness, "research_review", {
			action: "set_active_revision",
			expectedRevision: await revision(),
			fromManuscriptId: secondId,
			toManuscriptId: firstId,
			decision: "rollback",
			rationale: "Audit rollback without overwriting either revision.",
		});
		expect(rollback).toMatchObject({ ok: true, value: { decision: "rollback", toManuscriptId: firstId } });

		const disclosure = await callTool(testHarness, "research_manuscript", {
			action: "create_disclosure",
			expectedRevision: await revision(),
			manuscriptId: secondId,
			aiUse: "DeepSeek assisted section drafting and rubric review.",
			modelIds: ["deepseek-v4-flash"],
			humanResponsibilities: ["The author checked every factual statement."],
			limitations: ["AI review is not human peer review."],
			unautomatedDecisions: ["Interpretation and submission remain human decisions."],
		});
		expect(disclosure).toMatchObject({ ok: true, value: { status: "confirmed" } });
		const submitted = await callTool(testHarness, "research_manuscript", {
			action: "submission_gate",
			expectedRevision: await revision(),
			manuscriptId: secondId,
		});
		expect(submitted).toMatchObject({
			ok: true,
			value: { passed: true, publishability: "submission_candidate", warningsAccepted: true },
		});
		const submissionGateReportId = object(submitted.value).submissionGateReportId;
		if (typeof submissionGateReportId !== "string") throw new Error("Missing submission gate report ID");
		const exported = await callTool(testHarness, "research_artifacts", {
			action: "generate_structured",
			artifactType: "manuscript",
			sourceRefs: [
				{ kind: "manuscript", id: secondId, revision: 0 },
				{ kind: "submission_gate_report", id: submissionGateReportId, revision: 0 },
			],
			targetStatus: "submission_candidate",
		});
		if (exported.ok !== true) throw new Error(JSON.stringify(exported));
		expect(exported).toMatchObject({
			ok: true,
			value: { artifact: { artifactKind: "markdown", publishability: "submission_candidate" } },
		});
		const artifact = object(object(exported.value).artifact);
		const outputFile = object(artifact.outputFile);
		if (typeof outputFile.path !== "string") throw new Error("Missing manuscript artifact path");
		const markdown = await readFile(join(projectRoot, ...outputFile.path.split("/")), "utf8");
		expect(markdown).toContain("The second immutable draft uses only synthetic examples.");
		expect(markdown).toContain("## AI Disclosure");
		expect(markdown).toContain("Submission gate: passed");
		expect(testHarness.confirm).toHaveBeenCalledTimes(4);
		const current = await openProject(projectRoot);
		if (current.compatibility !== "current") throw new Error("Expected current project");
		expect(await projectStatus(current, "full")).toMatchObject({
			manuscriptVersions: 2,
			reviewFindingsBySeverity: { P1: 1 },
			submissionGatesByPublishability: { submission_candidate: 1 },
		});
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	}, 15_000);

	it("blocks manuscript content before reading records when model egress is denied", async () => {
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		await commitProjectTransaction(opened.root, {
			expectedRevision: opened.manifest.revision,
			writes: [],
			manifest: {
				...opened.manifest,
				policy: {
					...opened.manifest.policy,
					allowedDataClassesForModelEgress: ["bibliographic_metadata"],
				},
				updatedAt: new Date().toISOString(),
				revision: opened.manifest.revision + 1,
			},
		});
		const testHarness = harness();
		for (const [name, params] of [
			[
				"research_manuscript",
				{
					action: "diff",
					expectedRevision: await revision(),
					fromManuscriptId: "manuscript_missing",
					toManuscriptId: "manuscript_missing",
				},
			],
			[
				"research_review",
				{
					action: "record_integrity_findings",
					expectedRevision: await revision(),
					manuscriptId: "manuscript_missing",
				},
			],
		] as const) {
			const blocked = await callTool(testHarness, name, params);
			expect(blocked).toMatchObject({
				ok: false,
				status: "PERMISSION_BLOCKED",
				errors: [{ code: "MODEL_EGRESS_DENIED" }],
			});
			expect(JSON.stringify(blocked)).not.toContain("RECORD_NOT_FOUND");
		}
		const current = await openProject(projectRoot);
		if (current.compatibility !== "current") throw new Error("Expected current project");
		expect(await listProjectRecordIds(current.root, current.manifest, "manuscript")).toEqual([]);
	});
});
