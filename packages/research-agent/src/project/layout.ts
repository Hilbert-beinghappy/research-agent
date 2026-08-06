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
	["task", PROJECT_DIRECTORIES.tasks],
	["operation", ".research/records/operations"],
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
		"sources/imports",
		"notes",
		"artifacts/reviews",
		"artifacts/matrices",
		"artifacts/exports",
		"artifacts/drafts",
		"artifacts/final",
	]),
] as const;
