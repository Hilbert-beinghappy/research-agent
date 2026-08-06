// SPDX-License-Identifier: Apache-2.0

import type { ProjectDirectories, ProjectRecordSet, RecordKind } from "../contracts/schemas.ts";

export const PROJECT_MANIFEST_PATH = "research-project.json";

export const PROJECT_DIRECTORIES = {
	sources: ".research/records/sources",
	documents: ".research/records/documents",
	parsed: "sources/parsed",
	evidence: ".research/records/evidence",
	claims: ".research/records/claims",
	verifications: ".research/records/citations",
	tasks: ".research/records/tasks",
	runs: ".research/runs",
	artifacts: ".research/records/artifacts",
	approvals: ".research/records/approvals",
	migrations: ".research/migrations",
	transactions: ".research/transactions",
} as const satisfies ProjectDirectories;

const RECORD_SET_PATHS: readonly [RecordKind, string][] = [
	["source", PROJECT_DIRECTORIES.sources],
	["document", PROJECT_DIRECTORIES.documents],
	["evidence", PROJECT_DIRECTORIES.evidence],
	["claim", PROJECT_DIRECTORIES.claims],
	["citation_verification", PROJECT_DIRECTORIES.verifications],
	["research_question_version", ".research/records/design/questions"],
	["concept", ".research/records/design/concepts"],
	["theory_relation", ".research/records/design/theory-relations"],
	["design_decision", ".research/records/design/decisions"],
	["protocol", ".research/records/design/protocols"],
	["dataset", ".research/records/data/datasets"],
	["variable", ".research/records/data/variables"],
	["analysis_specification", ".research/records/data/specifications"],
	["qualitative_material", ".research/records/qualitative/materials"],
	["qualitative_segment", ".research/records/qualitative/segments"],
	["codebook_version", ".research/records/qualitative/codebooks"],
	["model_suggestion", ".research/records/qualitative/suggestions"],
	["coding_decision", ".research/records/qualitative/decisions"],
	["theme_synthesis", ".research/records/qualitative/themes"],
	["manuscript", ".research/records/writing/manuscripts"],
	["section", ".research/records/writing/sections"],
	["claim_occurrence", ".research/records/writing/claim-occurrences"],
	["review_finding", ".research/records/writing/review-findings"],
	["revision_decision", ".research/records/writing/revision-decisions"],
	["disclosure", ".research/records/writing/disclosures"],
	["submission_gate_report", ".research/records/writing/submission-gates"],
	["task", PROJECT_DIRECTORIES.tasks],
	["operation", ".research/records/operations"],
	["analysis_run", ".research/records/analysis-runs"],
	["artifact", PROJECT_DIRECTORIES.artifacts],
	["approval", PROJECT_DIRECTORIES.approvals],
];

export const INITIAL_RECORD_SETS: ProjectRecordSet[] = RECORD_SET_PATHS.map(([kind, path]) => ({
	kind,
	storage: "json",
	path,
	count: 0,
	contentHash: null,
}));

export const PROJECT_LAYOUT_DIRECTORIES = [
	...new Set([
		...Object.values(PROJECT_DIRECTORIES),
		...INITIAL_RECORD_SETS.map(({ path }) => path),
		".research/transactions/pending",
		".research/transactions/committed",
		".research/transactions/failed",
		".research/backups",
		".research/locks",
		".research/cache",
		"sources/originals",
		"sources/originals/datasets",
		"sources/originals/materials",
		"sources/imports",
		"sources/imports/analysis",
		"notes",
		"artifacts/reviews",
		"artifacts/matrices",
		"artifacts/manuscripts",
		"artifacts/exports",
		"artifacts/drafts",
		"artifacts/designs",
		"artifacts/final",
	]),
] as const;
