// SPDX-License-Identifier: Apache-2.0

import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Compile } from "typebox/compile";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type AdapterRegistrationRecord,
	type ExchangeBundleManifest,
	ExchangeBundleManifestSchema,
	type ProjectBackupFile,
} from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath, resolveProjectPathWithoutSymlinks, validatePortablePathSet } from "../kernel/paths.ts";
import { PROJECT_LAYOUT_DIRECTORIES } from "../project/layout.ts";
import { listPendingProjectMigrations } from "../project/migrate.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { readRecord } from "../project/records.ts";
import { listPendingProjectTransactions } from "../project/transactions.ts";

const ExchangeValidator = Compile(ExchangeBundleManifestSchema);
const BASE_ROOTS = ["research-project.json", "README.md", ".research/records", "sources/parsed", "notes", "artifacts"];
const RAW_ROOTS = ["sources/originals", "sources/imports"];
const EXCLUDED_PATHS = [
	".research/backups",
	".research/cache",
	".research/locks",
	".research/migrations",
	".research/runs",
	".research/transactions",
	"sources/originals",
	"sources/imports",
];

export interface PackExchangeOptions {
	includeRawMaterials?: boolean;
	signingKey?: KeyObject | string;
}

async function directoryEntries(path: string): Promise<string[]> {
	try {
		return (await readdir(path)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function collectPaths(projectRoot: string, roots: readonly string[]): Promise<string[]> {
	const paths: string[] = [];
	const visit = async (path: string): Promise<void> => {
		if (path.split("/").some((part) => part.startsWith("._"))) return;
		const absolute = await resolveProjectPathWithoutSymlinks(projectRoot, path);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (info.isDirectory()) {
			for (const name of await directoryEntries(absolute)) await visit(`${path}/${name}`);
			return;
		}
		if (!info.isFile()) throw new TypeError(`Exchange bundles support regular files only: ${path}`);
		paths.push(path);
	};
	for (const root of roots) await visit(root);
	return validatePortablePathSet(paths.sort());
}

async function parallelFor<Value>(values: readonly Value[], worker: (value: Value, index: number) => Promise<void>) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(16, values.length) }, async () => {
			for (;;) {
				const index = next;
				next += 1;
				const value = values[index];
				if (value === undefined) return;
				await worker(value, index);
			}
		}),
	);
}

async function fileManifest(projectRoot: string, paths: readonly string[]): Promise<ProjectBackupFile[]> {
	const files: ProjectBackupFile[] = [];
	await parallelFor(paths, async (path, index) => {
		const absolute = await resolveProjectPathWithoutSymlinks(projectRoot, path);
		const [hash, metadata] = await Promise.all([hashFile(absolute), stat(absolute)]);
		files[index] = { path, hash, bytes: metadata.size };
	});
	return files;
}

function signaturePayload(manifest: ExchangeBundleManifest): string {
	return canonicalStringify({ ...manifest, signature: null });
}

function signManifest(manifest: ExchangeBundleManifest, signingKey: KeyObject | string): ExchangeBundleManifest {
	const privateKey = typeof signingKey === "string" ? createPrivateKey(signingKey) : signingKey;
	const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
	return {
		...manifest,
		signature: {
			algorithm: "ed25519",
			publicKey,
			signature: sign(null, Buffer.from(signaturePayload(manifest)), privateKey).toString("base64"),
		},
	};
}

function verifyManifestSignature(manifest: ExchangeBundleManifest): boolean {
	if (manifest.signature === null) return true;
	const publicKey = createPublicKey({
		key: Buffer.from(manifest.signature.publicKey, "base64"),
		format: "der",
		type: "spki",
	});
	return verify(
		null,
		Buffer.from(signaturePayload(manifest)),
		publicKey,
		Buffer.from(manifest.signature.signature, "base64"),
	);
}

async function requiredAdapters(projectRoot: string): Promise<ExchangeBundleManifest["requiredAdapters"]> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") return [];
	const adapters: AdapterRegistrationRecord[] = [];
	for (const id of await listProjectRecordIds(opened.root, opened.manifest, "adapter_registration")) {
		const record = await readRecord(opened.root, "adapter_registration", id);
		if (record.ok && record.value.kind === "adapter_registration" && record.value.status === "active") {
			adapters.push(record.value);
		}
	}
	return adapters
		.map(({ manifest }) => ({
			packageId: manifest.packageId,
			packageVersion: manifest.packageVersion,
			packageHash: manifest.packageHash,
			manifestHash: hashCanonicalJson(manifest),
		}))
		.sort((left, right) => left.packageId.localeCompare(right.packageId));
}

export async function packProjectExchange(
	projectRoot: string,
	bundleRoot: string,
	options: PackExchangeOptions = {},
): Promise<ExchangeBundleManifest> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Only current projects can be packed for exchange");
	const [transactions, migrations] = await Promise.all([
		listPendingProjectTransactions(opened.root),
		listPendingProjectMigrations(opened.root),
	]);
	if (transactions.length > 0 || migrations.length > 0) {
		throw new TypeError("Exchange packing requires no pending transaction or migration");
	}
	const target = resolve(bundleRoot);
	try {
		await lstat(target);
		throw new TypeError("Exchange destination must not already exist");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const includeRawMaterials = options.includeRawMaterials ?? false;
	const paths = await collectPaths(opened.root, [...BASE_ROOTS, ...(includeRawMaterials ? RAW_ROOTS : [])]);
	const files = await fileManifest(opened.root, paths);
	let manifest: ExchangeBundleManifest = {
		format: "pi-research-exchange-bundle",
		version: 1,
		bundleId: createOpaqueId("exchange_bundle"),
		projectId: opened.manifest.projectId,
		projectSchemaVersion: opened.manifest.schemaVersion,
		projectRevision: opened.manifest.revision,
		createdAt: new Date().toISOString(),
		includesRawMaterials: includeRawMaterials,
		files,
		excludedPaths: includeRawMaterials ? EXCLUDED_PATHS.slice(0, 6) : EXCLUDED_PATHS,
		requiredAdapters: await requiredAdapters(opened.root),
		rootHash: hashCanonicalJson(files),
		signature: null,
	};
	if (options.signingKey !== undefined) manifest = signManifest(manifest, options.signingKey);
	const staging = `${target}.staging-${manifest.bundleId}`;
	await mkdir(staging, { recursive: false });
	try {
		await parallelFor(files, async (file) => {
			const source = await resolveProjectPathWithoutSymlinks(opened.root, file.path);
			const destination = resolve(staging, "files", ...file.path.split("/"));
			await mkdir(dirname(destination), { recursive: true });
			await copyFile(source, destination);
			if ((await hashFile(destination)).value !== file.hash.value) {
				throw new Error(`Exchange copy hash mismatch: ${file.path}`);
			}
		});
		await writeFile(resolve(staging, "bundle.json"), `${canonicalStringify(manifest)}\n`);
		await rename(staging, target);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return manifest;
}

export async function readProjectExchange(bundleRoot: string): Promise<ExchangeBundleManifest> {
	const root = resolve(bundleRoot);
	const value = canonicalizeJson(
		JSON.parse(await readFile(await resolveProjectPathWithoutSymlinks(root, "bundle.json"), "utf8")),
	);
	if (!ExchangeValidator.Check(value)) throw new TypeError("Exchange bundle manifest is invalid");
	validatePortablePathSet(value.files.map(({ path }) => path));
	if (hashCanonicalJson(value.files).value !== value.rootHash.value) {
		throw new TypeError("Exchange bundle root hash mismatch");
	}
	if (!verifyManifestSignature(value)) throw new TypeError("Exchange bundle signature is invalid");
	for (const file of value.files) {
		const path = await resolveProjectPathWithoutSymlinks(root, `files/${file.path}`);
		const metadata = await stat(path);
		if (!metadata.isFile() || metadata.size !== file.bytes || (await hashFile(path)).value !== file.hash.value) {
			throw new TypeError(`Exchange bundle file mismatch: ${file.path}`);
		}
	}
	return value;
}

export async function unpackProjectExchange(bundleRoot: string, destination: string): Promise<ExchangeBundleManifest> {
	const manifest = await readProjectExchange(bundleRoot);
	const target = resolve(destination);
	try {
		await lstat(target);
		throw new TypeError("Exchange import destination must not already exist");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const staging = `${target}.staging-${manifest.bundleId}`;
	await mkdir(staging, { recursive: false });
	try {
		await parallelFor(manifest.files, async (file) => {
			const source = await resolveProjectPathWithoutSymlinks(bundleRoot, `files/${file.path}`);
			const output = resolve(staging, ...file.path.split("/"));
			await mkdir(dirname(output), { recursive: true });
			await copyFile(source, output);
			if ((await hashFile(output)).value !== file.hash.value) {
				throw new Error(`Exchange import copy hash mismatch: ${file.path}`);
			}
		});
		const imported = await openProject(staging);
		if (imported.compatibility !== "current") throw new TypeError("Exchange project schema is read-only");
		await Promise.all(
			PROJECT_LAYOUT_DIRECTORIES.map(async (path) =>
				mkdir(await resolveProjectPath(staging, path), { recursive: true }),
			),
		);
		await rename(staging, target);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	await openProject(target);
	return manifest;
}
