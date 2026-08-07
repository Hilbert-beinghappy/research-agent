// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type ClaimRecord,
	type EvidenceCard,
	type HashValue,
	type JsonValue,
	RESEARCH_MIGRATABLE_SCHEMA_VERSIONS,
	RESEARCH_SCHEMA_VERSION,
	type RecordKind,
	type ResearchProjectManifest,
} from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { BUILT_IN_DOMAIN_PACKAGE_VERSION } from "../domain/packages.ts";
import { hashBytes, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { createProjectBackupWithWriterLeaseHeld, readProjectBackup } from "./backup.ts";
import { INITIAL_RECORD_SETS, PROJECT_LAYOUT_DIRECTORIES, PROJECT_MANIFEST_PATH } from "./layout.ts";
import { type OpenedProject, openProject } from "./open.ts";
import { calculateRecordSetIndex, projectRecordId, projectRecordSet } from "./record-index.ts";
import { withProjectWriterLease } from "./writer-lock.ts";

const MIGRATION_ROOT = ".research/migrations";
const PENDING_MIGRATIONS = `${MIGRATION_ROOT}/pending`;
const COMMITTED_MIGRATIONS = `${MIGRATION_ROOT}/committed`;
const ROLLED_BACK_MIGRATIONS = `${MIGRATION_ROOT}/rolled-back`;
const STAGING_MIGRATIONS = `${MIGRATION_ROOT}/staging`;
const MIGRATION_LOCK = ".research/locks/migration.lock";
const MIGRATABLE_VERSIONS = new Set<string>(RESEARCH_MIGRATABLE_SCHEMA_VERSIONS);
const BUILT_IN_DOMAIN_PACKAGES: Record<string, string> = {
	management: "pi-research-domain-management",
	"public-administration": "pi-research-domain-public-administration",
	sociology: "pi-research-domain-sociology",
	"political-science": "pi-research-domain-political-science",
};

interface MigrationJournal {
	version: 1 | 2 | 3;
	migrationId: string;
	fromVersion: string;
	toVersion: string;
	fromRevision: number;
	toRevision: number;
	oldManifestHash: string;
	newManifestHash: string;
	backupId: string | null;
	backupRootHash: string | null;
	recordChanges: MigrationRecordChange[];
	createdAt: string;
}

interface MigrationRecordChange {
	path: string;
	beforeHash: string;
	afterHash: string;
}

interface PreparedMigrationRecordChange extends MigrationRecordChange {
	kind: "evidence" | "claim";
	id: string;
	afterHashValue: HashValue;
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
	if (raw.domain === null || typeof raw.domain !== "object" || Array.isArray(raw.domain)) {
		throw new TypeError("Legacy project domain is invalid");
	}
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
		domain: {
			...raw.domain,
			templatePackage:
				typeof raw.domain.templatePackage === "string"
					? raw.domain.templatePackage
					: typeof raw.domain.id === "string"
						? (BUILT_IN_DOMAIN_PACKAGES[raw.domain.id] ?? null)
						: null,
			templateVersion:
				typeof raw.domain.templatePackage === "string"
					? typeof raw.domain.templateVersion === "string"
						? raw.domain.templateVersion
						: null
					: typeof raw.domain.id === "string" && BUILT_IN_DOMAIN_PACKAGES[raw.domain.id] !== undefined
						? BUILT_IN_DOMAIN_PACKAGE_VERSION
						: null,
		},
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

function unknownSemanticProvenance(): EvidenceCard["extraction"] {
	return {
		method: "unknown_legacy",
		operationId: null,
		modelProvider: null,
		modelId: null,
		promptHash: null,
		toolSchemaHash: null,
		turnId: null,
	};
}

function migrateSemanticRecord(raw: JsonValue, expectedKind: "evidence" | "claim"): EvidenceCard | ClaimRecord {
	const existing = validatePersistedRecord(raw);
	if (!existing.ok || existing.value.kind !== expectedKind) {
		const details = existing.ok
			? `expected ${expectedKind}, found ${existing.value.kind}`
			: existing.issues.map(({ code, path }) => `${path}:${code}`).join(", ");
		throw new TypeError(`Legacy ${expectedKind} record is invalid: ${details}`);
	}
	if (existing.value.schemaVersion === RESEARCH_SCHEMA_VERSION) return existing.value;
	const candidate =
		existing.value.kind === "evidence"
			? {
					...existing.value,
					schemaVersion: RESEARCH_SCHEMA_VERSION,
					extraction: unknownSemanticProvenance(),
					sourceVerification: {
						method: "unknown_legacy" as const,
						operationId: null,
						locatorStatus: "unknown_legacy" as const,
						excerptStatus: "unknown_legacy" as const,
					},
				}
			: {
					...existing.value,
					schemaVersion: RESEARCH_SCHEMA_VERSION,
					semanticProvenance: {
						claim: unknownSemanticProvenance(),
						evidenceLinks: existing.value.evidenceLinks.map(() => unknownSemanticProvenance()),
					},
				};
	const migrated = validatePersistedRecord(candidate);
	if (!migrated.ok || migrated.value.kind !== expectedKind) {
		const details = migrated.ok
			? `expected ${expectedKind}, found ${migrated.value.kind}`
			: migrated.issues.map(({ code, path }) => `${path}:${code}`).join(", ");
		throw new TypeError(`Migrated ${expectedKind} record is invalid: ${details}`);
	}
	return migrated.value;
}

async function prepareSemanticRecordChanges(
	projectRoot: string,
	manifest: ResearchProjectManifest,
	staging: string,
): Promise<PreparedMigrationRecordChange[]> {
	const changes: PreparedMigrationRecordChange[] = [];
	for (const kind of ["evidence", "claim"] as const) {
		const recordSet = projectRecordSet(manifest, kind);
		const directory = await resolveProjectPath(projectRoot, recordSet.path);
		for (const fileName of (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()) {
			const path = `${recordSet.path}/${fileName}`;
			const before = await readFile(await resolveProjectPath(projectRoot, path), "utf8");
			const migrated = migrateSemanticRecord(canonicalizeJson(JSON.parse(before)), kind);
			const after = `${canonicalStringify(migrated)}\n`;
			if (before === after) continue;
			const beforeHash = hashBytes(before);
			const afterHash = hashBytes(after);
			for (const snapshot of ["records.before", "records.after"] as const) {
				await mkdir(dirname(await resolveProjectPath(projectRoot, `${staging}/${snapshot}/${path}`)), {
					recursive: true,
				});
			}
			await atomicWriteFile(await resolveProjectPath(projectRoot, `${staging}/records.before/${path}`), before);
			await atomicWriteFile(await resolveProjectPath(projectRoot, `${staging}/records.after/${path}`), after);
			changes.push({
				kind,
				id: projectRecordId(migrated),
				path,
				beforeHash: beforeHash.value,
				afterHash: afterHash.value,
				afterHashValue: afterHash,
			});
		}
	}
	return changes;
}

async function withMigratedRecordIndexes(
	projectRoot: string,
	manifest: ResearchProjectManifest,
	changes: PreparedMigrationRecordChange[],
): Promise<ResearchProjectManifest> {
	let recordSets = manifest.recordSets;
	for (const kind of ["evidence", "claim"] as const satisfies readonly RecordKind[]) {
		const index = await calculateRecordSetIndex(
			projectRoot,
			manifest,
			kind,
			changes
				.filter((change) => change.kind === kind)
				.map(({ id, afterHashValue }) => ({ id, hash: afterHashValue })),
		);
		recordSets = recordSets.map((recordSet) => (recordSet.kind === kind ? { ...recordSet, ...index } : recordSet));
	}
	const validation = validatePersistedRecord({ ...manifest, recordSets });
	if (!validation.ok || validation.value.kind !== "research_project_manifest") {
		const details = validation.ok
			? "unexpected record kind"
			: validation.issues.map(({ code, path }) => `${path}:${code}`).join(", ");
		throw new TypeError(`Migrated project manifest indexes are invalid: ${details}`);
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
		(raw.version !== 1 && raw.version !== 2 && raw.version !== 3) ||
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
	const backupId = raw.version >= 2 && typeof raw.backupId === "string" ? raw.backupId : null;
	const backupRootHash = raw.version >= 2 && typeof raw.backupRootHash === "string" ? raw.backupRootHash : null;
	if (raw.version >= 2 && (backupId === null || backupRootHash === null)) {
		throw new TypeError(`Migration backup reference is invalid: ${migrationId}`);
	}
	const recordChanges: MigrationRecordChange[] = [];
	if (raw.version === 3) {
		if (!Array.isArray(raw.recordChanges))
			throw new TypeError(`Migration record changes are invalid: ${migrationId}`);
		for (const change of raw.recordChanges) {
			if (
				change === null ||
				typeof change !== "object" ||
				Array.isArray(change) ||
				typeof change.path !== "string" ||
				typeof change.beforeHash !== "string" ||
				typeof change.afterHash !== "string"
			) {
				throw new TypeError(`Migration record changes are invalid: ${migrationId}`);
			}
			recordChanges.push({
				path: change.path,
				beforeHash: change.beforeHash,
				afterHash: change.afterHash,
			});
		}
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
		recordChanges,
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

async function prepareProjectMigrationUnlocked(projectRoot: string): Promise<string> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "migration_required" || !MIGRATABLE_VERSIONS.has(opened.schemaVersion)) {
		throw new TypeError(
			`Project schema ${opened.compatibility === "current" ? RESEARCH_SCHEMA_VERSION : opened.schemaVersion} cannot migrate to ${RESEARCH_SCHEMA_VERSION}`,
		);
	}
	const oldManifest = await readFile(opened.manifestPath, "utf8");
	const raw = canonicalizeJson(JSON.parse(oldManifest));
	const source = manifestVersion(raw);
	const baseTargetManifest = buildV1Manifest(raw);
	const backup = await createProjectBackupWithWriterLeaseHeld(
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
	const preparedRecordChanges = await prepareSemanticRecordChanges(opened.root, baseTargetManifest, staging);
	const targetManifest = await withMigratedRecordIndexes(opened.root, baseTargetManifest, preparedRecordChanges);
	const target = `${canonicalStringify(targetManifest)}\n`;
	const journal: MigrationJournal = {
		version: 3,
		migrationId,
		fromVersion: source.schemaVersion,
		toVersion: RESEARCH_SCHEMA_VERSION,
		fromRevision: source.revision,
		toRevision: targetManifest.revision,
		oldManifestHash: hashBytes(oldManifest).value,
		newManifestHash: hashBytes(target).value,
		backupId: backup.backupId,
		backupRootHash: backup.rootHash.value,
		recordChanges: preparedRecordChanges.map(({ path, beforeHash, afterHash }) => ({
			path,
			beforeHash,
			afterHash,
		})),
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

interface VerifiedMigrationRecordChange {
	change: MigrationRecordChange;
	currentHash: string;
	beforePath: string;
	afterPath: string;
	livePath: string;
}

async function verifyMigrationRecordChanges(
	projectRoot: string,
	directory: string,
	recordChanges: MigrationRecordChange[],
	conflictMessage: string,
): Promise<VerifiedMigrationRecordChange[]> {
	const verified: VerifiedMigrationRecordChange[] = [];
	for (const change of recordChanges) {
		const beforePath = await resolveProjectPath(projectRoot, `${directory}/records.before/${change.path}`);
		const afterPath = await resolveProjectPath(projectRoot, `${directory}/records.after/${change.path}`);
		if (
			(await hashFile(beforePath)).value !== change.beforeHash ||
			(await hashFile(afterPath)).value !== change.afterHash
		) {
			throw new Error(`Migration record snapshot hash mismatch: ${change.path}`);
		}
		const livePath = await resolveProjectPath(projectRoot, change.path);
		const currentHash = (await hashFile(livePath)).value;
		if (currentHash !== change.beforeHash && currentHash !== change.afterHash) throw new Error(conflictMessage);
		verified.push({ change, currentHash, beforePath, afterPath, livePath });
	}
	return verified;
}

async function installMigrationRecordSnapshots(
	verified: VerifiedMigrationRecordChange[],
	direction: "after" | "before",
): Promise<void> {
	for (const snapshot of verified) {
		const targetHash = direction === "after" ? snapshot.change.afterHash : snapshot.change.beforeHash;
		if (snapshot.currentHash === targetHash) continue;
		await atomicWriteFile(
			snapshot.livePath,
			await readFile(direction === "after" ? snapshot.afterPath : snapshot.beforePath),
		);
	}
}

async function commitPreparedProjectMigrationUnlocked(
	projectRoot: string,
	migrationId: string,
): Promise<OpenedProject> {
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
	const recordChanges = await verifyMigrationRecordChanges(
		projectRoot,
		directory,
		journal.recordChanges,
		`DATA_CONFLICT: project records changed after migration preparation: ${migrationId}`,
	);
	for (const directoryPath of PROJECT_LAYOUT_DIRECTORIES) {
		await mkdir(await resolveProjectPath(projectRoot, directoryPath), { recursive: true });
	}
	await installMigrationRecordSnapshots(recordChanges, "after");
	if (currentHash === journal.oldManifestHash) await atomicWriteFile(manifestPath, after);
	const migrated = await openProject(projectRoot, journal.toRevision);
	await rename(
		await resolveProjectPath(projectRoot, directory),
		await resolveProjectPath(projectRoot, migrationDirectory(COMMITTED_MIGRATIONS, migrationId)),
	);
	return migrated;
}

async function rollbackProjectMigrationUnlocked(projectRoot: string, migrationId: string): Promise<OpenedProject> {
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
	const recordChanges = await verifyMigrationRecordChanges(
		projectRoot,
		directory,
		journal.recordChanges,
		"DATA_CONFLICT: project records changed after migration; rollback would be lossy",
	);
	await installMigrationRecordSnapshots(recordChanges, "before");
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
			opened = await commitPreparedProjectMigrationUnlocked(opened.root, pending[0]);
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
		const migrationId = existing ?? (await prepareProjectMigrationUnlocked(opened.root));
		recovered ||= existing !== undefined;
		migrationIds.push(migrationId);
		opened = await commitPreparedProjectMigrationUnlocked(opened.root, migrationId);
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
	return withProjectWriterLease(projectRoot, async () => {
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
	});
}

export async function prepareProjectMigration(projectRoot: string): Promise<string> {
	return withProjectWriterLease(projectRoot, () => prepareProjectMigrationUnlocked(projectRoot));
}

export async function commitPreparedProjectMigration(projectRoot: string, migrationId: string): Promise<OpenedProject> {
	return withProjectWriterLease(projectRoot, () => commitPreparedProjectMigrationUnlocked(projectRoot, migrationId));
}

export async function rollbackProjectMigration(projectRoot: string, migrationId: string): Promise<OpenedProject> {
	return withProjectWriterLease(projectRoot, () => rollbackProjectMigrationUnlocked(projectRoot, migrationId));
}
