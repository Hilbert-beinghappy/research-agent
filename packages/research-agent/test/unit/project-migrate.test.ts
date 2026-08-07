// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	RESEARCH_MIGRATABLE_SCHEMA_VERSIONS,
	RESEARCH_SCHEMA_VERSION,
	type RecordKind,
} from "../../src/contracts/schemas.ts";
import { BUILT_IN_DOMAIN_PACKAGE_VERSION } from "../../src/domain/packages.ts";
import { listProjectBackups, readProjectBackup } from "../../src/project/backup.ts";
import { initializeProject } from "../../src/project/init.ts";
import { INITIAL_RECORD_SETS, PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import {
	commitPreparedProjectMigration,
	listPendingProjectMigrations,
	migrateProject,
	prepareProjectMigration,
	rollbackProjectMigration,
} from "../../src/project/migrate.ts";
import { openProject } from "../../src/project/open.ts";

const introduced: Record<string, string> = {
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
	adapter_registration: "1.5.0",
	exchange_record: "1.5.0",
	collaboration_merge: "1.5.0",
	model_route_decision: "1.5.0",
};

function atLeast(left: string, right: string): boolean {
	return left.localeCompare(right, undefined, { numeric: true }) >= 0;
}

let temporaryDirectory: string;
let projectRoot: string;

async function downgrade(version: string): Promise<void> {
	const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		schemaVersion: string;
		recordSets: { kind: RecordKind }[];
	};
	manifest.schemaVersion = version;
	manifest.recordSets = manifest.recordSets.filter(({ kind }) => {
		const firstVersion = introduced[kind];
		return firstVersion === undefined || atLeast(version, firstVersion);
	});
	await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
}

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-migrate-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Migration fixture" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("supported historical projects to v1.5 migration", () => {
	it.each(RESEARCH_MIGRATABLE_SCHEMA_VERSIONS)(
		"prepares %s without manifest mutation, resumes, and retains a hash-bound backup",
		async (version) => {
			await downgrade(version);
			const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
			const before = await readFile(manifestPath, "utf8");
			const migrationId = await prepareProjectMigration(projectRoot);

			expect(await readFile(manifestPath, "utf8")).toBe(before);
			expect(await listPendingProjectMigrations(projectRoot)).toEqual([migrationId]);
			const backups = await listProjectBackups(projectRoot);
			expect(backups).toHaveLength(1);
			const backupId = backups[0];
			if (backupId === undefined) throw new Error("Migration backup is missing");
			expect(await readProjectBackup(projectRoot, backupId)).toMatchObject({
				projectSchemaVersion: version,
				files: expect.arrayContaining([expect.objectContaining({ path: PROJECT_MANIFEST_PATH })]),
			});

			const result = await migrateProject(projectRoot);
			expect(result).toMatchObject({
				migrationId,
				migrationIds: [migrationId],
				fromVersion: version,
				toVersion: RESEARCH_SCHEMA_VERSION,
				recovered: true,
			});
			const migrated = await openProject(projectRoot);
			expect(migrated).toMatchObject({ mode: "read-write", compatibility: "current" });
			if (migrated.compatibility !== "current") throw new Error("Expected current project");
			expect(migrated.manifest.domain).toMatchObject({
				templatePackage: "pi-research-domain-public-administration",
				templateVersion: BUILT_IN_DOMAIN_PACKAGE_VERSION,
			});
			expect(migrated.manifest.recordSets.map(({ kind }) => kind)).toEqual(
				INITIAL_RECORD_SETS.map(({ kind }) => kind),
			);
			expect(await commitPreparedProjectMigration(projectRoot, migrationId)).toMatchObject({
				compatibility: "current",
			});

			const rolledBack = await rollbackProjectMigration(projectRoot, migrationId);
			expect(rolledBack).toMatchObject({
				mode: "read-only",
				compatibility: "migration_required",
				schemaVersion: version,
			});
		},
	);

	it("finishes commit after the v1 manifest was already installed", async () => {
		await downgrade("0.5.0");
		const migrationId = await prepareProjectMigration(projectRoot);
		const after = await readFile(
			join(projectRoot, ".research/migrations/pending", migrationId, "manifest.after.json"),
			"utf8",
		);
		await writeFile(join(projectRoot, PROJECT_MANIFEST_PATH), after);

		await expect(migrateProject(projectRoot)).resolves.toMatchObject({
			migrationIds: [migrationId],
			recovered: true,
		});
	});

	it("preserves a custom package reference without inventing a missing version", async () => {
		await downgrade("1.0.0");
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			domain: { templatePackage: string | null; templateVersion: string | null };
		};
		manifest.domain.templatePackage = "research-domain-local";
		manifest.domain.templateVersion = null;
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

		await migrateProject(projectRoot);
		await expect(openProject(projectRoot)).resolves.toMatchObject({
			manifest: { domain: { templatePackage: "research-domain-local", templateVersion: null } },
		});
	});

	it("discards an incomplete staged snapshot before retrying from the unchanged project", async () => {
		await downgrade("0.1.0");
		const staged = join(projectRoot, ".research/migrations/staging/migration_00000000-0000-4000-8000-000000000000");
		await mkdir(staged, { recursive: true });
		await writeFile(join(staged, "manifest.before.json"), "incomplete");

		await expect(migrateProject(projectRoot)).resolves.toMatchObject({
			fromVersion: "0.1.0",
			toVersion: RESEARCH_SCHEMA_VERSION,
			recovered: true,
		});
		await expect(openProject(projectRoot)).resolves.toMatchObject({ compatibility: "current" });
	});

	it("refuses a second migration writer while the project lock exists", async () => {
		await downgrade("0.5.0");
		await writeFile(join(projectRoot, ".research/locks/migration.lock"), "active");
		await expect(migrateProject(projectRoot)).rejects.toThrow("MIGRATION_LOCKED");
		await expect(openProject(projectRoot)).resolves.toMatchObject({
			compatibility: "migration_required",
			schemaVersion: "0.5.0",
		});
	});

	it("blocks rollback after the migrated manifest changes", async () => {
		await downgrade("0.5.0");
		const migrationId = await prepareProjectMigration(projectRoot);
		const migrated = await commitPreparedProjectMigration(projectRoot, migrationId);
		if (migrated.compatibility !== "current") throw new Error("Expected current project");
		await writeFile(
			join(projectRoot, PROJECT_MANIFEST_PATH),
			`${JSON.stringify({ ...migrated.manifest, title: "Changed after migration" })}\n`,
		);

		await expect(rollbackProjectMigration(projectRoot, migrationId)).rejects.toThrow("rollback would be lossy");
	});

	it("finishes rollback after the legacy manifest was already restored", async () => {
		await downgrade("0.5.0");
		const migrationId = await prepareProjectMigration(projectRoot);
		await commitPreparedProjectMigration(projectRoot, migrationId);
		const before = await readFile(
			join(projectRoot, ".research/migrations/committed", migrationId, "manifest.before.json"),
			"utf8",
		);
		await writeFile(join(projectRoot, PROJECT_MANIFEST_PATH), before);

		const rolledBack = await rollbackProjectMigration(projectRoot, migrationId);
		expect(rolledBack).toMatchObject({
			mode: "read-only",
			compatibility: "migration_required",
			schemaVersion: "0.5.0",
		});
	});
});
