// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESEARCH_SCHEMA_VERSION, RESEARCH_V0_5_SCHEMA_VERSION } from "../../src/contracts/schemas.ts";
import { doctorProject } from "../../src/project/doctor.ts";
import { initializeProject } from "../../src/project/init.ts";
import { PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import { openProject } from "../../src/project/open.ts";
import { createExportProfile } from "../../src/tools/knowledge.ts";
import { startOperation } from "../../src/tools/operations.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-doctor-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Doctor fixture" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("project doctor", () => {
	it("reports a healthy current project without proposing repair", async () => {
		await expect(doctorProject(projectRoot)).resolves.toMatchObject({
			format: "pi-research-project-doctor",
			version: 1,
			status: "healthy",
			issues: [],
			repairPlan: [],
		});
	});

	it("distinguishes migratable schema and incomplete migration staging", async () => {
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { schemaVersion: string };
		manifest.schemaVersion = RESEARCH_V0_5_SCHEMA_VERSION;
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await expect(doctorProject(projectRoot)).resolves.toMatchObject({
			status: "attention",
			issues: [{ code: "SCHEMA_MIGRATION_REQUIRED", category: "schema" }],
		});

		manifest.schemaVersion = RESEARCH_SCHEMA_VERSION;
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
		await mkdir(join(projectRoot, ".research", "migrations", "staging", "migration_incomplete"), {
			recursive: true,
		});
		await writeFile(join(projectRoot, ".research", "locks", "migration.lock"), "active");
		await expect(doctorProject(projectRoot)).resolves.toMatchObject({
			status: "attention",
			issues: expect.arrayContaining([
				expect.objectContaining({ code: "MIGRATION_STAGING_INCOMPLETE", category: "pending_migration" }),
				expect.objectContaining({ code: "MIGRATION_LOCK_PRESENT", category: "pending_migration" }),
			]),
		});
	});

	it("reports an enabled unavailable adapter separately", async () => {
		const operation = await startOperation(projectRoot, {
			operationKind: "tool",
			name: "doctor.fixture",
			implementationVersion: "1.0.0",
			session: null,
		});
		if (!operation.ok) throw new Error(operation.errors[0].message);
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		const created = await createExportProfile(projectRoot, {
			name: "Unavailable export",
			adapterId: "missing-adapter",
			adapterVersion: "1.0.0",
			format: "ris",
			destination: { kind: "project_file", path: "artifacts/exports/library.ris" },
			credentialAlias: null,
			enabled: true,
			expectedManifestRevision: opened.manifest.revision,
			operationId: operation.value.operationId,
		});
		expect(created).toMatchObject({ ok: true });

		await expect(doctorProject(projectRoot)).resolves.toMatchObject({
			status: "attention",
			issues: expect.arrayContaining([
				expect.objectContaining({ code: "ADAPTER_ABSENT", category: "adapter_absence" }),
			]),
		});
	});

	it("reports an unavailable domain package without blocking generic guidance", async () => {
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			domain: { templateVersion: string | null };
		};
		manifest.domain.templateVersion = "9.9.9";
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

		await expect(doctorProject(projectRoot)).resolves.toMatchObject({
			status: "attention",
			issues: [
				expect.objectContaining({
					code: "DOMAIN_PACKAGE_ABSENT",
					category: "domain_package_absence",
					severity: "attention",
				}),
			],
		});
	});

	it("reports an incomplete domain package reference", async () => {
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			domain: { templateVersion: string | null };
		};
		manifest.domain.templateVersion = null;
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

		await expect(doctorProject(projectRoot)).resolves.toMatchObject({
			status: "attention",
			issues: [expect.objectContaining({ code: "DOMAIN_PACKAGE_REFERENCE_INCOMPLETE" })],
		});
	});
});
