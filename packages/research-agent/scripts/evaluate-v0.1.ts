// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface EvidenceCase {
	caseId: string;
	evidenceLevel: "abstract" | "fulltext_located";
	relation: "supports" | "refutes" | "qualifies" | "context_only";
	query: string | null;
}

interface Fixture {
	evidenceCases: EvidenceCase[];
	topics: Array<{ slug: string; title: string }>;
}

interface Rubric {
	evidenceCard: {
		sampleSize: number;
		criteria: Array<{ id: string; maxScore: number }>;
		thresholds: {
			allCriteriaAtMax: boolean;
			abstractAsFulltextViolationsMax: number;
			invalidationPropagationRateMin: number;
		};
	};
	literatureReview: {
		sampleSize: number;
		items: Array<{ id: number; maxScore: number }>;
		thresholds: {
			minimumTotal: number;
			hardItemIds: number[];
			hardItemMinimum: number;
			fabricatedEvidenceP0: boolean;
		};
	};
}

interface Baseline {
	status: "passed";
	input: {
		fixtureSha256: string;
		rubricSha256: string;
		reviewSha256: Record<string, string>;
		modelBaselineSha256: string;
	};
	modelEvaluation: {
		model: string;
		thinkingLevel: string;
		promptSha256: string;
		resultSha256: string;
	};
	evidence: {
		abstractAsFulltextViolations: number;
		invalidationPropagationRate: number;
		adjudications: Array<{
			topicSlug: string;
			caseId: string;
			topicRef: string;
			caseRef: string;
			scores: Record<string, number>;
			verdict: "pass";
		}>;
	};
	reviews: Array<{
		topicSlug: string;
		fixturePath: string;
		scores: Record<string, number>;
		total: number;
		p0Violations: string[];
	}>;
}

interface ModelBaseline {
	model: string;
	thinkingLevel: string;
	input: { promptSha256: string };
	resultSha256: string;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = join(packageRoot, "test/fixtures/projects/scenario-a/topics.json");
const rubricPath = join(packageRoot, "evals/rubrics/v0.1.json");
const baselinePath = join(packageRoot, "evals/v0.1/baselines/scenario-a-quality.json");
const modelBaselinePath = join(packageRoot, "evals/v0.1/baselines/deepseek-v4-flash-routing.json");
const modelPromptPath = join(packageRoot, "evals/v0.1/model-routing-prompt.md");

function json<Value>(path: string): Value {
	return JSON.parse(readFileSync(path, "utf8")) as Value;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

check(process.argv[2] === "v0.1", "Usage: npm run eval -- v0.1");
const fixture = json<Fixture>(fixturePath);
const rubric = json<Rubric>(rubricPath);
const baseline = json<Baseline>(baselinePath);
const modelBaseline = json<ModelBaseline>(modelBaselinePath);

check(
	fixture.topics.length === 3 && fixture.evidenceCases.length === 10,
	"Quality fixture must remain 3 topics by 10 cards",
);
check(rubric.evidenceCard.thresholds.allCriteriaAtMax, "Evidence gold must require every criterion at maximum");
check(rubric.literatureReview.thresholds.fabricatedEvidenceP0, "Fabricated evidence must remain a P0");
check(baseline.status === "passed", "Frozen quality baseline is not marked passed");
check(sha256(fixturePath) === baseline.input.fixtureSha256, "Scenario fixture hash changed");
check(sha256(rubricPath) === baseline.input.rubricSha256, "Evaluation rubric hash changed");
check(sha256(modelBaselinePath) === baseline.input.modelBaselineSha256, "Model baseline hash changed");
check(modelBaseline.model === baseline.modelEvaluation.model, "Model version does not match the routing baseline");
check(modelBaseline.thinkingLevel === baseline.modelEvaluation.thinkingLevel, "Thinking level changed");
check(modelBaseline.input.promptSha256 === baseline.modelEvaluation.promptSha256, "Prompt hash changed");
check(modelBaseline.resultSha256 === baseline.modelEvaluation.resultSha256, "Model result hash changed");
check(
	sha256(modelPromptPath) === baseline.modelEvaluation.promptSha256,
	"Current model prompt does not match the baseline",
);

const expectedPairs = new Set(
	fixture.topics.flatMap(({ slug }) => fixture.evidenceCases.map(({ caseId }) => `${slug}/${caseId}`)),
);
check(expectedPairs.size === rubric.evidenceCard.sampleSize, "Fixture does not define the required evidence sample");
check(
	baseline.evidence.adjudications.length === rubric.evidenceCard.sampleSize,
	"Evidence adjudication count does not match the rubric",
);
const seenPairs = new Set<string>();
for (const adjudication of baseline.evidence.adjudications) {
	const pair = `${adjudication.topicSlug}/${adjudication.caseId}`;
	check(expectedPairs.has(pair), `Unknown evidence adjudication: ${pair}`);
	check(!seenPairs.has(pair), `Duplicate evidence adjudication: ${pair}`);
	seenPairs.add(pair);
	check(
		adjudication.topicRef === `test/fixtures/projects/scenario-a/topics.json#topics/${adjudication.topicSlug}`,
		`Topic fixture reference is not stable: ${pair}`,
	);
	check(
		adjudication.caseRef === `test/fixtures/projects/scenario-a/topics.json#evidenceCases/${adjudication.caseId}`,
		`Evidence fixture reference is not stable: ${pair}`,
	);
	check(adjudication.verdict === "pass", `Evidence adjudication failed: ${pair}`);
	for (const criterion of rubric.evidenceCard.criteria) {
		check(adjudication.scores[criterion.id] === criterion.maxScore, `Evidence criterion failed: ${pair}`);
	}
}
check(seenPairs.size === expectedPairs.size, "Evidence gold does not cover the full 30-card matrix");
for (const evidenceCase of fixture.evidenceCases) {
	if (evidenceCase.evidenceLevel === "fulltext_located") {
		check(evidenceCase.query !== null, `Located evidence lacks a fixture query: ${evidenceCase.caseId}`);
		check(
			evidenceCase.relation === "supports" || evidenceCase.relation === "refutes",
			`Located evidence relation is not directional: ${evidenceCase.caseId}`,
		);
	} else {
		check(evidenceCase.query === null, `Abstract evidence has a false locator query: ${evidenceCase.caseId}`);
	}
}
check(
	baseline.evidence.abstractAsFulltextViolations <= rubric.evidenceCard.thresholds.abstractAsFulltextViolationsMax,
	"Abstract evidence was upgraded to full text",
);
check(
	baseline.evidence.invalidationPropagationRate >= rubric.evidenceCard.thresholds.invalidationPropagationRateMin,
	"Evidence invalidation propagation fell below the release threshold",
);

check(baseline.reviews.length === rubric.literatureReview.sampleSize, "Review sample count does not match the rubric");
const requiredReviewMarkers = [
	"ABSTRACT_ONLY",
	"PAYWALL_BLOCKED",
	"MULTIPLE_VERSIONS",
	"METADATA_CONFLICT",
	"OCR_REQUIRED",
	"PARSE_FAILED",
	"PUBLICATION_WARNING",
	"MIXED",
	"INSUFFICIENT_EVIDENCE",
	"INTERRUPTION_RECOVERY",
];
const reviewTotals: Record<string, number> = {};
for (const review of baseline.reviews) {
	const topic = fixture.topics.find(({ slug }) => slug === review.topicSlug);
	check(topic !== undefined, `Review refers to an unknown topic: ${review.topicSlug}`);
	const expectedPath = `evals/v0.1/reviews/${review.topicSlug}.md`;
	check(review.fixturePath === expectedPath, `Review fixture path is not stable: ${review.topicSlug}`);
	const reviewPath = join(packageRoot, expectedPath);
	check(
		sha256(reviewPath) === baseline.input.reviewSha256[review.topicSlug],
		`Review hash changed: ${review.topicSlug}`,
	);
	const content = readFileSync(reviewPath, "utf8");
	check(content.includes(topic.title), `Review does not identify its topic: ${review.topicSlug}`);
	for (const marker of requiredReviewMarkers) {
		check(content.includes(marker), `Review is missing ${marker}: ${review.topicSlug}`);
	}
	let total = 0;
	for (const item of rubric.literatureReview.items) {
		const score = review.scores[String(item.id)];
		check(
			Number.isInteger(score) && score >= 0 && score <= item.maxScore,
			`Invalid review score: ${review.topicSlug}`,
		);
		total += score;
	}
	check(total === review.total, `Review total is inconsistent: ${review.topicSlug}`);
	check(total >= rubric.literatureReview.thresholds.minimumTotal, `Review is below threshold: ${review.topicSlug}`);
	for (const hardItemId of rubric.literatureReview.thresholds.hardItemIds) {
		check(
			review.scores[String(hardItemId)] >= rubric.literatureReview.thresholds.hardItemMinimum,
			`Review failed hard item ${hardItemId}: ${review.topicSlug}`,
		);
	}
	check(review.p0Violations.length === 0, `Review has a P0 evidence violation: ${review.topicSlug}`);
	reviewTotals[review.topicSlug] = total;
}

process.stdout.write(
	`${JSON.stringify(
		{
			evalId: "scenario-a-quality-v0.1",
			status: "passed",
			evidenceCards: seenPairs.size,
			reviews: baseline.reviews.length,
			reviewTotals,
			model: baseline.modelEvaluation.model,
			promptSha256: baseline.modelEvaluation.promptSha256,
		},
		null,
		2,
	)}\n`,
);
