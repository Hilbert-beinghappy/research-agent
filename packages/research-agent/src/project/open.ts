// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalizeJson } from "../contracts/canonical-json.ts";
import { type JsonValue, RESEARCH_SCHEMA_VERSION, type ResearchProjectManifest } from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { resolveProjectPath, validatePortablePathSet } from "../kernel/paths.ts";
import { PROJECT_MANIFEST_PATH } from "./layout.ts";

interface ProjectLocation {
	root: string;
	manifestPath: string;
}

export type OpenedProject =
	| (ProjectLocation & {
			mode: "read-write";
			compatibility: "current";
			manifest: ResearchProjectManifest;
	  })
	| (ProjectLocation & {
			mode: "read-only";
			compatibility: "migration_required" | "newer_schema";
			schemaVersion: string;
			manifest: JsonValue;
	  });

export function assertExpectedRevision(actual: number, expected?: number): void {
	if (expected !== undefined && actual !== expected) {
		throw new Error(`DATA_CONFLICT: expected manifest revision ${expected}, found ${actual}`);
	}
}

function compareSchemaVersions(left: string, right: string): number {
	const leftMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(left);
	const rightMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(right);
	if (leftMatch === null || rightMatch === null) throw new TypeError(`Invalid schema version: ${left}`);
	for (let index = 1; index <= 3; index += 1) {
		const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
		if (difference !== 0) return difference;
	}
	return 0;
}

export async function openProject(projectRoot: string, expectedRevision?: number): Promise<OpenedProject> {
	const manifestPath = await resolveProjectPath(projectRoot, PROJECT_MANIFEST_PATH);
	const root = dirname(manifestPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		throw new TypeError(`Cannot parse ${PROJECT_MANIFEST_PATH}`, { cause: error });
	}
	const raw = canonicalizeJson(parsed);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new TypeError(`${PROJECT_MANIFEST_PATH} must contain a JSON object`);
	}
	if (raw.kind !== "research_project_manifest" || typeof raw.schemaVersion !== "string") {
		throw new TypeError(`${PROJECT_MANIFEST_PATH} is not a research project manifest`);
	}
	if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 0) {
		throw new TypeError(`${PROJECT_MANIFEST_PATH} has an invalid revision`);
	}
	assertExpectedRevision(raw.revision, expectedRevision);

	const schemaComparison = compareSchemaVersions(raw.schemaVersion, RESEARCH_SCHEMA_VERSION);
	if (schemaComparison !== 0) {
		return {
			root,
			manifestPath,
			mode: "read-only",
			compatibility: schemaComparison < 0 ? "migration_required" : "newer_schema",
			schemaVersion: raw.schemaVersion,
			manifest: raw,
		};
	}

	const validation = validatePersistedRecord(raw);
	if (!validation.ok || validation.value.kind !== "research_project_manifest") {
		const details = validation.ok
			? "unexpected record kind"
			: validation.issues.map(({ code, path }) => `${path}:${code}`).join(", ");
		throw new TypeError(`Invalid ${PROJECT_MANIFEST_PATH}: ${details}`);
	}
	const manifest = validation.value;
	const projectPaths = [...Object.values(manifest.directories), ...manifest.recordSets.map(({ path }) => path)];
	const uniquePaths = validatePortablePathSet([...new Set(projectPaths)]);
	await Promise.all(uniquePaths.map((path) => resolveProjectPath(root, path)));

	return { root, manifestPath, mode: "read-write", compatibility: "current", manifest };
}
