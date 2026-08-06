// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { renderArtifact } from "../src/artifacts/render.ts";
import type { ProtocolRecord, ResearchQuestionVersion } from "../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { validatePersistedRecord } from "../src/contracts/validators.ts";
import { initializeProject } from "../src/project/init.ts";
import { validateProject } from "../src/project/validate.ts";

interface DesignCase {
	caseId: string;
	designType: "quantitative" | "qualitative";
	questionType: ResearchQuestionVersion["questionType"];
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
	basisSummary: string;
}

interface Fixture {
	cases: DesignCase[];
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const timestamp = "2026-08-06T00:00:00.000Z";

function percentile95(samples: readonly number[]): number {
	const sorted = [...samples].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	if (value === undefined) throw new Error("Benchmark produced no samples");
	return Number(value.toFixed(3));
}

async function sample(effect: () => Promise<void> | void, count: number): Promise<number[]> {
	const values: number[] = [];
	for (let index = 0; index < count; index += 1) {
		const started = performance.now();
		await effect();
		values.push(performance.now() - started);
	}
	return values;
}

function protocol(input: DesignCase): ProtocolRecord {
	const operationId = `op_${input.caseId}`;
	return {
		kind: "protocol",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
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
		inclusionCriteria: ["Meets declared population and timeframe"],
		exclusionCriteria: ["Fails the declared inclusion rule"],
		alternativeExplanations: input.alternativeExplanations,
		boundaryConditions: input.boundaryConditions,
		feasibilityLimits: input.feasibilityLimits,
		ethicsChecklist: [{ item: "Ethics and data protection review", status: "required", note: input.ethicsNote }],
		decisionIds: [`decision_${input.caseId}`],
		conceptIds: [`concept_${input.caseId}`],
		theoryRelationIds: [`relation_${input.caseId}`],
		basis: {
			summary: input.basisSummary,
			provenance: [{ kind: "operation", id: operationId, revision: 1 }],
			evidenceGap: true,
		},
		status: "confirmed",
		confirmation: {
			decision: "confirmed",
			decidedAt: timestamp,
			decidedBy: "user",
			note: "Frozen benchmark fixture",
		},
		supersedesProtocolId: null,
		audit: {
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 2,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

function question(input: DesignCase): ResearchQuestionVersion {
	const operationId = `op_${input.caseId}`;
	return {
		kind: "research_question_version",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		researchQuestionVersionId: `rq_${input.caseId}`,
		questionSeriesId: `series_${input.caseId}`,
		version: 1,
		text: input.question,
		questionType: input.questionType,
		rationale: input.basisSummary,
		scope: input.population,
		boundaryConditions: input.boundaryConditions,
		basis: {
			summary: input.basisSummary,
			provenance: [{ kind: "operation", id: operationId, revision: 1 }],
			evidenceGap: true,
		},
		status: "confirmed",
		confirmation: {
			decision: "confirmed",
			decidedAt: timestamp,
			decidedBy: "user",
			note: "Frozen benchmark fixture",
		},
		supersedesResearchQuestionVersionId: null,
		audit: {
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 2,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

const fixture = JSON.parse(await readFile(join(packageRoot, "evals/v0.2/design-fixtures.json"), "utf8")) as Fixture;
const protocols = fixture.cases.map(protocol);
const records = fixture.cases.flatMap((input) => [question(input), protocol(input)]);
for (const record of records) {
	const validation = validatePersistedRecord(record);
	if (!validation.ok) {
		throw new Error(
			`Invalid benchmark record: ${record.kind === "protocol" ? record.protocolId : record.researchQuestionVersionId}`,
		);
	}
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-design-benchmark-"));
try {
	const projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "v0.2 design benchmark" });
	const validationSamples = await sample(async () => {
		const report = await validateProject(projectRoot);
		if (!report.valid) throw new Error("Benchmark project validation failed");
		for (const record of records) {
			if (!validatePersistedRecord(record).ok) throw new Error("Benchmark contract validation failed");
		}
	}, 20);
	let outputBytes = 0;
	const artifactSamples = await sample(() => {
		const rendered = renderArtifact("research-design", records, null);
		if (typeof rendered.content !== "string") throw new Error("Design artifact must be text");
		if (!rendered.content.includes("# Research Design")) throw new Error("Design artifact was not rendered");
		outputBytes = Buffer.byteLength(rendered.content);
	}, 20);
	const localValidationP95Ms = percentile95(validationSamples);
	const designArtifactP95Ms = percentile95(artifactSamples);
	const report = {
		benchmark: "pi-research-agent-v0.2",
		generatedAt: new Date().toISOString(),
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		fixture: {
			designCount: protocols.length,
			quantitativeCount: protocols.filter(({ designType }) => designType === "quantitative").length,
			qualitativeCount: protocols.filter(({ designType }) => designType === "qualitative").length,
			artifactOutputBytes: outputBytes,
		},
		results: {
			localValidation: {
				samples: validationSamples.length,
				p95Ms: localValidationP95Ms,
				thresholdMs: 2_000,
				passed: localValidationP95Ms < 2_000,
			},
			designArtifact: {
				samples: artifactSamples.length,
				p95Ms: designArtifactP95Ms,
				thresholdMs: 5_000,
				passed: designArtifactP95Ms < 5_000,
			},
		},
		usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	};
	const passed = Object.values(report.results).every(({ passed: result }) => result);
	const output = `${JSON.stringify({ ...report, status: passed ? "passed" : "failed" }, null, 2)}\n`;
	const outputIndex = process.argv.indexOf("--output");
	if (outputIndex >= 0) {
		const outputPath = process.argv[outputIndex + 1];
		if (outputPath === undefined) throw new TypeError("--output requires a path");
		await writeFile(resolve(process.cwd(), outputPath), output);
	}
	process.stdout.write(output);
	if (!passed) process.exitCode = 1;
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
