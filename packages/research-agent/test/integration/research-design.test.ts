// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordRef } from "../../src/contracts/schemas.ts";
import { successResult } from "../../src/kernel/results.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { projectRecordId } from "../../src/project/record-index.ts";
import { validateProject } from "../../src/project/validate.ts";
import { commitPreparedArtifact, prepareArtifact } from "../../src/tools/artifacts.ts";
import {
	commitDesignDraft,
	type DesignDraft,
	type DesignRecord,
	decideDesignRecord,
	markDesignAwaitingConfirmation,
} from "../../src/tools/design.ts";
import { finishOperation, startOperation } from "../../src/tools/operations.ts";

let temporaryDirectory: string;
let projectRoot: string;
let operationId: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-design-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Public trust research design" });
	const started = await startOperation(projectRoot, {
		operationKind: "tool",
		name: "research_design",
		implementationVersion: "0.2.0",
		session: null,
	});
	if (!started.ok) throw new Error(started.errors[0].message);
	operationId = started.value.operationId;
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

const basis = (summary: string) => ({ summary, provenance: [], evidenceGap: true });

async function createAndConfirm(draft: DesignDraft): Promise<DesignRecord> {
	const created = await commitDesignDraft(projectRoot, operationId, draft);
	if (!created.ok) throw new Error(created.errors[0].message);
	const id = projectRecordId(created.value);
	const awaiting = await markDesignAwaitingConfirmation(
		projectRoot,
		created.value.kind,
		id,
		created.value.audit.revision,
		operationId,
	);
	if (!awaiting.ok) throw new Error(awaiting.errors[0].message);
	const confirmed = await decideDesignRecord(
		projectRoot,
		awaiting.value.kind,
		id,
		awaiting.value.audit.revision,
		"confirmed",
		"Confirmed for the synthetic design fixture",
		operationId,
	);
	if (!confirmed.ok) throw new Error(confirmed.errors[0].message);
	return confirmed.value;
}

function protocolDraft(
	designType: "quantitative" | "qualitative",
	questionId: string,
	decisionId: string,
	conceptIds: string[],
	relationId: string,
): DesignDraft {
	return {
		kind: "protocol",
		value: {
			title: `${designType} transparency and trust protocol`,
			researchQuestionVersionId: questionId,
			designType,
			claimMode: designType === "quantitative" ? "associational" : "interpretive",
			method: designType === "quantitative" ? "Panel survey with fixed effects" : "Comparative case study",
			population: "Residents interacting with municipal algorithmic services",
			unitOfAnalysis: designType === "quantitative" ? "respondent-wave" : "municipal service case",
			timeframe: "2026-2027",
			samplingPlan: "Purposive site selection followed by documented participant sampling",
			measurementPlan: "Predefined transparency exposure and institutional trust measures",
			dataCollectionPlan: "Collect only consented or public research material",
			analysisPlan:
				designType === "quantitative"
					? "Estimate associations with declared controls and robustness checks"
					: "Code cases with a versioned codebook and compare mechanisms",
			identificationStrategy: null,
			identificationAssumptions: [],
			preanalysisPlan:
				designType === "quantitative" ? "Freeze variables, exclusions, and models before analysis" : null,
			interviewPlan:
				designType === "qualitative" ? "Use a consented semi-structured protocol and preserve audit notes" : null,
			caseSelectionPlan:
				designType === "qualitative" ? "Select contrasting municipalities using declared criteria" : null,
			inclusionCriteria: ["Documented exposure to an algorithmic public service"],
			exclusionCriteria: ["No observable transparency intervention"],
			alternativeExplanations: ["Prior institutional trust"],
			boundaryConditions: ["Municipal digital public services"],
			feasibilityLimits: ["No claim beyond sampled sites"],
			ethicsChecklist: [{ item: "Human-subject review", status: "required", note: "User must complete review" }],
			decisionIds: [decisionId],
			conceptIds,
			theoryRelationIds: [relationId],
			basis: basis("Protocol is a design proposal with an explicit evidence gap"),
			supersedesProtocolId: null,
		},
	};
}

describe("research design workflow", () => {
	it("confirms quantitative and qualitative designs, renders them, and preserves provenance", async () => {
		const question = await createAndConfirm({
			kind: "research_question_version",
			value: {
				questionSeriesId: "rq-series-transparency-trust",
				version: 1,
				text: "How is algorithmic transparency associated with institutional trust in municipal services?",
				questionType: "associational",
				rationale: "The v0.1 review identifies a testable but unresolved relationship",
				scope: "Municipal digital public services",
				boundaryConditions: ["Resident-facing algorithmic decisions"],
				basis: basis("The evidence ledger records a design gap"),
				supersedesResearchQuestionVersionId: null,
			},
		});
		if (question.kind !== "research_question_version") throw new Error("Expected question record");

		const exposure = await createAndConfirm({
			kind: "concept",
			value: {
				name: "Algorithmic transparency",
				definition: "Information that makes an automated public decision understandable to affected residents",
				role: "exposure",
				aliases: ["decision transparency"],
				measurementNotes: ["Separate disclosure presence from disclosure quality"],
				boundaryConditions: ["Resident-facing disclosures"],
				basis: basis("Construct definition remains to be empirically validated"),
				supersedesConceptId: null,
			},
		});
		const outcome = await createAndConfirm({
			kind: "concept",
			value: {
				name: "Institutional trust",
				definition: "A resident's willingness to accept vulnerability to a public institution",
				role: "outcome",
				aliases: ["public trust"],
				measurementNotes: ["Use a declared multi-item scale"],
				boundaryConditions: ["Trust in the responsible institution"],
				basis: basis("Construct definition remains to be empirically validated"),
				supersedesConceptId: null,
			},
		});
		if (exposure.kind !== "concept" || outcome.kind !== "concept") throw new Error("Expected concepts");

		const relation = await createAndConfirm({
			kind: "theory_relation",
			value: {
				fromConceptId: exposure.conceptId,
				toConceptId: outcome.conceptId,
				relationType: "association",
				direction: "positive",
				statement: "Higher-quality transparency may be associated with greater institutional trust",
				hypothesesOrPropositions: ["H1: transparency quality is positively associated with trust"],
				boundaryConditions: ["Disclosures are accessible to affected residents"],
				alternativeExplanations: ["Pre-existing institutional performance"],
				basis: basis("The relation is a proposition, not an established effect"),
				supersedesTheoryRelationId: null,
			},
		});
		if (relation.kind !== "theory_relation") throw new Error("Expected theory relation");

		const decision = await createAndConfirm({
			kind: "design_decision",
			value: {
				decisionType: "method",
				question: "Which complementary designs should address the research question?",
				options: [
					{
						optionId: "mixed-complementary",
						label: "Complementary quantitative and qualitative protocols",
						description: "Estimate associations and inspect mechanisms without collapsing claim types",
						tradeoffs: ["More collection effort"],
						risks: ["Cross-method findings may diverge"],
					},
					{
						optionId: "quant-only",
						label: "Quantitative protocol only",
						description: "Estimate associations without a case mechanism study",
						tradeoffs: ["Lower collection effort"],
						risks: ["Mechanisms remain weakly observed"],
					},
				],
				selectedOptionId: "mixed-complementary",
				rationale: "The methods answer distinct parts of the question",
				alternativesConsidered: ["Quantitative protocol only"],
				limitations: ["The designs do not by themselves establish a causal effect"],
				basis: basis("Method choice is explicit despite incomplete empirical evidence"),
				critical: true,
				supersedesDesignDecisionId: null,
			},
		});
		if (decision.kind !== "design_decision") throw new Error("Expected design decision");

		const conceptIds = [exposure.conceptId, outcome.conceptId];
		const quantitative = await createAndConfirm(
			protocolDraft(
				"quantitative",
				question.researchQuestionVersionId,
				decision.designDecisionId,
				conceptIds,
				relation.theoryRelationId,
			),
		);
		const qualitative = await createAndConfirm(
			protocolDraft(
				"qualitative",
				question.researchQuestionVersionId,
				decision.designDecisionId,
				conceptIds,
				relation.theoryRelationId,
			),
		);
		if (quantitative.kind !== "protocol" || qualitative.kind !== "protocol") {
			throw new Error("Expected protocol records");
		}

		const designRecords = [question, exposure, outcome, relation, decision, quantitative, qualitative];
		const designRefs: RecordRef[] = designRecords.map((record) => ({
			kind: record.kind,
			id: projectRecordId(record),
			revision: record.audit.revision,
		}));
		const designFinished = await finishOperation(
			projectRoot,
			operationId,
			successResult({ complete: true }, operationId),
			designRefs,
		);
		expect(designFinished).toMatchObject({ ok: true, value: { status: "succeeded" } });

		const artifactOperation = await startOperation(projectRoot, {
			operationKind: "tool",
			name: "research_artifacts",
			implementationVersion: "0.2.0",
			session: null,
			inputs: designRefs,
		});
		if (!artifactOperation.ok) throw new Error(artifactOperation.errors[0].message);
		const artifactOperationId = artifactOperation.value.operationId;
		const protocolRefs = designRefs.filter(({ kind }) => kind === "protocol");
		const prepared = await prepareArtifact(
			projectRoot,
			{
				action: "generate_structured",
				artifactType: "research-design",
				content: null,
				sourceRefs: protocolRefs,
				targetStatus: "exploratory",
				outputPath: null,
			},
			artifactOperationId,
		);
		if (!prepared.ok) throw new Error(prepared.errors[0].message);
		const committed = await commitPreparedArtifact(projectRoot, prepared.value, artifactOperationId, null, null);
		if (!committed.ok) throw new Error(committed.errors[0].message);
		const rendered = await readFile(join(projectRoot, committed.value.artifact.outputFile.path), "utf8");
		expect(rendered).toContain("# Research Design");
		expect(rendered).toContain("## Protocols");
		expect(rendered).toContain("quantitative transparency and trust protocol");
		expect(rendered).toContain("qualitative transparency and trust protocol");

		const artifactRef = {
			kind: "artifact" as const,
			id: committed.value.artifact.artifactId,
			revision: committed.value.artifact.audit.revision,
		};
		const artifactFinished = await finishOperation(
			projectRoot,
			artifactOperationId,
			successResult({ complete: true }, artifactOperationId),
			[artifactRef],
			[committed.value.artifact.outputFile],
		);
		expect(artifactFinished).toMatchObject({ ok: true, value: { status: "succeeded" } });
		const opened = await openProject(projectRoot);
		expect(opened).toMatchObject({ compatibility: "current", manifest: { currentStage: "research_design" } });
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	});

	it("persists awaiting confirmation and rejects stale or denied decisions", async () => {
		const created = await commitDesignDraft(projectRoot, operationId, {
			kind: "research_question_version",
			value: {
				questionSeriesId: "rq-series-rejected",
				version: 1,
				text: "Should this draft question be used?",
				questionType: "exploratory",
				rationale: "Exercise the explicit confirmation boundary",
				scope: "Synthetic fixture",
				boundaryConditions: ["No empirical claim"],
				basis: basis("No evidence is claimed"),
				supersedesResearchQuestionVersionId: null,
			},
		});
		if (!created.ok) throw new Error(created.errors[0].message);
		const id = projectRecordId(created.value);
		const awaiting = await markDesignAwaitingConfirmation(projectRoot, created.value.kind, id, 0, operationId);
		if (!awaiting.ok) throw new Error(awaiting.errors[0].message);

		expect(
			await decideDesignRecord(projectRoot, awaiting.value.kind, id, 0, "confirmed", null, operationId),
		).toMatchObject({
			ok: false,
			status: "DATA_CONFLICT",
		});
		const rejected = await decideDesignRecord(
			projectRoot,
			awaiting.value.kind,
			id,
			awaiting.value.audit.revision,
			"rejected",
			"Question is too broad",
			operationId,
		);
		expect(rejected).toMatchObject({
			ok: true,
			value: {
				status: "rejected",
				confirmation: { decision: "rejected", decidedBy: "user", note: "Question is too broad" },
			},
		});
	});
});
