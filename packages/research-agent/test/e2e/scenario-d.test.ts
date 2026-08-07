// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import {
	RESEARCH_MIGRATABLE_SCHEMA_VERSIONS,
	RESEARCH_SCHEMA_VERSION,
	type RecordKind,
	type SourceRecord,
} from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson, hashFile } from "../../src/kernel/integrity.ts";
import { listProjectBackups, readProjectBackup, restoreProjectBackup } from "../../src/project/backup.ts";
import { doctorProject } from "../../src/project/doctor.ts";
import { initializeProject } from "../../src/project/init.ts";
import { PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import {
	listPendingProjectMigrations,
	listStagedProjectMigrations,
	migrateProject,
	prepareProjectMigration,
} from "../../src/project/migrate.ts";
import { openProject } from "../../src/project/open.ts";
import { calculateRecordSetIndex, projectRecordPath } from "../../src/project/record-index.ts";
import { createRecord, readRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";
import { startOperation } from "../../src/tools/operations.ts";

const timestamp = "2026-08-06T00:00:00.000Z";
type LegacySchemaVersion = (typeof RESEARCH_MIGRATABLE_SCHEMA_VERSIONS)[number];
const introduced: Partial<Record<RecordKind, string>> = {
	research_question_version: "0.2.0",
	concept: "0.2.0",
	theory_relation: "0.2.0",
	design_decision: "0.2.0",
	protocol: "0.2.0",
	dataset: "0.3.0",
	variable: "0.3.0",
	analysis_specification: "0.3.0",
	qualitative_material: "0.3.0",
	qualitative_segment: "0.3.0",
	codebook_version: "0.3.0",
	model_suggestion: "0.3.0",
	coding_decision: "0.3.0",
	theme_synthesis: "0.3.0",
	analysis_run: "0.3.0",
	manuscript: "0.4.0",
	section: "0.4.0",
	claim_occurrence: "0.4.0",
	review_finding: "0.4.0",
	revision_decision: "0.4.0",
	disclosure: "0.4.0",
	submission_gate_report: "0.4.0",
	adapter_export_profile: "0.5.0",
	external_item_link: "0.5.0",
	monitor_subscription: "0.5.0",
	monitor_run: "0.5.0",
};
const interruptions = ["staged_write", "record_replace_boundary", "manifest_commit"] as const;
const cases = RESEARCH_MIGRATABLE_SCHEMA_VERSIONS.flatMap((schemaVersion) =>
	interruptions.map((interruption) => ({ schemaVersion, interruption })),
);

let temporaryDirectory: string | null = null;

afterEach(async () => {
	if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = null;
});

function atLeast(left: string, right: string): boolean {
	return left.localeCompare(right, undefined, { numeric: true }) >= 0;
}

async function fixture(schemaVersion: LegacySchemaVersion): Promise<{
	projectRoot: string;
	operationId: string;
	sourceId: string;
}> {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-scenario-d-"));
	const projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: `Public administration migration fixture ${schemaVersion}` });
	const operation = await startOperation(projectRoot, {
		operationKind: "tool",
		name: "scenario-d.public-fixture",
		implementationVersion: schemaVersion,
		session: {
			piSessionId: "scenario-d-session-01",
			piSessionFileHash: null,
			linkedAt: timestamp,
			firstEntryId: null,
			lastEntryId: null,
		},
	});
	if (!operation.ok) throw new Error(operation.errors[0].message);
	const sourceId = createOpaqueId("source");
	const source: SourceRecord = {
		kind: "source",
		schemaVersion,
		sourceId,
		identifiers: [
			{
				scheme: "doi",
				value: "10.5555/scenario-d",
				normalizedValue: "10.5555/scenario-d",
				verified: false,
				verificationId: null,
			},
		],
		title: "Algorithmic transparency and trust in public administration",
		titleNormalized: "algorithmic transparency and trust in public administration",
		contributors: [{ family: "Chen", given: "Lin", literal: null, orcid: null }],
		issuedDate: "2025",
		containerTitle: "Journal of Synthetic Public Administration",
		publisher: "Public Fixture Press",
		sourceType: "article",
		language: "en",
		abstractText: "A public synthetic record for deterministic migration qualification.",
		abstractRights: "display_allowed",
		discovery: [],
		dedupKeys: {
			doi: "10.5555/scenario-d",
			strongIdentifier: "doi:10.5555/scenario-d",
			normalizedTitleYearFirstAuthor: "algorithmic transparency and trust in public administration|2025|chen",
			contentHash: hashBytes("scenario-d-public-source").value,
		},
		duplicateStatus: "canonical",
		canonicalSourceId: null,
		metadataConflicts: [],
		publicationStatus: "normal",
		audit: {
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 0,
			createdByOperationId: operation.value.operationId,
			updatedByOperationId: operation.value.operationId,
		},
	};
	const current = await openProject(projectRoot);
	if (current.compatibility !== "current") throw new Error("expected current project");
	const created = await createRecord(projectRoot, source, {
		expectedManifestRevision: current.manifest.revision,
		operationId: operation.value.operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);

	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	const operationRecord = await readRecord(projectRoot, "operation", operation.value.operationId);
	if (!operationRecord.ok || operationRecord.value.kind !== "operation") throw new Error("expected operation");
	await writeFile(
		join(projectRoot, projectRecordPath(opened.manifest, "operation", operation.value.operationId)),
		`${canonicalStringify({ ...operationRecord.value, schemaVersion })}\n`,
	);
	const operationIndex = await calculateRecordSetIndex(projectRoot, opened.manifest, "operation");
	const manifest = {
		...opened.manifest,
		schemaVersion,
		recordSets: opened.manifest.recordSets
			.filter(({ kind }) => introduced[kind] === undefined || atLeast(schemaVersion, introduced[kind] as string))
			.map((recordSet) => (recordSet.kind === "operation" ? { ...recordSet, ...operationIndex } : recordSet)),
	};
	await writeFile(join(projectRoot, PROJECT_MANIFEST_PATH), `${canonicalStringify(manifest)}\n`);
	return { projectRoot, operationId: operation.value.operationId, sourceId };
}

async function canonicalStateHash(projectRoot: string, operationId: string, sourceId: string): Promise<string> {
	const opened = await openProject(projectRoot);
	const manifest = opened.manifest;
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
		throw new Error("invalid manifest");
	const operationPath = projectRecordPath(manifest as never, "operation", operationId);
	const sourcePath = projectRecordPath(manifest as never, "source", sourceId);
	return hashCanonicalJson({
		manifest,
		records: {
			operation: await hashFile(join(projectRoot, operationPath)),
			source: await hashFile(join(projectRoot, sourcePath)),
		},
	}).value;
}

async function recordHashes(projectRoot: string, operationId: string, sourceId: string) {
	const opened = await openProject(projectRoot);
	const manifest = opened.manifest;
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
		throw new Error("invalid manifest");
	return {
		operation: (await hashFile(join(projectRoot, projectRecordPath(manifest as never, "operation", operationId))))
			.value,
		source: (await hashFile(join(projectRoot, projectRecordPath(manifest as never, "source", sourceId)))).value,
	};
}

describe("Scenario D: all historical projects recover across v1.0 migration boundaries", () => {
	it.each(cases)(
		"migrates schema $schemaVersion after $interruption without mixed canonical state",
		async ({ schemaVersion, interruption }) => {
			const { projectRoot, operationId, sourceId } = await fixture(schemaVersion);
			const oldStateHash = await canonicalStateHash(projectRoot, operationId, sourceId);
			const oldRecordHashes = await recordHashes(projectRoot, operationId, sourceId);
			let interruptedStateHash: string;

			if (interruption === "staged_write") {
				const staging = join(projectRoot, ".research/migrations/staging", `migration_${randomUUID()}`);
				await mkdir(staging, { recursive: true });
				await writeFile(
					join(staging, "manifest.before.json"),
					await readFile(join(projectRoot, PROJECT_MANIFEST_PATH)),
				);
				interruptedStateHash = await canonicalStateHash(projectRoot, operationId, sourceId);
			} else {
				const migrationId = await prepareProjectMigration(projectRoot);
				const pending = join(projectRoot, ".research/migrations/pending", migrationId);
				if (interruption === "record_replace_boundary") {
					expect((await readdir(pending)).sort()).toEqual([
						"manifest.after.json",
						"manifest.before.json",
						"migration.json",
					]);
				} else {
					await writeFile(
						join(projectRoot, PROJECT_MANIFEST_PATH),
						await readFile(join(pending, "manifest.after.json")),
					);
				}
				interruptedStateHash = await canonicalStateHash(projectRoot, operationId, sourceId);
			}

			const migrated = await migrateProject(projectRoot);
			expect(migrated).toMatchObject({
				fromVersion: schemaVersion,
				toVersion: RESEARCH_SCHEMA_VERSION,
				recovered: true,
			});
			const newStateHash = await canonicalStateHash(projectRoot, operationId, sourceId);
			expect(interruptedStateHash).toBe(interruption === "manifest_commit" ? newStateHash : oldStateHash);
			expect(newStateHash).not.toBe(oldStateHash);
			expect(await recordHashes(projectRoot, operationId, sourceId)).toEqual(oldRecordHashes);
			expect(await validateProject(projectRoot)).toMatchObject({ valid: true });
			expect(await doctorProject(projectRoot)).toMatchObject({ status: "healthy", issues: [] });
			expect(await listPendingProjectMigrations(projectRoot)).toEqual([]);
			expect(await listStagedProjectMigrations(projectRoot)).toEqual([]);

			const backups = await listProjectBackups(projectRoot);
			expect(backups).toHaveLength(1);
			const backupId = backups[0];
			if (backupId === undefined) throw new Error("expected migration backup");
			const backup = await readProjectBackup(projectRoot, backupId);
			expect(backup).toMatchObject({ projectSchemaVersion: schemaVersion, rootHash: { algorithm: "sha256" } });
			if (temporaryDirectory === null) throw new Error("missing temporary directory");
			const restoredRoot = join(temporaryDirectory, "restored");
			await restoreProjectBackup(projectRoot, backupId, restoredRoot);
			expect(await canonicalStateHash(restoredRoot, operationId, sourceId)).toBe(oldStateHash);
			expect(await openProject(restoredRoot)).toMatchObject({
				mode: "read-only",
				compatibility: "migration_required",
				schemaVersion,
			});
		},
		60_000,
	);
});
