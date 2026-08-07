// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	adapterPackageHash,
	conformAdapterPackage,
	loadAdapterPackage,
	runAdapterConformance,
} from "../../../src/adapters/conformance.ts";
import { canonicalStringify } from "../../../src/contracts/canonical-json.ts";
import type { AdapterKind, AdapterPackageManifest, JsonValue, ResearchResult } from "../../../src/contracts/schemas.ts";
import { hashCanonicalJson, hashFile } from "../../../src/kernel/integrity.ts";
import { validatePortablePathSet } from "../../../src/kernel/paths.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-research-adapter-contract-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function success(value: JsonValue): ResearchResult<JsonValue> {
	return { ok: true, status: "SUCCESS", value, errors: [], meta: { operationId: null, taskId: null, warnings: [] } };
}

async function createPackage(kind: AdapterKind): Promise<AdapterPackageManifest> {
	await writeFile(join(root, "entry.mjs"), "// independent adapter fixture\n");
	await writeFile(join(root, "SBOM.spdx.json"), "{}\n");
	const manifest: AdapterPackageManifest = {
		format: "pi-research-adapter-package",
		manifestVersion: 1,
		contractVersion: 1,
		packageId: `fixture-${kind}`,
		packageVersion: "1.0.0",
		adapterId: `fixture-${kind}`,
		adapterVersion: "1.0.0",
		adapterKind: kind,
		entrypoint: "entry.mjs",
		capabilities: [
			{
				capability: kind === "source" ? "search" : kind === "analysis_runtime" ? "execute" : "render",
				required: true,
				constraints: {},
			},
		],
		requiredBrokers: [],
		isolationProfiles: ["jsonl_process", "strong_isolation"],
		licenseExpression: "Apache-2.0",
		provenance: { source: "test fixture", repositoryUrl: null },
		packageHash: await adapterPackageHash(root),
		sbomPath: "SBOM.spdx.json",
		sbomHash: await hashFile(join(root, "SBOM.spdx.json")),
	};
	await writeFile(join(root, "adapter.json"), `${canonicalStringify(manifest)}\n`);
	return manifest;
}

function response(kind: AdapterKind, method: string): JsonValue {
	if (method === "capabilities") {
		return {
			adapterId: `fixture-${kind}`,
			adapterVersion: "1.0.0",
			adapterKind: kind,
			contractVersion: "1",
			capabilities: [kind === "source" ? "search" : kind === "analysis_runtime" ? "execute" : "render"],
			supportsPagination: kind === "source",
			supportsResumeCursor: false,
			mayCostMoney: false,
			maySendDataExternally: false,
			requiresCredentials: false,
			supportedIdentifiers: [],
			limits: {},
			generatedAt: "2026-08-07T00:00:00.000Z",
		};
	}
	if (kind === "source") {
		return {
			candidates: [],
			nextCursor: null,
			exhausted: true,
			rawResponse: { path: "response.json", hash: null, mediaType: "application/json", bytes: null },
			actualCost: { amount: 0, currency: "USD" },
		};
	}
	if (kind === "analysis_runtime") {
		return { status: "succeeded", outputs: [], logs: [], exitCode: 0 };
	}
	return {
		outputFile: { path: "artifact.json", hash: null, mediaType: "application/json", bytes: null },
		warnings: [],
	};
}

describe("Adapter contract v1 conformance", () => {
	it.each(["source", "analysis_runtime", "artifact"] as const)(
		"accepts an independent %s Adapter without a core patch",
		async (kind) => {
			await createPackage(kind);
			const loaded = await loadAdapterPackage(root);
			const report = await runAdapterConformance(loaded, async (method) => success(response(kind, method)));
			expect(report).toMatchObject({
				adapterKind: kind,
				packageId: loaded.packageId,
				packageVersion: loaded.packageVersion,
				packageHash: loaded.packageHash,
				manifestHash: hashCanonicalJson(loaded),
				passed: true,
			});
			expect(report.checks.every(({ passed }) => passed)).toBe(true);
		},
	);

	it("rejects a package that changed after approval", async () => {
		const manifest = await createPackage("source");
		await expect(
			conformAdapterPackage(root, "jsonl_process", { ...manifest, requiredBrokers: ["http"] }),
		).rejects.toThrow("Adapter package changed after approval");
	});

	it("rejects traversal, package tampering, and SBOM mismatch", async () => {
		const manifest = await createPackage("source");
		await writeFile(
			join(root, "adapter.json"),
			`${canonicalStringify({ ...manifest, entrypoint: "../escape.mjs" })}\n`,
		);
		await expect(loadAdapterPackage(root)).rejects.toThrow("contract v1");

		await writeFile(join(root, "adapter.json"), `${canonicalStringify(manifest)}\n`);
		await writeFile(join(root, "entry.mjs"), "// tampered\n");
		await expect(loadAdapterPackage(root)).rejects.toThrow("package hash mismatch");

		const restored = await createPackage("source");
		await writeFile(
			join(root, "adapter.json"),
			`${canonicalStringify({ ...restored, sbomHash: { algorithm: "sha256", value: "0".repeat(64) } })}\n`,
		);
		await expect(loadAdapterPackage(root)).rejects.toThrow("SBOM hash mismatch");
	});

	it("rejects symbolic links and case-colliding package paths", async () => {
		await writeFile(join(root, "entry.mjs"), "// fixture\n");
		await symlink(join(root, "entry.mjs"), join(root, "linked.mjs"));
		await expect(adapterPackageHash(root)).rejects.toThrow("symbolic links");
		await rm(join(root, "linked.mjs"));
		await Promise.all([writeFile(join(root, "README"), "one"), writeFile(join(root, "readme"), "two")]);
		if ((await readdir(root)).includes("README") && (await readdir(root)).includes("readme")) {
			await expect(adapterPackageHash(root)).rejects.toThrow(/collid/u);
		} else {
			expect(() => validatePortablePathSet(["README", "readme"])).toThrow(/collid/u);
		}
	});

	it("fails conformance when a method returns a schema-invalid success", async () => {
		await createPackage("artifact");
		const manifest = await loadAdapterPackage(root);
		const report = await runAdapterConformance(manifest, async (method) =>
			success(method === "capabilities" ? response("artifact", method) : { outputFile: null }),
		);
		expect(report).toMatchObject({ passed: false, checks: [expect.anything(), { passed: false }] });
	});
});
