// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesignDecision, ProtocolRecord } from "../src/contracts/schemas.ts";
import { RESEARCH_V0_2_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { validatePersistedRecord } from "../src/contracts/validators.ts";

interface DesignCase {
	caseId: string;
	domain: string;
	designType: "quantitative" | "qualitative";
	questionType: "descriptive" | "associational" | "causal" | "interpretive" | "comparative";
	question: string;
	claimMode: ProtocolRecord["claimMode"];
	method: string;
	population: string;
	unitOfAnalysis: string;
	timeframe: string;
	samplingPlan: string;
	measurementPlan: string;
	dataCollectionPlan: string;
	analysisPlan: string;
	identificationStrategy: string | null;
	identificationAssumptions: string[];
	preanalysisPlan: string | null;
	interviewPlan: string | null;
	caseSelectionPlan: string | null;
	alternativeExplanations: string[];
	boundaryConditions: string[];
	feasibilityLimits: string[];
	ethicsNote: string;
	selectedMethod: string;
	alternativeMethod: string;
	decisionLimitation: string;
	basisSummary: string;
	causalLanguageAllowed: boolean;
}

interface Fixture {
	schemaVersion: string;
	cases: DesignCase[];
}

interface Rubric {
	hardGates: string[];
	thresholds: {
		fixtureCount: number;
		quantitativeCount: number;
		qualitativeCount: number;
		minimumHardGatesPassedPerFixture: number;
		causalAssociationalGoldViolationsMax: number;
		confirmedMissingProvenanceMax: number;
		injectedBoundaryFalseNegativesMax: number;
	};
}

interface Baseline {
	status: "passed";
	input: { fixtureSha256: string; rubricSha256: string };
	cases: Array<{ caseId: string; hardGatesPassed: number; p0Violations: string[] }>;
	metrics: {
		fixtureCount: number;
		quantitativeCount: number;
		qualitativeCount: number;
		causalAssociationalGoldViolations: number;
		confirmedMissingProvenance: number;
		injectedBoundaryFalseNegatives: number;
	};
}

interface ModelBaseline {
	status: "passed";
	model: string;
	thinkingLevel: string;
	modelInvocationCount: number;
	validatedInvocationCount: number;
	harnessRejectedInvocationCount: number;
	input: {
		promptSha256: string;
		fixtureSha256: string;
		rubricSha256: string;
		skillSha256: string;
		referenceSha256: string;
	};
	execution: {
		turns: number;
		validatedCallCostUsd: number;
		unobservedCostInvocationCount: number;
		usage: { webSearchRequests: number; webFetchRequests: number };
	};
	result: {
		taskClass: string;
		toolSequence: string[];
		questionType: string;
		claimMode: string;
		designStatus: string;
		analysisDecision: string;
		artifactDecision: string;
		evidenceGap: boolean;
		boundaries: {
			abstractIsLocatedEvidence: boolean;
			estimatorIsIdentification: boolean;
			autoConfirmationAllowed: boolean;
			ethicsChecklistIsApproval: boolean;
		};
		requiredRecords: string[];
		requiredWarnings: string[];
		nextAction: string;
	};
	resultSha256: string;
	checks: Record<string, boolean>;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = join(packageRoot, "evals/v0.2/design-fixtures.json");
const rubricPath = join(packageRoot, "evals/rubrics/v0.2.json");
const baselinePath = join(packageRoot, "evals/v0.2/baselines/design-method-boundary.json");
const modelBaselinePath = join(packageRoot, "evals/v0.2/baselines/deepseek-v4-flash-design-boundary.json");
const modelPromptPath = join(packageRoot, "evals/v0.2/model-design-prompt.md");
const designSkillPath = join(packageRoot, "skills/research-design/SKILL.md");
const designReferencePath = join(packageRoot, "skills/research-design/references/management-public-admin.md");
const timestamp = "2026-08-06T00:00:00.000Z";

function json<Value>(path: string): Value {
	return JSON.parse(readFileSync(path, "utf8")) as Value;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function audit(operationId: string) {
	return {
		createdAt: timestamp,
		updatedAt: timestamp,
		revision: 2,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

function basis(input: DesignCase) {
	return {
		summary: input.basisSummary,
		provenance: [{ kind: "operation" as const, id: `op_${input.caseId}`, revision: 1 }],
		evidenceGap: true,
	};
}

function confirmation() {
	return {
		decision: "confirmed" as const,
		decidedAt: timestamp,
		decidedBy: "user" as const,
		note: "Frozen public fixture confirmation",
	};
}

function decision(input: DesignCase): DesignDecision {
	return {
		kind: "design_decision",
		schemaVersion: RESEARCH_V0_2_SCHEMA_VERSION,
		designDecisionId: `decision_${input.caseId}`,
		decisionType: "method",
		question: `Which method should address ${input.question}`,
		options: [
			{
				optionId: "selected",
				label: input.selectedMethod,
				description: input.method,
				tradeoffs: [input.decisionLimitation],
				risks: [input.feasibilityLimits[0] ?? input.decisionLimitation],
			},
			{
				optionId: "alternative",
				label: input.alternativeMethod,
				description: `Alternative to ${input.selectedMethod}`,
				tradeoffs: ["Would answer a different evidentiary target"],
				risks: ["May not fit the stated research question"],
			},
		],
		selectedOptionId: "selected",
		rationale: `The selected method matches the ${input.claimMode} target`,
		alternativesConsidered: [input.alternativeMethod],
		limitations: [input.decisionLimitation],
		basis: basis(input),
		critical: true,
		status: "confirmed",
		confirmation: confirmation(),
		supersedesDesignDecisionId: null,
		audit: audit(`op_${input.caseId}`),
	};
}

function protocol(input: DesignCase): ProtocolRecord {
	return {
		kind: "protocol",
		schemaVersion: RESEARCH_V0_2_SCHEMA_VERSION,
		protocolId: `protocol_${input.caseId}`,
		title: input.question,
		researchQuestionVersionId: `rq_${input.caseId}`,
		designType: input.designType,
		claimMode: input.claimMode,
		method: input.method,
		population: input.population,
		unitOfAnalysis: input.unitOfAnalysis,
		timeframe: input.timeframe,
		samplingPlan: input.samplingPlan,
		measurementPlan: input.measurementPlan,
		dataCollectionPlan: input.dataCollectionPlan,
		analysisPlan: input.analysisPlan,
		identificationStrategy: input.identificationStrategy,
		identificationAssumptions: input.identificationAssumptions,
		preanalysisPlan: input.preanalysisPlan,
		interviewPlan: input.interviewPlan,
		caseSelectionPlan: input.caseSelectionPlan,
		inclusionCriteria: ["Meets the declared population and timeframe"],
		exclusionCriteria: ["Fails the declared inclusion rule"],
		alternativeExplanations: input.alternativeExplanations,
		boundaryConditions: input.boundaryConditions,
		feasibilityLimits: input.feasibilityLimits,
		ethicsChecklist: [{ item: "Ethics and data protection review", status: "required", note: input.ethicsNote }],
		decisionIds: [`decision_${input.caseId}`],
		conceptIds: [`concept_${input.caseId}`],
		theoryRelationIds: [`relation_${input.caseId}`],
		basis: basis(input),
		status: "confirmed",
		confirmation: confirmation(),
		supersedesProtocolId: null,
		audit: audit(`op_${input.caseId}`),
	};
}

function issueCodes(record: ProtocolRecord): string[] {
	const result = validatePersistedRecord(record);
	return result.ok ? [] : result.issues.map(({ code }) => code);
}

check(process.argv[2] === "v0.2", "Usage: npm run eval:v0.2 -- v0.2");
const fixture = json<Fixture>(fixturePath);
const rubric = json<Rubric>(rubricPath);
const baseline = json<Baseline>(baselinePath);
const modelBaseline = json<ModelBaseline>(modelBaselinePath);
check(fixture.schemaVersion === RESEARCH_V0_2_SCHEMA_VERSION, "Fixture schema version is stale");
check(sha256(fixturePath) === baseline.input.fixtureSha256, "Design fixture hash changed");
check(sha256(rubricPath) === baseline.input.rubricSha256, "Design rubric hash changed");
check(baseline.status === "passed", "Frozen design baseline is not marked passed");
check(fixture.cases.length === rubric.thresholds.fixtureCount, "Design fixture count changed");

check(modelBaseline.status === "passed", "Frozen model baseline is not marked passed");
check(modelBaseline.model === "deepseek-v4-flash", "Model baseline must use deepseek-v4-flash");
check(modelBaseline.thinkingLevel === "low", "Model thinking level changed");
check(modelBaseline.modelInvocationCount <= 10, "v0.2 model-call budget exceeded");
check(
	modelBaseline.modelInvocationCount ===
		modelBaseline.validatedInvocationCount + modelBaseline.harnessRejectedInvocationCount,
	"Model invocation accounting is inconsistent",
);
check(modelBaseline.validatedInvocationCount === 1, "Expected one validated model invocation");
check(
	modelBaseline.execution.unobservedCostInvocationCount === modelBaseline.harnessRejectedInvocationCount,
	"Unobserved cost accounting is inconsistent",
);
check(modelBaseline.execution.turns === 1, "Validated model execution must remain one turn");
check(modelBaseline.execution.validatedCallCostUsd <= 0.08, "Validated model call exceeded its cost cap");
check(
	modelBaseline.execution.usage.webSearchRequests === 0 && modelBaseline.execution.usage.webFetchRequests === 0,
	"Model evaluation used a web tool",
);
check(sha256(modelPromptPath) === modelBaseline.input.promptSha256, "Model Prompt hash changed");
check(sha256(fixturePath) === modelBaseline.input.fixtureSha256, "Model fixture hash changed");
check(sha256(rubricPath) === modelBaseline.input.rubricSha256, "Model rubric hash changed");
check(sha256(designSkillPath) === modelBaseline.input.skillSha256, "Research-design Skill hash changed");
check(sha256(designReferencePath) === modelBaseline.input.referenceSha256, "Research-design reference hash changed");
check(
	createHash("sha256").update(JSON.stringify(modelBaseline.result)).digest("hex") === modelBaseline.resultSha256,
	"Model result hash changed",
);
check(modelBaseline.result.taskClass === "research_design", "Model routed to the wrong task class");
check(
	JSON.stringify(modelBaseline.result.toolSequence) === JSON.stringify(["research_design"]),
	"Model routed outside the v0.2 Tool allowlist",
);
check(
	modelBaseline.result.questionType === "associational" && modelBaseline.result.claimMode === "associational",
	"Model overstated the available design as causal",
);
check(modelBaseline.result.designStatus === "awaiting_confirmation", "Model bypassed explicit design confirmation");
check(
	modelBaseline.result.analysisDecision === "blocked" &&
		modelBaseline.result.artifactDecision === "blocked_until_confirmation",
	"Model continued past the v0.2 stop condition",
);
check(modelBaseline.result.evidenceGap, "Model failed to preserve the evidence gap");
check(
	Object.values(modelBaseline.result.boundaries).every((value) => value === false),
	"Model violated a design or evidence boundary",
);
const requiredModelRecords = new Set([
	"ResearchQuestionVersion",
	"ConceptRecord",
	"TheoryRelation",
	"DesignDecision",
	"ProtocolRecord",
]);
check(
	modelBaseline.result.requiredRecords.length === requiredModelRecords.size &&
		modelBaseline.result.requiredRecords.every((record) => requiredModelRecords.has(record)),
	"Model omitted a canonical v0.2 record family",
);
const requiredModelWarnings = [
	"causal_overclaim",
	"missing_identification",
	"abstract_only_evidence",
	"unverified_citations",
	"evidence_gap",
	"requires_user_confirmation",
	"requires_ethics_review",
	"analysis_outside_v0.2",
];
check(
	requiredModelWarnings.every((warning) => modelBaseline.result.requiredWarnings.includes(warning)),
	"Model warning coverage is incomplete",
);
check(modelBaseline.result.nextAction.length > 0, "Model omitted the next action");
check(Object.values(modelBaseline.checks).every(Boolean), "Frozen model check is not passing");

let quantitativeCount = 0;
let qualitativeCount = 0;
let causalAssociationalGoldViolations = 0;
let confirmedMissingProvenance = 0;
const scores: Record<string, number> = {};
for (const input of fixture.cases) {
	if (input.designType === "quantitative") quantitativeCount += 1;
	else qualitativeCount += 1;
	const designDecision = decision(input);
	const designProtocol = protocol(input);
	const decisionValidation = validatePersistedRecord(designDecision);
	const protocolValidation = validatePersistedRecord(designProtocol);
	const methodBoundary =
		(input.claimMode !== "causal" ||
			(input.identificationStrategy !== null && input.identificationAssumptions.length > 0)) &&
		(input.designType !== "quantitative" || input.preanalysisPlan !== null) &&
		(input.designType !== "qualitative" || input.interviewPlan !== null || input.caseSelectionPlan !== null);
	const gates = [
		input.questionType === input.claimMode,
		input.question.length > 0 && input.population.length > 0 && input.unitOfAnalysis.length > 0,
		input.measurementPlan.length > 0 && input.samplingPlan.length > 0,
		methodBoundary,
		input.alternativeExplanations.length > 0,
		input.ethicsNote.length > 0 && input.feasibilityLimits.length > 0,
		decisionValidation.ok && protocolValidation.ok,
		designDecision.basis.provenance.length > 0 && designProtocol.basis.provenance.length > 0,
	];
	const hardGatesPassed = gates.filter(Boolean).length;
	const frozen = baseline.cases.find(({ caseId }) => caseId === input.caseId);
	check(frozen !== undefined, `Missing frozen result: ${input.caseId}`);
	check(frozen.p0Violations.length === 0, `Frozen P0 violation: ${input.caseId}`);
	check(hardGatesPassed === frozen.hardGatesPassed, `Hard-gate drift: ${input.caseId}`);
	check(
		hardGatesPassed >= rubric.thresholds.minimumHardGatesPassedPerFixture,
		`Design fixture failed a hard gate: ${input.caseId}`,
	);
	if (input.causalLanguageAllowed !== (input.claimMode === "causal") || !methodBoundary) {
		causalAssociationalGoldViolations += 1;
	}
	if (
		!designDecision.basis.provenance.some(({ kind }) => kind === "operation") ||
		!designProtocol.basis.provenance.some(({ kind }) => kind === "operation")
	) {
		confirmedMissingProvenance += 1;
	}
	scores[input.caseId] = hardGatesPassed;
}

check(quantitativeCount === rubric.thresholds.quantitativeCount, "Quantitative fixture count changed");
check(qualitativeCount === rubric.thresholds.qualitativeCount, "Qualitative fixture count changed");
check(
	causalAssociationalGoldViolations <= rubric.thresholds.causalAssociationalGoldViolationsMax,
	"Causal or associational gold boundary was violated",
);
check(
	confirmedMissingProvenance <= rubric.thresholds.confirmedMissingProvenanceMax,
	"Confirmed design provenance is missing",
);

const quantitative = {
	...protocol(fixture.cases.find(({ caseId }) => caseId === "quant-descriptive-appeals")!),
	preanalysisPlan: null,
};
const associational = {
	...protocol(fixture.cases.find(({ caseId }) => caseId === "quant-associational-transparency")!),
	claimMode: "causal" as const,
	identificationStrategy: null,
	identificationAssumptions: [],
};
const qualitative = {
	...protocol(fixture.cases.find(({ caseId }) => caseId === "qual-interpretive-frontline")!),
	interviewPlan: null,
	caseSelectionPlan: null,
};
const injections = [
	[quantitative, "protocol.quantitative_plan_missing"],
	[associational, "protocol.causal_identification_missing"],
	[qualitative, "protocol.qualitative_plan_missing"],
] as const;
const injectedBoundaryFalseNegatives = injections.filter(
	([record, expectedCode]) => !issueCodes(record).includes(expectedCode),
).length;
check(
	injectedBoundaryFalseNegatives <= rubric.thresholds.injectedBoundaryFalseNegativesMax,
	"A method-boundary injection was not detected",
);

const metrics = {
	fixtureCount: fixture.cases.length,
	quantitativeCount,
	qualitativeCount,
	causalAssociationalGoldViolations,
	confirmedMissingProvenance,
	injectedBoundaryFalseNegatives,
};
check(JSON.stringify(metrics) === JSON.stringify(baseline.metrics), "Frozen design metrics drifted");
process.stdout.write(
	`${JSON.stringify(
		{
			evalId: "research-design-v0.2",
			status: "passed",
			metrics,
			scores,
			model: modelBaseline.model,
			modelInvocationCount: modelBaseline.modelInvocationCount,
		},
		null,
		2,
	)}\n`,
);
