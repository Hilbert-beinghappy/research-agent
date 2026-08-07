// SPDX-License-Identifier: Apache-2.0

import { copyFile, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Compile } from "typebox/compile";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type ProjectBackupFile,
	type ProjectBackupManifest,
	ProjectBackupManifestSchema,
} from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath, validateProjectRelativePath } from "../kernel/paths.ts";
import { type OpenedProject, openProject } from "./open.ts";

const BACKUP_ROOT = ".research/backups";
const BACKUP_STAGING = `${BACKUP_ROOT}/staging`;
const BACKUP_COMMITTED = `${BACKUP_ROOT}/committed`;
const INCLUDED_ROOTS = ["research-project.json", "README.md", ".research", "sources", "notes", "artifacts"];
const EXCLUDED_PREFIXES = [`${BACKUP_ROOT}/`, ".research/cache/", ".research/locks/"];
const BackupValidator = Compile(ProjectBackupManifestSchema);

export interface RestoredProject {
	destination: string;
	backup: ProjectBackupManifest;
	compatibility: OpenedProject["compatibility"];
}

function backupDirectory(parent: string, backupId: string): string {
	if (!/^backup_[0-9a-f-]{36}$/u.test(backupId)) throw new TypeError(`Invalid backup ID: ${backupId}`);
	return `${parent}/${backupId}`;
}

async function directoryEntries(path: string): Promise<string[]> {
	try {
		return (await readdir(path)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function excluded(path: string): boolean {
	return (
		path.split("/").some((part) => part.startsWith("._")) ||
		EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))
	);
}

async function collectProjectPaths(projectRoot: string): Promise<string[]> {
	const paths: string[] = [];
	const visit = async (path: string): Promise<void> => {
		if (excluded(path)) return;
		const absolute = await resolveProjectPath(projectRoot, path);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (info.isSymbolicLink()) throw new TypeError(`Project backup does not follow symbolic links: ${path}`);
		if (info.isDirectory()) {
			for (const name of await directoryEntries(absolute)) await visit(`${path}/${name}`);
			return;
		}
		if (!info.isFile()) throw new TypeError(`Project backup supports regular files only: ${path}`);
		paths.push(validateProjectRelativePath(path));
	};
	for (const path of INCLUDED_ROOTS) await visit(path);
	return paths.sort();
}

async function parallelFor<Value>(values: readonly Value[], worker: (value: Value, index: number) => Promise<void>) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(16, values.length) }, async () => {
			while (next < values.length) {
				const index = next;
				next += 1;
				const value = values[index];
				if (value !== undefined) await worker(value, index);
			}
		}),
	);
}

async function snapshotFiles(projectRoot: string): Promise<ProjectBackupFile[]> {
	const paths = await collectProjectPaths(projectRoot);
	const files: ProjectBackupFile[] = [];
	await parallelFor(paths, async (path, index) => {
		const absolute = await resolveProjectPath(projectRoot, path);
		const [fileStat, hash] = await Promise.all([stat(absolute), hashFile(absolute)]);
		files[index] = { path, hash, bytes: fileStat.size };
	});
	return files;
}

function manifestIdentity(opened: OpenedProject): { projectId: string; schemaVersion: string; revision: number } {
	const manifest = opened.manifest;
	if (
		manifest === null ||
		typeof manifest !== "object" ||
		Array.isArray(manifest) ||
		typeof manifest.projectId !== "string" ||
		typeof manifest.schemaVersion !== "string" ||
		typeof manifest.revision !== "number"
	) {
		throw new TypeError("Project manifest identity is invalid");
	}
	return { projectId: manifest.projectId, schemaVersion: manifest.schemaVersion, revision: manifest.revision };
}

export async function createProjectBackup(
	projectRoot: string,
	label: string | null = null,
): Promise<ProjectBackupManifest> {
	const opened = await openProject(projectRoot);
	const [transactions, migrations] = await Promise.all([
		directoryEntries(await resolveProjectPath(opened.root, ".research/transactions/pending")),
		directoryEntries(await resolveProjectPath(opened.root, ".research/migrations/pending")),
	]);
	if (transactions.length > 0 || migrations.length > 0) {
		throw new TypeError("Project backup requires no pending transaction or migration");
	}
	const files = await snapshotFiles(opened.root);
	const identity = manifestIdentity(opened);
	const backupId = createOpaqueId("backup");
	const backup: ProjectBackupManifest = {
		format: "pi-research-project-backup",
		version: 1,
		backupId,
		projectId: identity.projectId,
		projectSchemaVersion: identity.schemaVersion,
		projectRevision: identity.revision,
		createdAt: new Date().toISOString(),
		label,
		files,
		rootHash: hashCanonicalJson(files),
	};
	const staging = backupDirectory(BACKUP_STAGING, backupId);
	const committed = backupDirectory(BACKUP_COMMITTED, backupId);
	await mkdir(await resolveProjectPath(opened.root, staging), { recursive: true });
	await parallelFor(files, async (file) => {
		const source = await resolveProjectPath(opened.root, file.path);
		const target = await resolveProjectPath(opened.root, `${staging}/files/${file.path}`);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
		if ((await hashFile(target)).value !== file.hash.value)
			throw new Error(`Backup copy hash mismatch: ${file.path}`);
	});
	await mkdir(await resolveProjectPath(opened.root, BACKUP_COMMITTED), { recursive: true });
	await mkdir(await resolveProjectPath(opened.root, BACKUP_STAGING), { recursive: true });
	await writeFile(await resolveProjectPath(opened.root, `${staging}/backup.json`), `${canonicalStringify(backup)}\n`);
	await rename(await resolveProjectPath(opened.root, staging), await resolveProjectPath(opened.root, committed));
	return backup;
}

export async function listProjectBackups(projectRoot: string): Promise<string[]> {
	return directoryEntries(await resolveProjectPath(projectRoot, BACKUP_COMMITTED));
}

export async function readProjectBackup(projectRoot: string, backupId: string): Promise<ProjectBackupManifest> {
	const path = `${backupDirectory(BACKUP_COMMITTED, backupId)}/backup.json`;
	const parsed = canonicalizeJson(JSON.parse(await readFile(await resolveProjectPath(projectRoot, path), "utf8")));
	if (!BackupValidator.Check(parsed)) throw new TypeError(`Invalid project backup: ${backupId}`);
	if (hashCanonicalJson(parsed.files).value !== parsed.rootHash.value) {
		throw new TypeError(`Project backup root hash mismatch: ${backupId}`);
	}
	return parsed;
}

export async function restoreProjectBackup(
	projectRoot: string,
	backupId: string,
	destination: string,
): Promise<RestoredProject> {
	const sourceRoot = resolve(projectRoot);
	const targetRoot = resolve(destination);
	if (sourceRoot === targetRoot) throw new TypeError("Restore destination must differ from the source project");
	await mkdir(targetRoot, { recursive: true });
	if ((await readdir(targetRoot)).length > 0) throw new TypeError("Restore destination must be empty");
	const backup = await readProjectBackup(sourceRoot, backupId);
	const directory = backupDirectory(BACKUP_COMMITTED, backupId);
	await parallelFor(backup.files, async (file) => {
		const source = await resolveProjectPath(sourceRoot, `${directory}/files/${file.path}`);
		if ((await hashFile(source)).value !== file.hash.value)
			throw new Error(`Backup file hash mismatch: ${file.path}`);
		const target = await resolveProjectPath(targetRoot, file.path);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	});
	const restoredFiles = await snapshotFiles(targetRoot);
	if (hashCanonicalJson(restoredFiles).value !== backup.rootHash.value) {
		throw new Error("Restored project root hash does not match the backup");
	}
	const opened = await openProject(targetRoot);
	if (manifestIdentity(opened).projectId !== backup.projectId)
		throw new Error("Restored project ID does not match backup");
	return { destination: targetRoot, backup, compatibility: opened.compatibility };
}
