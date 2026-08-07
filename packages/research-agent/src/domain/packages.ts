// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type DomainPackageManifest,
	DomainPackageManifestSchema,
	type DomainResourceRule,
} from "../contracts/schemas.ts";

const DomainPackageValidator = Compile(DomainPackageManifestSchema);
const PACKAGE_ID_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
export const BUILT_IN_DOMAIN_PACKAGE_VERSION = "1.1.0";
const BUILT_IN_DOMAIN_PATHS = new Map([
	["pi-research-domain-management", fileURLToPath(new URL("../../domains/management/domain.json", import.meta.url))],
	[
		"pi-research-domain-public-administration",
		fileURLToPath(new URL("../../domains/public-administration/domain.json", import.meta.url)),
	],
	["pi-research-domain-sociology", fileURLToPath(new URL("../../domains/sociology/domain.json", import.meta.url))],
	[
		"pi-research-domain-political-science",
		fileURLToPath(new URL("../../domains/political-science/domain.json", import.meta.url)),
	],
]);

export const BUILT_IN_DOMAIN_PACKAGE_IDS: ReadonlySet<string> = new Set(BUILT_IN_DOMAIN_PATHS.keys());

export interface ResolvedDomainResource {
	resourceType: string;
	key: string;
	rule: DomainResourceRule;
	packageId: string;
	packageVersion: string;
}

export async function loadDomainPackage(path: string): Promise<DomainPackageManifest> {
	const value = canonicalizeJson(JSON.parse(await readFile(path, "utf8")));
	if (!DomainPackageValidator.Check(value)) throw new TypeError(`Invalid domain package manifest: ${path}`);
	if (!PACKAGE_ID_PATTERN.test(value.packageId)) throw new TypeError(`Invalid domain package ID: ${value.packageId}`);
	const ruleIds = value.resources.map(({ ruleId }) => ruleId);
	if (new Set(ruleIds).size !== ruleIds.length) throw new TypeError(`Duplicate domain resource rule ID: ${path}`);
	return value;
}

export async function loadDomainPackageById(
	packageId: string,
	packageVersion: string,
	projectRoot: string,
): Promise<DomainPackageManifest> {
	if (!PACKAGE_ID_PATTERN.test(packageId)) throw new TypeError(`Invalid domain package ID: ${packageId}`);
	const builtInPath = BUILT_IN_DOMAIN_PATHS.get(packageId);
	const path = builtInPath ?? createRequire(join(projectRoot, "package.json")).resolve(`${packageId}/domain.json`);
	const manifest = await loadDomainPackage(path);
	if (manifest.packageId !== packageId || manifest.packageVersion !== packageVersion) {
		throw new TypeError(`Domain package identity mismatch: expected ${packageId}@${packageVersion}`);
	}
	return manifest;
}

export function resolveDomainResources(packages: readonly DomainPackageManifest[]): ResolvedDomainResource[] {
	const resolved = new Map<string, ResolvedDomainResource>();
	for (const manifest of packages) {
		for (const rule of manifest.resources) {
			const key = `${rule.resourceType}:${rule.key}`;
			const current = resolved.get(key);
			if (current === undefined || rule.precedence > current.rule.precedence) {
				resolved.set(key, {
					resourceType: rule.resourceType,
					key: rule.key,
					rule,
					packageId: manifest.packageId,
					packageVersion: manifest.packageVersion,
				});
				continue;
			}
			if (
				rule.precedence === current.rule.precedence &&
				canonicalStringify(rule.value) !== canonicalStringify(current.rule.value)
			) {
				throw new TypeError(`Domain resource conflict at equal precedence: ${key}`);
			}
		}
	}
	return [...resolved.values()].sort(
		(left, right) =>
			left.resourceType.localeCompare(right.resourceType) ||
			left.key.localeCompare(right.key) ||
			left.packageId.localeCompare(right.packageId),
	);
}
