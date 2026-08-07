// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DomainPackageManifest } from "../../src/contracts/schemas.ts";
import { loadDomainPackage, loadDomainPackageById, resolveDomainResources } from "../../src/domain/packages.ts";

const domainPath = (domain: string): string =>
	fileURLToPath(new URL(`../../domains/${domain}/domain.json`, import.meta.url));

describe("research domain packages", () => {
	it("loads the four distributable manifests, including two additional disciplines", async () => {
		const manifests = await Promise.all(
			["management", "public-administration", "sociology", "political-science"].map((domain) =>
				loadDomainPackage(domainPath(domain)),
			),
		);

		expect(manifests.map(({ domainId }) => domainId)).toEqual([
			"management",
			"public-administration",
			"sociology",
			"political-science",
		]);
		expect(manifests.slice(2).every(({ resources }) => resources.length >= 3)).toBe(true);
	});

	it("uses higher precedence and rejects conflicting equal-precedence rules", async () => {
		const base = await loadDomainPackage(domainPath("management"));
		const original = base.resources[0];
		if (original === undefined) throw new Error("management domain package has no resources");
		const extension: DomainPackageManifest = {
			...base,
			packageId: "test-domain-extension",
			resources: [{ ...original, ruleId: "override", value: ["override"], precedence: original.precedence + 1 }],
		};

		expect(resolveDomainResources([base, extension])).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					packageId: "test-domain-extension",
					rule: expect.objectContaining({ ruleId: "override" }),
				}),
			]),
		);
		expect(() =>
			resolveDomainResources([
				base,
				{
					...extension,
					resources: [{ ...original, ruleId: "conflict", value: ["different"] }],
				},
			]),
		).toThrow("equal precedence");
	});

	it("loads two independently installed data-only packages without a core patch", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "pi-research-external-domains-"));
		try {
			const base = await loadDomainPackage(domainPath("management"));
			for (const packageId of ["research-domain-fixture-one", "research-domain-fixture-two"]) {
				const packageRoot = join(projectRoot, "node_modules", packageId);
				await mkdir(packageRoot, { recursive: true });
				await writeFile(
					join(packageRoot, "package.json"),
					JSON.stringify({ name: packageId, version: "1.0.0", exports: { "./domain.json": "./domain.json" } }),
				);
				await writeFile(
					join(packageRoot, "domain.json"),
					JSON.stringify({ ...base, packageId, packageVersion: "1.0.0", domainId: packageId }),
				);
				expect(await loadDomainPackageById(packageId, "1.0.0", projectRoot)).toMatchObject({
					packageId,
					packageVersion: "1.0.0",
				});
			}
			const invalidManifest = join(projectRoot, "invalid-domain.json");
			await writeFile(invalidManifest, JSON.stringify({ ...base, packageId: "../invalid" }));
			await expect(loadDomainPackage(invalidManifest)).rejects.toThrow("Invalid domain package ID");
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});
});
