// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Rubric {
	version: string;
	hardGates: string[];
	thresholds: {
		runtimeKinds: number;
		runsPerRuntime: number;
		runtimeHashConsistency: number;
		failureFalseSuccessMax: number;
		rawMutationAfterRecoveryMax: number;
		locatorTraceability: number;
		humanDecisionRetention: number;
		performanceP95Ms: number;
		defaultPerItemModelCalls: number;
		modelInvocationCountMax: number;
	};
}

interface RuntimeBaseline {
	status: string;
	schemaVersion: string;
	runtimes: Array<{
		runtime: string;
		runs: number;
		outputHashes: string[];
		uniqueOutputHashes: number;
		runIdsRetained: number;
		inputMutations: number;
		projectValid: boolean;
	}>;
	usage: { modelCalls: number; apiRequests: number };
}

interface PerformanceBaseline {
	status: string;
	fixture: { rows: number; segments: number };
	results: Record<string, { p95Ms: number; thresholdMs: number; passed: boolean }>;
	usage: { modelCalls: number; apiRequests: number };
}

interface FailureBaseline {
	status: string;
	cases: Array<{
		case: string;
		falseSuccess: boolean;
		rawHashRestored?: boolean;
		licenseContentInspected?: boolean;
	}>;
	sourceTest: string;
}

interface QualitativeBaseline {
	status: string;
	segments: number;
	stableLocators: number;
	modelSuggestions: number;
	humanDecisions: { accepted: number; edited: number; rejected: number; supersededRetained: number };
	negativeCases: number;
	themeVersionsRetained: number;
	modelOverwroteHumanDecision: boolean;
	sourceTest: string;
}

interface ModelBaseline {
	status: string;
	model: string;
	modelInvocationCount: number;
	input: {
		promptSha256: string;
		rubricSha256: string;
		quantitativeSkillSha256: string;
		qualitativeSkillSha256: string;
	};
	execution: { turns: number; webSearchRequests: number; webFetchRequests: number };
	result: {
		taskClass: string;
		quantitativeTool: string;
		qualitativeTool: string;
		nextQuantitativeAction: string;
		nextQualitativeAction: string;
		claimMode: string;
		analysisMayRunNow: boolean;
		codingMayBeAcceptedAutomatically: boolean;
		requiredWarnings: string[];
		stopCondition: string;
	};
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const paths = {
	rubric: join(packageRoot, "evals/rubrics/v0.3.json"),
	runtime: join(packageRoot, "evals/v0.3/baselines/runtime-clean-room-darwin-arm64.json"),
	performance: join(packageRoot, "evals/v0.3/baselines/performance-darwin-arm64.json"),
	failure: join(packageRoot, "evals/v0.3/failure-injection.json"),
	qualitative: join(packageRoot, "evals/v0.3/qualitative-audit-gate.json"),
	model: join(packageRoot, "evals/v0.3/baselines/deepseek-v4-flash-method-boundary.json"),
	prompt: join(packageRoot, "evals/v0.3/model-method-prompt.md"),
	quantitativeSkill: join(packageRoot, "evals/v0.3/inputs/quantitative-research.SKILL.md"),
	qualitativeSkill: join(packageRoot, "evals/v0.3/inputs/qualitative-research.SKILL.md"),
};

function json<Value>(path: string): Value {
	return JSON.parse(readFileSync(path, "utf8")) as Value;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

check(process.argv[2] === "v0.3", "Usage: npm run eval:v0.3 -- v0.3");
const rubric = json<Rubric>(paths.rubric);
const runtime = json<RuntimeBaseline>(paths.runtime);
const performance = json<PerformanceBaseline>(paths.performance);
const failure = json<FailureBaseline>(paths.failure);
const qualitative = json<QualitativeBaseline>(paths.qualitative);
const model = json<ModelBaseline>(paths.model);

check(rubric.version === "0.3.0", "v0.3 rubric version changed");
check(rubric.hardGates.length === 9, "v0.3 hard-gate inventory changed");
check(runtime.status === "passed" && runtime.schemaVersion === "0.3.0", "Runtime qualification did not pass");
check(runtime.runtimes.length === rubric.thresholds.runtimeKinds, "Runtime qualification count changed");
for (const result of runtime.runtimes) {
	check(result.runs === rubric.thresholds.runsPerRuntime, `${result.runtime} run count changed`);
	check(result.outputHashes.length === result.runs, `${result.runtime} output hashes are incomplete`);
	check(
		result.uniqueOutputHashes === rubric.thresholds.runtimeHashConsistency,
		`${result.runtime} output hashes are not reproducible`,
	);
	check(result.runIdsRetained === result.runs, `${result.runtime} run history was not retained`);
	check(result.inputMutations <= rubric.thresholds.rawMutationAfterRecoveryMax, `${result.runtime} mutated raw input`);
	check(result.projectValid, `${result.runtime} qualification project is invalid`);
}
check(runtime.usage.modelCalls === 0 && runtime.usage.apiRequests === 0, "Runtime qualification used external calls");

check(performance.status === "passed", "v0.3 performance baseline did not pass");
check(performance.fixture.rows === 1_000 && performance.fixture.segments === 1_000, "Performance fixture changed");
for (const result of Object.values(performance.results)) {
	check(result.passed, "A v0.3 performance gate failed");
	check(result.thresholdMs === rubric.thresholds.performanceP95Ms, "Performance threshold changed");
	check(result.p95Ms < result.thresholdMs, "Performance p95 exceeds its threshold");
}
check(
	performance.usage.modelCalls === rubric.thresholds.defaultPerItemModelCalls && performance.usage.apiRequests === 0,
	"Performance benchmark used external calls",
);

check(failure.status === "passed", "Failure injection baseline did not pass");
check(
	failure.cases.filter(({ falseSuccess }) => falseSuccess).length <= rubric.thresholds.failureFalseSuccessMax,
	"Failure injection contains a false success",
);
check(
	failure.cases.find(({ case: id }) => id === "raw_input_mutation")?.rawHashRestored,
	"Raw mutation was not restored",
);
check(
	failure.cases.find(({ case: id }) => id === "stata_batch_contract")?.licenseContentInspected === false,
	"Stata qualification inspected license content",
);
readFileSync(join(packageRoot, failure.sourceTest));

check(qualitative.status === "passed", "Qualitative audit baseline did not pass");
check(
	qualitative.stableLocators / qualitative.segments === rubric.thresholds.locatorTraceability,
	"Qualitative locator traceability is incomplete",
);
check(qualitative.modelSuggestions === qualitative.segments, "Qualitative suggestions are incomplete");
check(
	qualitative.humanDecisions.accepted > 0 &&
		qualitative.humanDecisions.edited > 0 &&
		qualitative.humanDecisions.rejected > 0 &&
		qualitative.humanDecisions.supersededRetained >= rubric.thresholds.humanDecisionRetention,
	"Qualitative human decision history is incomplete",
);
check(
	qualitative.negativeCases > 0 && qualitative.themeVersionsRetained > 1,
	"Qualitative audit lost a negative case or rerun",
);
check(!qualitative.modelOverwroteHumanDecision, "A model suggestion overwrote a human coding decision");
readFileSync(join(packageRoot, qualitative.sourceTest));

check(model.status === "passed", "DeepSeek method-boundary baseline did not pass");
check(model.model === "deepseek-v4-flash", "v0.3 model baseline uses the wrong model");
check(model.modelInvocationCount <= rubric.thresholds.modelInvocationCountMax, "v0.3 model-call budget exceeded");
check(model.input.promptSha256 === sha256(paths.prompt), "Model prompt hash changed");
check(model.input.rubricSha256 === sha256(paths.rubric), "Model rubric hash changed");
check(model.input.quantitativeSkillSha256 === sha256(paths.quantitativeSkill), "Quantitative Skill hash changed");
check(model.input.qualitativeSkillSha256 === sha256(paths.qualitativeSkill), "Qualitative Skill hash changed");
check(
	model.execution.turns === model.modelInvocationCount && model.execution.turns <= 2,
	"Model boundary evaluation used an unreported or excessive number of turns",
);
check(
	model.execution.webSearchRequests === 0 && model.execution.webFetchRequests === 0,
	"Model evaluation used the web",
);
check(model.result.taskClass === "data_and_methods", "Model routed to the wrong task class");
check(model.result.quantitativeTool === "research_analysis", "Model routed quantitative work to the wrong tool");
check(model.result.qualitativeTool === "research_qualitative", "Model routed qualitative work to the wrong tool");
check(model.result.nextQuantitativeAction === "import_dataset", "Model skipped the quantitative import boundary");
check(model.result.nextQualitativeAction === "import_material", "Model skipped the qualitative import boundary");
check(model.result.claimMode === "associational", "Model escalated the claim mode");
check(!model.result.analysisMayRunNow, "Model ran an unconfirmed analysis specification");
check(!model.result.codingMayBeAcceptedAutomatically, "Model auto-accepted qualitative coding");
check(model.result.requiredWarnings.length >= 8, "Model omitted required boundary warnings");
check(model.result.stopCondition.trim().length > 0, "Model omitted its stop condition");

process.stdout.write(
	`${JSON.stringify(
		{
			evaluation: "pi-research-agent-v0.3",
			status: "passed",
			runtimeKinds: runtime.runtimes.map(({ runtime: kind }) => kind),
			failureFalseSuccesses: 0,
			qualitativeLocatorTraceability: qualitative.stableLocators / qualitative.segments,
			performanceP95Ms: Object.fromEntries(
				Object.entries(performance.results).map(([name, result]) => [name, result.p95Ms]),
			),
			model: model.model,
			modelInvocationCount: model.modelInvocationCount,
		},
		null,
		2,
	)}\n`,
);
