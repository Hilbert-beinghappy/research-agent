// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type JsonValue,
	RESEARCH_LEGACY_SCHEMA_VERSION,
	RESEARCH_SCHEMA_VERSION,
	type ResearchProjectManifest,
} from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { hashBytes, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { INITIAL_RECORD_SETS, PROJECT_LAYOUT_DIRECTORIES, PROJECT_MANIFEST_PATH } from "./layout.ts";
import { type OpenedProject, openProject } from "./open.ts";

const MIGRATION_ROOT = ".research/migrations";
const PENDING_MIGRATIONS = `${MIGRATION_ROOT}/pending`;
const COMMITTED_MIGRATIONS = `${MIGRATION_ROOT}/committed`;
const ROLLED_BACK_MIGRATIONS = `${MIGRATION_ROOT}/rolled-back`;
const STAGING_MIGRATIONS = `${MIGRATION_ROOT}/staging`;

interface MigrationJournal {
	version: 1;
	migrationId: string;
	fromVersion: typeof RESEARCH_LEGACY_SCHEMA_VERSION;
	toVersion: typeof RESEARCH_SCHEMA_VERSION;
	fromRevision: number;
	toRevision: number;
	oldManifestHash: string;
	newManifestHash: string;
	createdAt: string;
}

export interface ProjectMigrationResult {
	migrationId: string | null;
	fromVersion: string;
	toVersion: typeof RESEARCH_SCHEMA_VERSION;
	revision: number;
	recovered: boolean;
}

function migrationDirectory(parent: string, migrationId: string): string {
	if (!/^migration_[0-9a-f-]{36}$/.test(migrationId)) throw new TypeError(`Invalid migration ID: ${migrationId}`);
	return `${parent}/${migrationId}`;
}

async function readDirectoryNames(projectRoot: string, directory: string): Promise<string[]> {
	try {
		return (await readdir(await resolveProjectPath(projectRoot, directory), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map(({ name }) => name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function buildV0_5Manifest(raw: JsonValue): ResearchProjectManifest {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new TypeError("Legacy project manifest must be an object");
	}
	if (
		raw.kind !== "research_project_manifest" ||
		raw.schemaVersion !== RESEARCH_LEGACY_SCHEMA_VERSION ||
		typeof raw.revision !== "number" ||
		!Number.isInteger(raw.revision) ||
		!Array.isArray(raw.recordSets)
	) {
		throw new TypeError("Project is not a valid v0.4 migration source");
	}
	const existing = new Map<string, JsonValue>();
	for (const value of raw.recordSets) {
		if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string") {
			throw new TypeError("Legacy project record sets are invalid");
		}
		if (existing.has(value.kind)) throw new TypeError(`Legacy project has duplicate ${value.kind} record sets`);
		existing.set(value.kind, value);
	}
	const recordSets = INITIAL_RECORD_SETS.map((recordSet) => existing.get(recordSet.kind) ?? recordSet);
	const candidate = {
		...raw,
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		recordSets,
		updatedAt: new Date().toISOString(),
		revision: raw.revision + 1,
	};
	const validation = validatePersistedRecord(candidate);
	if (!validation.ok || validation.value.kind !== "research_project_manifest") {
		const details = validation.ok
			? "unexpected record kind"
			: validation.issues.map(({ code, path }) => `${path}:${code}`).join(", ");
		throw new TypeError(`Migrated project manifest is invalid: ${details}`);
	}
	return validation.value;
}

async function readJournal(projectRoot: string, parent: string, migrationId: string): Promise<MigrationJournal> {
	const directory = migrationDirectory(parent, migrationId);
	const raw = canonicalizeJson(
		JSON.parse(await readFile(await resolveProjectPath(projectRoot, `${directory}/migration.json`), "utf8")),
	);
	if (
		raw === null ||
		typeof raw !== "object" ||
		Array.isArray(raw) ||
		raw.version !== 1 ||
		raw.migrationId !== migrationId ||
		raw.fromVersion !== RESEARCH_LEGACY_SCHEMA_VERSION ||
		raw.toVersion !== RESEARCH_SCHEMA_VERSION ||
		typeof raw.fromRevision !== "number" ||
		typeof raw.toRevision !== "number" ||
		typeof raw.oldManifestHash !== "string" ||
		typeof raw.newManifestHash !== "string" ||
		typeof raw.createdAt !== "string"
	) {
		throw new TypeError(`Invalid migration journal: ${migrationId}`);
	}
	return raw as unknown as MigrationJournal;
}

async function locateMigration(projectRoot: string, migrationId: string): Promise<string | null> {
	for (const parent of [PENDING_MIGRATIONS, COMMITTED_MIGRATIONS, ROLLED_BACK_MIGRATIONS]) {
		if ((await readDirectoryNames(projectRoot, parent)).includes(migrationId)) return parent;
	}
	return null;
}

export async function listPendingProjectMigrations(projectRoot: string): Promise<string[]> {
	return readDirectoryNames(projectRoot, PENDING_MIGRATIONS);
}

export async function prepareProjectMigration(projectRoot: string): Promise<string> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "migration_required" || opened.schemaVersion !== RESEARCH_LEGACY_SCHEMA_VERSION) {
		throw new TypeError(
			`Only v${RESEARCH_LEGACY_SCHEMA_VERSION} projects can migrate to v${RESEARCH_SCHEMA_VERSION}`,
		);
	}
	const oldManifest = await readFile(opened.manifestPath, "utf8");
	const raw = canonicalizeJson(JSON.parse(oldManifest));
	const targetManifest = buildV0_5Manifest(raw);
	const target = `${canonicalStringify(targetManifest)}\n`;
	const migrationId = `migration_${randomUUID()}`;
	await Promise.all(
		[PENDING_MIGRATIONS, COMMITTED_MIGRATIONS, ROLLED_BACK_MIGRATIONS, STAGING_MIGRATIONS].map(async (directory) =>
			mkdir(await resolveProjectPath(projectRoot, directory), { recursive: true }),
		),
	);
	const staging = migrationDirectory(STAGING_MIGRATIONS, migrationId);
	await mkdir(await resolveProjectPath(projectRoot, staging));
	const journal: MigrationJournal = {
		version: 1,
		migrationId,
		fromVersion: RESEARCH_LEGACY_SCHEMA_VERSION,
		toVersion: RESEARCH_SCHEMA_VERSION,
		fromRevision: targetManifest.revision - 1,
		toRevision: targetManifest.revision,
		oldManifestHash: hashBytes(oldManifest).value,
		newManifestHash: hashBytes(target).value,
		createdAt: new Date().toISOString(),
	};
	await atomicWriteFile(await resolveProjectPath(projectRoot, `${staging}/manifest.before.json`), oldManifest);
	await atomicWriteFile(await resolveProjectPath(projectRoot, `${staging}/manifest.after.json`), target);
	await atomicWriteFile(
		await resolveProjectPath(projectRoot, `${staging}/migration.json`),
		`${canonicalStringify(journal)}\n`,
	);
	await rename(
		await resolveProjectPath(projectRoot, staging),
		await resolveProjectPath(projectRoot, migrationDirectory(PENDING_MIGRATIONS, migrationId)),
	);
	return migrationId;
}

export async function commitPreparedProjectMigration(
	projectRoot: string,
	migrationId: string,
): Promise<Extract<OpenedProject, { compatibility: "current" }>> {
	const parent = await locateMigration(projectRoot, migrationId);
	if (parent === COMMITTED_MIGRATIONS) {
		const current = await openProject(projectRoot);
		if (current.compatibility !== "current")
			throw new TypeError("Committed migration did not produce a current project");
		return current;
	}
	if (parent !== PENDING_MIGRATIONS) throw new TypeError(`Pending migration not found: ${migrationId}`);
	const journal = await readJournal(projectRoot, parent, migrationId);
	const directory = migrationDirectory(parent, migrationId);
	const beforePath = await resolveProjectPath(projectRoot, `${directory}/manifest.before.json`);
	const afterPath = await resolveProjectPath(projectRoot, `${directory}/manifest.after.json`);
	const after = await readFile(afterPath, "utf8");
	if (
		(await hashFile(beforePath)).value !== journal.oldManifestHash ||
		(await hashFile(afterPath)).value !== journal.newManifestHash
	) {
		throw new Error(`Migration snapshot hash mismatch: ${migrationId}`);
	}
	const validation = validatePersistedRecord(canonicalizeJson(JSON.parse(after)));
	if (!validation.ok || validation.value.kind !== "research_project_manifest") {
		throw new TypeError(`Migration target manifest is invalid: ${migrationId}`);
	}
	const manifestPath = await resolveProjectPath(projectRoot, PROJECT_MANIFEST_PATH);
	const currentHash = (await hashFile(manifestPath)).value;
	if (currentHash !== journal.oldManifestHash && currentHash !== journal.newManifestHash) {
		throw new Error(`DATA_CONFLICT: project changed after migration preparation: ${migrationId}`);
	}
	for (const directoryPath of PROJECT_LAYOUT_DIRECTORIES) {
		await mkdir(await resolveProjectPath(projectRoot, directoryPath), { recursive: true });
	}
	if (currentHash === journal.oldManifestHash) await atomicWriteFile(manifestPath, after);
	const migrated = await openProject(projectRoot, journal.toRevision);
	if (migrated.compatibility !== "current") throw new TypeError("Migration did not produce a current project");
	await rename(
		await resolveProjectPath(projectRoot, directory),
		await resolveProjectPath(projectRoot, migrationDirectory(COMMITTED_MIGRATIONS, migrationId)),
	);
	return migrated;
}

export async function rollbackProjectMigration(projectRoot: string, migrationId: string): Promise<OpenedProject> {
	const parent = await locateMigration(projectRoot, migrationId);
	if (parent !== COMMITTED_MIGRATIONS) throw new TypeError(`Committed migration not found: ${migrationId}`);
	const journal = await readJournal(projectRoot, parent, migrationId);
	const directory = migrationDirectory(parent, migrationId);
	const beforePath = await resolveProjectPath(projectRoot, `${directory}/manifest.before.json`);
	if ((await hashFile(beforePath)).value !== journal.oldManifestHash) {
		throw new Error(`Migration backup hash mismatch: ${migrationId}`);
	}
	const manifestPath = await resolveProjectPath(projectRoot, PROJECT_MANIFEST_PATH);
	const currentHash = (await hashFile(manifestPath)).value;
	if (currentHash !== journal.newManifestHash && currentHash !== journal.oldManifestHash) {
		throw new Error("DATA_CONFLICT: v0.5 project changed after migration; rollback would be lossy");
	}
	if (currentHash === journal.newManifestHash) await atomicWriteFile(manifestPath, await readFile(beforePath));
	const rolledBack = await openProject(projectRoot, journal.fromRevision);
	await rename(
		await resolveProjectPath(projectRoot, directory),
		await resolveProjectPath(projectRoot, migrationDirectory(ROLLED_BACK_MIGRATIONS, migrationId)),
	);
	return rolledBack;
}

export async function migrateProject(projectRoot: string): Promise<ProjectMigrationResult> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility === "current") {
		return {
			migrationId: null,
			fromVersion: RESEARCH_SCHEMA_VERSION,
			toVersion: RESEARCH_SCHEMA_VERSION,
			revision: opened.manifest.revision,
			recovered: false,
		};
	}
	if (opened.compatibility !== "migration_required" || opened.schemaVersion !== RESEARCH_LEGACY_SCHEMA_VERSION) {
		throw new TypeError(`No migration path from schema ${opened.schemaVersion}`);
	}
	const pending = await listPendingProjectMigrations(opened.root);
	const migrationId = pending.length === 0 ? await prepareProjectMigration(opened.root) : pending[0];
	if (migrationId === undefined || pending.length > 1) throw new TypeError("Project has multiple pending migrations");
	const migrated = await commitPreparedProjectMigration(opened.root, migrationId);
	return {
		migrationId,
		fromVersion: RESEARCH_LEGACY_SCHEMA_VERSION,
		toVersion: RESEARCH_SCHEMA_VERSION,
		revision: migrated.manifest.revision,
		recovered: pending.length === 1,
	};
}
