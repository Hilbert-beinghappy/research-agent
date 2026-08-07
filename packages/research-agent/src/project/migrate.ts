// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type JsonValue,
	RESEARCH_MIGRATABLE_SCHEMA_VERSIONS,
	RESEARCH_SCHEMA_VERSION,
	type ResearchProjectManifest,
} from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { hashBytes, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { createProjectBackup, readProjectBackup } from "./backup.ts";
import { INITIAL_RECORD_SETS, PROJECT_LAYOUT_DIRECTORIES, PROJECT_MANIFEST_PATH } from "./layout.ts";
import { type OpenedProject, openProject } from "./open.ts";

const MIGRATION_ROOT = ".research/migrations";
const PENDING_MIGRATIONS = `${MIGRATION_ROOT}/pending`;
const COMMITTED_MIGRATIONS = `${MIGRATION_ROOT}/committed`;
const ROLLED_BACK_MIGRATIONS = `${MIGRATION_ROOT}/rolled-back`;
const STAGING_MIGRATIONS = `${MIGRATION_ROOT}/staging`;
const MIGRATION_LOCK = ".research/locks/migration.lock";
const MIGRATABLE_VERSIONS = new Set<string>(RESEARCH_MIGRATABLE_SCHEMA_VERSIONS);

interface MigrationJournal {
	version: 1 | 2;
	migrationId: string;
	fromVersion: string;
	toVersion: string;
	fromRevision: number;
	toRevision: number;
	oldManifestHash: string;
	newManifestHash: string;
	backupId: string | null;
	backupRootHash: string | null;
	createdAt: string;
}

export interface ProjectMigrationResult {
	migrationId: string | null;
	migrationIds: string[];
	fromVersion: string;
	toVersion: typeof RESEARCH_SCHEMA_VERSION;
	revision: number;
	recovered: boolean;
}

function migrationDirectory(parent: string, migrationId: string): string {
	if (!/^migration_[0-9a-f-]{36}$/u.test(migrationId)) throw new TypeError(`Invalid migration ID: ${migrationId}`);
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

function manifestVersion(raw: JsonValue): { schemaVersion: string; revision: number } {
	if (
		raw === null ||
		typeof raw !== "object" ||
		Array.isArray(raw) ||
		raw.kind !== "research_project_manifest" ||
		typeof raw.schemaVersion !== "string" ||
		typeof raw.revision !== "number" ||
		!Number.isInteger(raw.revision) ||
		raw.revision < 0
	) {
		throw new TypeError("Project migration manifest is invalid");
	}
	return { schemaVersion: raw.schemaVersion, revision: raw.revision };
}

export function buildV1Manifest(raw: JsonValue): ResearchProjectManifest {
	const source = manifestVersion(raw);
	if (
		!MIGRATABLE_VERSIONS.has(source.schemaVersion) ||
		raw === null ||
		typeof raw !== "object" ||
		Array.isArray(raw)
	) {
		throw new TypeError(`Project schema ${source.schemaVersion} cannot migrate to ${RESEARCH_SCHEMA_VERSION}`);
	}
	if (!Array.isArray(raw.recordSets)) throw new TypeError("Legacy project record sets are invalid");
	const existing = new Map<string, JsonValue>();
	for (const value of raw.recordSets) {
		if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string") {
			throw new TypeError("Legacy project record sets are invalid");
		}
		if (existing.has(value.kind)) throw new TypeError(`Legacy project has duplicate ${value.kind} record sets`);
		existing.set(value.kind, value);
	}
	const candidate = {
		...raw,
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		recordSets: INITIAL_RECORD_SETS.map((recordSet) => existing.get(recordSet.kind) ?? recordSet),
		updatedAt: new Date().toISOString(),
		revision: source.revision + 1,
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
		(raw.version !== 1 && raw.version !== 2) ||
		raw.migrationId !== migrationId ||
		typeof raw.fromVersion !== "string" ||
		typeof raw.toVersion !== "string" ||
		typeof raw.fromRevision !== "number" ||
		typeof raw.toRevision !== "number" ||
		typeof raw.oldManifestHash !== "string" ||
		typeof raw.newManifestHash !== "string" ||
		typeof raw.createdAt !== "string"
	) {
		throw new TypeError(`Invalid migration journal: ${migrationId}`);
	}
	const backupId = raw.version === 2 && typeof raw.backupId === "string" ? raw.backupId : null;
	const backupRootHash = raw.version === 2 && typeof raw.backupRootHash === "string" ? raw.backupRootHash : null;
	if (raw.version === 2 && (backupId === null || backupRootHash === null)) {
		throw new TypeError(`Migration backup reference is invalid: ${migrationId}`);
	}
	return {
		version: raw.version,
		migrationId,
		fromVersion: raw.fromVersion,
		toVersion: raw.toVersion,
		fromRevision: raw.fromRevision,
		toRevision: raw.toRevision,
		oldManifestHash: raw.oldManifestHash,
		newManifestHash: raw.newManifestHash,
		backupId,
		backupRootHash,
		createdAt: raw.createdAt,
	};
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

export async function listStagedProjectMigrations(projectRoot: string): Promise<string[]> {
	return readDirectoryNames(projectRoot, STAGING_MIGRATIONS);
}

export async function prepareProjectMigration(projectRoot: string): Promise<string> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "migration_required" || !MIGRATABLE_VERSIONS.has(opened.schemaVersion)) {
		throw new TypeError(
			`Project schema ${opened.compatibility === "current" ? RESEARCH_SCHEMA_VERSION : opened.schemaVersion} cannot migrate to ${RESEARCH_SCHEMA_VERSION}`,
		);
	}
	const oldManifest = await readFile(opened.manifestPath, "utf8");
	const raw = canonicalizeJson(JSON.parse(oldManifest));
	const source = manifestVersion(raw);
	const targetManifest = buildV1Manifest(raw);
	const target = `${canonicalStringify(targetManifest)}\n`;
	const backup = await createProjectBackup(
		opened.root,
		`Before migration ${source.schemaVersion} to ${RESEARCH_SCHEMA_VERSION}`,
	);
	const migrationId = `migration_${randomUUID()}`;
	await Promise.all(
		[PENDING_MIGRATIONS, COMMITTED_MIGRATIONS, ROLLED_BACK_MIGRATIONS, STAGING_MIGRATIONS].map(async (directory) =>
			mkdir(await resolveProjectPath(projectRoot, directory), { recursive: true }),
		),
	);
	const staging = migrationDirectory(STAGING_MIGRATIONS, migrationId);
	await mkdir(await resolveProjectPath(projectRoot, staging));
	const journal: MigrationJournal = {
		version: 2,
		migrationId,
		fromVersion: source.schemaVersion,
		toVersion: RESEARCH_SCHEMA_VERSION,
		fromRevision: source.revision,
		toRevision: targetManifest.revision,
		oldManifestHash: hashBytes(oldManifest).value,
		newManifestHash: hashBytes(target).value,
		backupId: backup.backupId,
		backupRootHash: backup.rootHash.value,
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

export async function commitPreparedProjectMigration(projectRoot: string, migrationId: string): Promise<OpenedProject> {
	const parent = await locateMigration(projectRoot, migrationId);
	if (parent === COMMITTED_MIGRATIONS) return openProject(projectRoot);
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
	const target = manifestVersion(canonicalizeJson(JSON.parse(after)));
	if (target.schemaVersion !== journal.toVersion || target.revision !== journal.toRevision) {
		throw new TypeError(`Migration target manifest is invalid: ${migrationId}`);
	}
	if (journal.backupId !== null) {
		const backup = await readProjectBackup(projectRoot, journal.backupId);
		if (backup.rootHash.value !== journal.backupRootHash)
			throw new Error(`Migration backup hash mismatch: ${migrationId}`);
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
	if (journal.backupId !== null) {
		const backup = await readProjectBackup(projectRoot, journal.backupId);
		if (backup.rootHash.value !== journal.backupRootHash)
			throw new Error(`Migration backup hash mismatch: ${migrationId}`);
	}
	const manifestPath = await resolveProjectPath(projectRoot, PROJECT_MANIFEST_PATH);
	const currentHash = (await hashFile(manifestPath)).value;
	if (currentHash !== journal.newManifestHash && currentHash !== journal.oldManifestHash) {
		throw new Error("DATA_CONFLICT: project changed after migration; rollback would be lossy");
	}
	if (currentHash === journal.newManifestHash) await atomicWriteFile(manifestPath, await readFile(beforePath));
	const rolledBack = await openProject(projectRoot, journal.fromRevision);
	await rename(
		await resolveProjectPath(projectRoot, directory),
		await resolveProjectPath(projectRoot, migrationDirectory(ROLLED_BACK_MIGRATIONS, migrationId)),
	);
	return rolledBack;
}

async function migrateProjectUnlocked(projectRoot: string): Promise<ProjectMigrationResult> {
	let opened = await openProject(projectRoot);
	const staged = await listStagedProjectMigrations(opened.root);
	for (const migrationId of staged) {
		await rm(await resolveProjectPath(opened.root, migrationDirectory(STAGING_MIGRATIONS, migrationId)), {
			recursive: true,
		});
	}
	let recovered = staged.length > 0;
	if (opened.compatibility === "current") {
		const pending = await listPendingProjectMigrations(opened.root);
		if (pending.length > 1) throw new TypeError("Project has multiple pending migrations");
		if (pending[0] !== undefined) {
			const journal = await readJournal(opened.root, PENDING_MIGRATIONS, pending[0]);
			opened = await commitPreparedProjectMigration(opened.root, pending[0]);
			if (opened.compatibility !== "current")
				throw new TypeError("Recovered migration did not produce a current project");
			return {
				migrationId: pending[0],
				migrationIds: [pending[0]],
				fromVersion: journal.fromVersion,
				toVersion: RESEARCH_SCHEMA_VERSION,
				revision: opened.manifest.revision,
				recovered: true,
			};
		}
		return {
			migrationId: null,
			migrationIds: [],
			fromVersion: RESEARCH_SCHEMA_VERSION,
			toVersion: RESEARCH_SCHEMA_VERSION,
			revision: opened.manifest.revision,
			recovered,
		};
	}
	if (opened.compatibility !== "migration_required" || !MIGRATABLE_VERSIONS.has(opened.schemaVersion)) {
		throw new TypeError(`No migration path from schema ${opened.schemaVersion}`);
	}
	const fromVersion = opened.schemaVersion;
	const migrationIds: string[] = [];
	while (opened.compatibility !== "current") {
		const pending = await listPendingProjectMigrations(opened.root);
		if (pending.length > 1) throw new TypeError("Project has multiple pending migrations");
		const existing = pending[0];
		const migrationId = existing ?? (await prepareProjectMigration(opened.root));
		recovered ||= existing !== undefined;
		migrationIds.push(migrationId);
		opened = await commitPreparedProjectMigration(opened.root, migrationId);
		if (opened.compatibility === "newer_schema")
			throw new TypeError(`Migration produced unsupported schema ${opened.schemaVersion}`);
		if (opened.compatibility === "migration_required" && !MIGRATABLE_VERSIONS.has(opened.schemaVersion)) {
			throw new TypeError(`No migration path from schema ${opened.schemaVersion}`);
		}
	}
	return {
		migrationId: migrationIds.at(-1) ?? null,
		migrationIds,
		fromVersion,
		toVersion: RESEARCH_SCHEMA_VERSION,
		revision: opened.manifest.revision,
		recovered,
	};
}

export async function migrateProject(projectRoot: string): Promise<ProjectMigrationResult> {
	await mkdir(await resolveProjectPath(projectRoot, ".research/locks"), { recursive: true });
	const lockPath = await resolveProjectPath(projectRoot, MIGRATION_LOCK);
	let lock: Awaited<ReturnType<typeof open>>;
	try {
		lock = await open(lockPath, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("MIGRATION_LOCKED: another project migration is active or requires manual recovery");
		}
		throw error;
	}
	try {
		await lock.writeFile(`${canonicalStringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
		await lock.sync();
		return await migrateProjectUnlocked(projectRoot);
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
	}
}
