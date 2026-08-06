// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Rubric {
	version: string;
	hardGates: string[];
	thresholds: {
		failureInjectionCases: number;
		failureFalseSuccessMax: number;
		coreClaimOccurrenceCoverage: number;
		citationVerificationCoverage: number;
		unresolvedP0Allowed: number;
		fixtureWords: number;
		performanceP95Ms: number;
		modelInvocationCountMax: number;
		modelCostUsdMax: number;
	};
}

interface FailureInventory {
	version: string;
	status: string;
	sourceTest: string;
	cases: Array<{
		caseId: string;
		expectedGate: string;
		expectedStatus: "failed" | "warning";
		falseSuccess: boolean;
	}>;
}

interface PerformanceBaseline {
	status: string;
	schemaVersion: string;
	fixture: { words: number };
	results: { manuscriptIntegrity: { p95Ms: number; thresholdMs: number; passed: boolean } };
	usage: { modelCalls: number; apiRequests: number };
}

interface ModelBaseline {
	status: string;
	model: string;
	thinkingLevel: string;
	modelInvocationCount: number;
	input: Record<string, string>;
	execution: {
		validatedTurns: number;
		unvalidatedInvocations: number;
		unobservedCostInvocations: number;
		totalCostUsd: number;
		webSearchRequests: number;
		webFetchRequests: number;
	};
	result: {
		taskClass: string;
		manuscriptTool: string;
		reviewTool: string;
		nextAction: string;
		revisionStrategy: string;
		maySubmitNow: boolean;
		mayInventCitation: boolean;
		modelConsensusIsVerification: boolean;
		requiredFindings: string[];
		stopCondition: string;
	};
	resultSha256: string;
	checks: Record<string, boolean>;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const paths = {
	rubric: join(packageRoot, "evals/rubrics/v0.4.json"),
	failures: join(packageRoot, "evals/v0.4/failure-cases.json"),
	performance: join(packageRoot, "evals/v0.4/baselines/performance-darwin-arm64.json"),
	model: join(packageRoot, "evals/v0.4/baselines/deepseek-v4-flash-writing-boundary.json"),
	prompt: join(packageRoot, "evals/v0.4/model-writing-prompt.md"),
	writingSkill: join(packageRoot, "skills/academic-writing/SKILL.md"),
	reviewSkill: join(packageRoot, "skills/academic-review/SKILL.md"),
	revisionSkill: join(packageRoot, "skills/academic-revision/SKILL.md"),
};

function json<Value>(path: string): Value {
	return JSON.parse(readFileSync(path, "utf8")) as Value;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

check(process.argv[2] === "v0.4", "Usage: npm run eval:v0.4 -- v0.4");
const rubric = json<Rubric>(paths.rubric);
const failures = json<FailureInventory>(paths.failures);
const performance = json<PerformanceBaseline>(paths.performance);
const model = json<ModelBaseline>(paths.model);

check(rubric.version === "0.4.0" && rubric.hardGates.length === 10, "v0.4 rubric changed");
check(failures.version === "0.4.0" && failures.status === "passed", "Failure-injection baseline failed");
check(failures.cases.length === rubric.thresholds.failureInjectionCases, "Failure-injection count changed");
check(new Set(failures.cases.map(({ caseId }) => caseId)).size === failures.cases.length, "Duplicate failure case");
check(
	failures.cases.every(({ expectedGate, expectedStatus }) => expectedGate && expectedStatus),
	"Incomplete failure case",
);
check(
	failures.cases.filter(({ falseSuccess }) => falseSuccess).length <= rubric.thresholds.failureFalseSuccessMax,
	"Failure-injection baseline contains a false success",
);

check(performance.status === "passed" && performance.schemaVersion === "0.4.0", "Performance baseline failed");
check(performance.fixture.words === rubric.thresholds.fixtureWords, "Performance fixture changed");
check(performance.results.manuscriptIntegrity.passed, "50k-word integrity benchmark failed");
check(
	performance.results.manuscriptIntegrity.thresholdMs === rubric.thresholds.performanceP95Ms &&
		performance.results.manuscriptIntegrity.p95Ms < rubric.thresholds.performanceP95Ms,
	"50k-word integrity p95 exceeds the gate",
);
check(performance.usage.modelCalls === 0 && performance.usage.apiRequests === 0, "Benchmark used external calls");

check(model.status === "passed" && model.model === "deepseek-v4-flash", "Wrong or failed model baseline");
check(model.modelInvocationCount <= rubric.thresholds.modelInvocationCountMax, "Model-call budget exceeded");
check(model.execution.validatedTurns <= 2, "Validated model output used too many turns");
check(model.execution.totalCostUsd <= rubric.thresholds.modelCostUsdMax, "Validated model call exceeded cost gate");
check(model.execution.unvalidatedInvocations === 1, "Rejected model invocation accounting changed");
check(model.execution.unobservedCostInvocations === 1, "Unobserved model cost must remain explicit");
check(model.execution.webSearchRequests === 0 && model.execution.webFetchRequests === 0, "Model eval used web tools");
check(model.input.promptSha256 === sha256File(paths.prompt), "Model prompt hash changed");
check(model.input.rubricSha256 === sha256File(paths.rubric), "v0.4 rubric hash changed");
check(model.input.writingSkillSha256 === sha256File(paths.writingSkill), "Writing Skill hash changed");
check(model.input.reviewSkillSha256 === sha256File(paths.reviewSkill), "Review Skill hash changed");
check(model.input.revisionSkillSha256 === sha256File(paths.revisionSkill), "Revision Skill hash changed");
check(
	model.resultSha256 === createHash("sha256").update(JSON.stringify(model.result)).digest("hex"),
	"Model result hash changed",
);
check(Object.values(model.checks).every(Boolean), "Model boundary baseline contains a failed check");
check(
	model.result.taskClass === "writing_review_revision" &&
		model.result.manuscriptTool === "research_manuscript" &&
		model.result.reviewTool === "research_review" &&
		model.result.nextAction === "record_integrity_findings",
	"Model routed the writing request incorrectly",
);
check(model.result.revisionStrategy === "immutable_revision", "Model selected a mutable revision strategy");
check(
	!model.result.maySubmitNow && !model.result.mayInventCitation && !model.result.modelConsensusIsVerification,
	"Model crossed a writing or submission boundary",
);
check(model.result.requiredFindings.length >= 8 && model.result.stopCondition.length > 0, "Model omitted findings");

process.stdout.write(
	`${JSON.stringify(
		{
			evaluation: "pi-research-agent-v0.4",
			status: "passed",
			failureInjectionCases: failures.cases.length,
			failureFalseSuccesses: rubric.thresholds.failureFalseSuccessMax,
			integrityP95Ms: performance.results.manuscriptIntegrity.p95Ms,
			model: model.model,
			modelInvocationCount: model.modelInvocationCount,
			validatedModelCostUsd: model.execution.totalCostUsd,
			unobservedCostInvocations: model.execution.unobservedCostInvocations,
		},
		null,
		2,
	)}\n`,
);
