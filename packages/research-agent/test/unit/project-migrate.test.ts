// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESEARCH_LEGACY_SCHEMA_VERSION, RESEARCH_SCHEMA_VERSION } from "../../src/contracts/schemas.ts";
import { initializeProject } from "../../src/project/init.ts";
import { PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import {
	commitPreparedProjectMigration,
	listPendingProjectMigrations,
	migrateProject,
	prepareProjectMigration,
	rollbackProjectMigration,
} from "../../src/project/migrate.ts";
import { openProject } from "../../src/project/open.ts";

const v0_5Kinds = new Set(["adapter_export_profile", "external_item_link", "monitor_subscription", "monitor_run"]);

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-migrate-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Migration fixture" });
	const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		schemaVersion: string;
		recordSets: { kind: string }[];
	};
	manifest.schemaVersion = RESEARCH_LEGACY_SCHEMA_VERSION;
	manifest.recordSets = manifest.recordSets.filter(({ kind }) => !v0_5Kinds.has(kind));
	await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("v0.4 to v0.5 project migration", () => {
	it("prepares without mutation, resumes the pending commit, and rolls back an unchanged project", async () => {
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		const before = await readFile(manifestPath, "utf8");
		const migrationId = await prepareProjectMigration(projectRoot);

		expect(await readFile(manifestPath, "utf8")).toBe(before);
		expect(await listPendingProjectMigrations(projectRoot)).toEqual([migrationId]);

		const result = await migrateProject(projectRoot);
		expect(result).toMatchObject({
			migrationId,
			fromVersion: RESEARCH_LEGACY_SCHEMA_VERSION,
			toVersion: RESEARCH_SCHEMA_VERSION,
			recovered: true,
		});
		const migrated = await openProject(projectRoot);
		expect(migrated).toMatchObject({ mode: "read-write", compatibility: "current" });
		if (migrated.compatibility !== "current") throw new Error("Expected current project");
		expect(migrated.manifest.recordSets.filter(({ kind }) => v0_5Kinds.has(kind)).map(({ kind }) => kind)).toEqual([
			...v0_5Kinds,
		]);
		expect(await commitPreparedProjectMigration(projectRoot, migrationId)).toMatchObject({
			compatibility: "current",
		});

		const rolledBack = await rollbackProjectMigration(projectRoot, migrationId);
		expect(rolledBack).toMatchObject({
			mode: "read-only",
			compatibility: "migration_required",
			schemaVersion: RESEARCH_LEGACY_SCHEMA_VERSION,
		});
	});

	it("blocks rollback after the migrated manifest changes", async () => {
		const migrationId = await prepareProjectMigration(projectRoot);
		const migrated = await commitPreparedProjectMigration(projectRoot, migrationId);
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		await writeFile(manifestPath, `${JSON.stringify({ ...migrated.manifest, title: "Changed after migration" })}\n`);

		await expect(rollbackProjectMigration(projectRoot, migrationId)).rejects.toThrow("rollback would be lossy");
	});

	it("finishes a rollback after the v0.4 manifest was already restored", async () => {
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
			schemaVersion: RESEARCH_LEGACY_SCHEMA_VERSION,
		});
	});
});
