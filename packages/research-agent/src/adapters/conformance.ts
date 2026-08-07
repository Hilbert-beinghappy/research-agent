// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AdapterCapabilitySnapshotV1Schema,
	AnalysisRuntimeResultV1Schema,
	ArtifactAdapterResultV1Schema,
	SourceSearchPageV1Schema,
} from "@research-agent/contracts/adapters";
import { Compile } from "typebox/compile";
import { canonicalizeJson } from "../contracts/canonical-json.ts";
import {
	type AdapterConformanceCheck,
	type AdapterConformanceReport,
	type AdapterKind,
	type AdapterPackageManifest,
	AdapterPackageManifestSchema,
	type JsonValue,
	type ResearchResult,
} from "../contracts/schemas.ts";
import { hashCanonicalJson, hashFile } from "../kernel/integrity.ts";
import { resolveProjectPathWithoutSymlinks, validatePortablePathSet } from "../kernel/paths.ts";
import { type AdapterProcessIsolation, runAdapterProcess } from "./runner.ts";

export type { AdapterConformanceCheck, AdapterConformanceReport } from "../contracts/schemas.ts";

const ManifestValidator = Compile(AdapterPackageManifestSchema);
const CapabilityValidator = Compile(AdapterCapabilitySnapshotV1Schema);
const ResultValidators = {
	source: Compile(SourceSearchPageV1Schema),
	analysis_runtime: Compile(AnalysisRuntimeResultV1Schema),
	artifact: Compile(ArtifactAdapterResultV1Schema),
} as const;
const PACKAGE_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

async function packageFiles(packageRoot: string, path = ""): Promise<{ path: string; hash: string; bytes: number }[]> {
	const files: { path: string; hash: string; bytes: number }[] = [];
	const directory =
		path === "" ? await realpath(packageRoot) : await resolveProjectPathWithoutSymlinks(packageRoot, path);
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const child = path === "" ? entry.name : `${path}/${entry.name}`;
		if (
			entry.name.startsWith("._") ||
			child === "adapter.json" ||
			child === "node_modules" ||
			child.startsWith("node_modules/")
		) {
			continue;
		}
		if (entry.isSymbolicLink()) throw new TypeError(`Adapter packages cannot contain symbolic links: ${child}`);
		const absolute = await resolveProjectPathWithoutSymlinks(packageRoot, child);
		const info = await lstat(absolute);
		if (info.isDirectory()) files.push(...(await packageFiles(packageRoot, child)));
		else if (info.isFile()) files.push({ path: child, hash: (await hashFile(absolute)).value, bytes: info.size });
		else throw new TypeError(`Adapter packages support regular files only: ${child}`);
	}
	return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export async function adapterPackageHash(packageRoot: string) {
	const files = await packageFiles(packageRoot);
	if (files.length === 0) throw new TypeError("Adapter package has no distributable files");
	validatePortablePathSet(files.map(({ path }) => path));
	return hashCanonicalJson(files);
}

export async function loadAdapterPackage(packageRoot: string): Promise<AdapterPackageManifest> {
	const manifest = canonicalizeJson(
		JSON.parse(await readFile(await resolveProjectPathWithoutSymlinks(packageRoot, "adapter.json"), "utf8")),
	);
	if (!ManifestValidator.Check(manifest)) throw new TypeError("Adapter manifest does not satisfy contract v1");
	if (!PACKAGE_ID_PATTERN.test(manifest.packageId))
		throw new TypeError(`Invalid Adapter package ID: ${manifest.packageId}`);
	if (new Set(manifest.capabilities.map(({ capability }) => capability)).size !== manifest.capabilities.length) {
		throw new TypeError("Adapter capabilities must be unique");
	}
	if (new Set(manifest.requiredBrokers).size !== manifest.requiredBrokers.length) {
		throw new TypeError("Adapter broker requirements must be unique");
	}
	if ((manifest.sbomPath === null) !== (manifest.sbomHash === null)) {
		throw new TypeError("Adapter SBOM path and hash must be provided together");
	}
	const entrypoint = await lstat(await resolveProjectPathWithoutSymlinks(packageRoot, manifest.entrypoint));
	if (!entrypoint.isFile()) throw new TypeError("Adapter entrypoint must be a regular file");
	if ((await adapterPackageHash(packageRoot)).value !== manifest.packageHash.value) {
		throw new TypeError("Adapter package hash mismatch");
	}
	if (
		manifest.sbomPath !== null &&
		manifest.sbomHash !== null &&
		(await hashFile(await resolveProjectPathWithoutSymlinks(packageRoot, manifest.sbomPath))).value !==
			manifest.sbomHash.value
	) {
		throw new TypeError("Adapter SBOM hash mismatch");
	}
	return manifest;
}

function methodFor(kind: AdapterKind): { method: string; payload: JsonValue } {
	if (kind === "source") {
		return {
			method: "search",
			payload: {
				queryText: "conformance fixture",
				filters: {},
				pageSize: 1,
				cursor: null,
				maxResults: 1,
				maxCost: null,
			},
		};
	}
	if (kind === "analysis_runtime") {
		return {
			method: "execute",
			payload: {
				runtime: "fixture",
				script: { path: "fixture/input", hash: null, mediaType: null, bytes: null },
				inputs: [],
				parameters: {},
				randomSeed: 7,
			},
		};
	}
	return {
		method: "render",
		payload: {
			artifactKind: "json",
			title: "Conformance fixture",
			sourceRecords: [],
			sourceFiles: [],
			options: {},
		},
	};
}

export async function runAdapterConformance(
	manifest: AdapterPackageManifest,
	invoke: (method: string, payload: JsonValue) => Promise<ResearchResult<JsonValue>>,
): Promise<AdapterConformanceReport> {
	const checks: AdapterConformanceCheck[] = [];
	const capabilities = await invoke("capabilities", null);
	const capabilityValue = capabilities.ok && CapabilityValidator.Check(capabilities.value) ? capabilities.value : null;
	checks.push({
		name: "capabilities",
		passed:
			capabilityValue !== null &&
			capabilityValue.adapterId === manifest.adapterId &&
			capabilityValue.adapterKind === manifest.adapterKind &&
			capabilityValue.contractVersion === "1" &&
			manifest.capabilities
				.filter(({ required }) => required)
				.every(({ capability }) => capabilityValue.capabilities.includes(capability)),
		message:
			capabilityValue === null ? "Capability response failed contract validation" : "Capability identity returned",
	});
	const operation = methodFor(manifest.adapterKind);
	const result = await invoke(operation.method, operation.payload);
	const operationPassed = result.ok && ResultValidators[manifest.adapterKind].Check(result.value);
	checks.push({
		name: operation.method,
		passed: operationPassed,
		message: operationPassed
			? `${operation.method} fixture completed`
			: result.ok
				? `${operation.method} result failed contract validation`
				: result.errors[0].message,
	});
	return {
		format: "pi-research-adapter-conformance",
		version: 1,
		packageId: manifest.packageId,
		packageVersion: manifest.packageVersion,
		packageHash: manifest.packageHash,
		manifestHash: hashCanonicalJson(manifest),
		adapterId: manifest.adapterId,
		adapterKind: manifest.adapterKind,
		passed: checks.every(({ passed }) => passed),
		checks,
	};
}

export async function conformAdapterPackage(
	packageRoot: string,
	isolation: AdapterProcessIsolation,
	expectedManifest?: AdapterPackageManifest,
) {
	const root = await realpath(packageRoot);
	const manifest = await loadAdapterPackage(root);
	if (
		expectedManifest !== undefined &&
		hashCanonicalJson(manifest).value !== hashCanonicalJson(expectedManifest).value
	) {
		throw new TypeError("Adapter package changed after approval");
	}
	if (!manifest.isolationProfiles.includes(isolation)) {
		throw new TypeError(`Adapter does not declare ${isolation}`);
	}
	const staging = await mkdtemp(join(tmpdir(), "pi-research-adapter-conformance-"));
	try {
		const entrypoint = await resolveProjectPathWithoutSymlinks(root, manifest.entrypoint);
		const report = await runAdapterConformance(manifest, async (method, payload) =>
			runAdapterProcess({
				launch: {
					executable: process.execPath,
					args: [entrypoint],
					cwd: staging,
					readRoots: [root],
					isolation,
				},
				request: {
					protocol: "pi-research-adapter-jsonl",
					version: 1,
					messageId: `conformance-${randomUUID()}`,
					type: "request",
					method,
					payload,
				},
				broker: async () => ({
					ok: false,
					value: null,
					error: {
						code: "CONFORMANCE_BROKER_DENIED",
						message: "Conformance fixtures do not grant broker access",
						retryable: false,
						details: null,
					},
				}),
				timeoutMs: 5_000,
				maxOutputBytes: 1_048_576,
			}),
		);
		return { manifest, report, packageHash: manifest.packageHash };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
