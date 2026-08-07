// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import type { ExchangeBundleManifest } from "../../src/contracts/schemas.ts";
import { packProjectExchange, readProjectExchange, unpackProjectExchange } from "../../src/exchange/bundle.ts";
import { hashCanonicalJson, hashFile } from "../../src/kernel/integrity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { validateProject } from "../../src/project/validate.ts";

let root: string;
let project: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-research-exchange-"));
	project = join(root, "project");
	await initializeProject(project, { title: "Portable research project" });
	await Promise.all([
		writeFile(join(project, "artifacts/final/review.md"), "# Reproducible result\n"),
		writeFile(join(project, "sources/originals/restricted.pdf"), "restricted fixture"),
		writeFile(join(project, "sources/imports/library.ris"), "TY  - JOUR\nER  -\n"),
	]);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function rewriteManifest(bundle: string, update: (manifest: ExchangeBundleManifest) => ExchangeBundleManifest) {
	const manifest = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as ExchangeBundleManifest;
	await writeFile(join(bundle, "bundle.json"), `${canonicalStringify(update(manifest))}\n`);
}

describe("project exchange bundle v1", () => {
	it("packs, verifies, imports, and reopens a signed project without raw material by default", async () => {
		const bundle = join(root, "exchange");
		const destination = join(root, "imported");
		const { privateKey } = generateKeyPairSync("ed25519");
		const originalArtifactHash = await hashFile(join(project, "artifacts/final/review.md"));
		const manifest = await packProjectExchange(project, bundle, { signingKey: privateKey });

		expect(manifest).toMatchObject({ includesRawMaterials: false, signature: { algorithm: "ed25519" } });
		expect(manifest.files.map(({ path }) => path)).toContain("artifacts/final/review.md");
		expect(manifest.files.some(({ path }) => path.startsWith("sources/originals/"))).toBe(false);
		expect(manifest.files.some(({ path }) => path.startsWith("sources/imports/"))).toBe(false);
		await expect(readProjectExchange(bundle)).resolves.toMatchObject({ bundleId: manifest.bundleId });
		await unpackProjectExchange(bundle, destination);
		await expect(openProject(destination)).resolves.toMatchObject({ compatibility: "current" });
		await expect(validateProject(destination)).resolves.toMatchObject({ valid: true });
		await expect(lstat(join(destination, ".research/records/documents"))).resolves.toMatchObject({});
		expect(await hashFile(join(destination, "artifacts/final/review.md"))).toEqual(originalArtifactHash);
		await expect(lstat(join(destination, "sources/originals/restricted.pdf"))).rejects.toThrow();
	});

	it("includes raw material only when explicitly requested", async () => {
		const manifest = await packProjectExchange(project, join(root, "raw-exchange"), { includeRawMaterials: true });
		expect(manifest.includesRawMaterials).toBe(true);
		expect(manifest.files.map(({ path }) => path)).toEqual(
			expect.arrayContaining(["sources/originals/restricted.pdf", "sources/imports/library.ris"]),
		);
	});

	it("rejects content, signature, traversal, case-collision, and symlink tampering", async () => {
		const contentBundle = join(root, "content-tamper");
		await packProjectExchange(project, contentBundle);
		await writeFile(join(contentBundle, "files/artifacts/final/review.md"), "tampered");
		await expect(readProjectExchange(contentBundle)).rejects.toThrow("file mismatch");

		const signatureBundle = join(root, "signature-tamper");
		const { privateKey } = generateKeyPairSync("ed25519");
		await packProjectExchange(project, signatureBundle, { signingKey: privateKey });
		await rewriteManifest(signatureBundle, (manifest) => ({
			...manifest,
			projectRevision: manifest.projectRevision + 1,
		}));
		await expect(readProjectExchange(signatureBundle)).rejects.toThrow("signature");

		const traversalBundle = join(root, "traversal-tamper");
		await packProjectExchange(project, traversalBundle);
		await rewriteManifest(traversalBundle, (manifest) => ({
			...manifest,
			files: [{ ...manifest.files[0]!, path: "../escape" }, ...manifest.files.slice(1)],
		}));
		await expect(readProjectExchange(traversalBundle)).rejects.toThrow("manifest is invalid");

		const collisionBundle = join(root, "collision-tamper");
		await packProjectExchange(project, collisionBundle);
		await rewriteManifest(collisionBundle, (manifest) => {
			const first = manifest.files[0]!;
			const files = [first, { ...first, path: first.path.toUpperCase() }, ...manifest.files.slice(1)];
			return { ...manifest, files, rootHash: hashCanonicalJson(files), signature: null };
		});
		await expect(readProjectExchange(collisionBundle)).rejects.toThrow(/collid/u);

		const symlinkBundle = join(root, "symlink-tamper");
		await packProjectExchange(project, symlinkBundle);
		const source = join(symlinkBundle, "files/artifacts/final/review.md");
		const alias = join(symlinkBundle, "aliased/review.md");
		await mkdir(dirname(alias), { recursive: true });
		await copyFile(source, alias);
		await rm(join(symlinkBundle, "files/artifacts"), { recursive: true });
		await symlink(join(symlinkBundle, "aliased"), join(symlinkBundle, "files/artifacts"));
		await expect(readProjectExchange(symlinkBundle)).rejects.toThrow("symbolic link");
	});

	it("remains readable when an optional Adapter is unavailable", async () => {
		const bundle = join(root, "optional-adapter");
		await packProjectExchange(project, bundle);
		await rewriteManifest(bundle, (manifest) => ({
			...manifest,
			requiredAdapters: [
				{
					packageId: "optional-missing-adapter",
					packageVersion: "1.0.0",
					packageHash: null,
					manifestHash: null,
				},
			],
		}));
		await expect(unpackProjectExchange(bundle, join(root, "without-adapter"))).resolves.toMatchObject({
			requiredAdapters: [{ packageId: "optional-missing-adapter" }],
		});
	});
});
