// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface LockEntry {
	name?: string;
	version?: string;
	resolved?: string;
	integrity?: string;
	license?: string;
	link?: boolean;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

interface Lockfile {
	packages: Record<string, LockEntry>;
}

interface PackageManifest {
	name: string;
	version: string;
	license: string;
	dependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
}

interface QualityBaseline {
	evaluatedAt: string;
}

interface RuntimePackage {
	path: string;
	name: string;
	version: string;
	license: string;
	resolved: string | null;
	integrity: string | null;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workspacePath = "packages/research-agent";
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
const lockfile = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8")) as Lockfile;
const qualityBaseline = JSON.parse(
	readFileSync(join(packageRoot, "evals/v0.1/baselines/scenario-a-quality.json"), "utf8"),
) as QualityBaseline;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function packageName(path: string, entry: LockEntry): string {
	if (entry.name !== undefined) return entry.name;
	const marker = path.lastIndexOf("node_modules/");
	if (marker < 0) throw new Error(`Lock entry has no package name: ${path}`);
	return path.slice(marker + "node_modules/".length);
}

function dependencyPath(fromPath: string, name: string): string {
	let current = fromPath;
	while (current.length > 0) {
		const nested = `${current}/node_modules/${name}`;
		const entry = lockfile.packages[nested];
		if (entry !== undefined) return entry.link && entry.resolved !== undefined ? entry.resolved : nested;
		const parentMarker = current.lastIndexOf("/node_modules/");
		current = parentMarker < 0 ? "" : current.slice(0, parentMarker);
	}
	const root = `node_modules/${name}`;
	const entry = lockfile.packages[root];
	if (entry === undefined) throw new Error(`Runtime dependency is absent from package-lock.json: ${name}`);
	return entry.link && entry.resolved !== undefined ? entry.resolved : root;
}

const rootEntry = lockfile.packages[workspacePath];
if (rootEntry === undefined) throw new Error("Research Agent workspace entry is absent from package-lock.json");
const queue = [workspacePath];
const visited = new Set<string>();
const relationships = new Set<string>();
while (queue.length > 0) {
	const path = queue.shift();
	if (path === undefined || visited.has(path)) continue;
	visited.add(path);
	const entry = lockfile.packages[path];
	if (entry === undefined) throw new Error(`Missing lock entry: ${path}`);
	const dependencies = { ...entry.dependencies, ...entry.optionalDependencies };
	for (const name of Object.keys(dependencies).sort()) {
		const child = dependencyPath(path, name);
		relationships.add(`${path}\u0000${child}`);
		queue.push(child);
	}
}

const runtimePackages: RuntimePackage[] = [...visited]
	.map((path) => {
		const entry = lockfile.packages[path];
		if (entry === undefined) throw new Error(`Missing lock entry: ${path}`);
		const name = path === workspacePath ? manifest.name : packageName(path, entry);
		const version = path === workspacePath ? manifest.version : entry.version;
		const license = path === workspacePath ? manifest.license : entry.license;
		if (version === undefined) throw new Error(`Package version is unknown: ${name}`);
		if (license === undefined || license.trim().length === 0)
			throw new Error(`Package license is unknown: ${name}@${version}`);
		return {
			path,
			name,
			version,
			license,
			resolved: entry.resolved ?? null,
			integrity: entry.integrity ?? null,
		};
	})
	.sort((left, right) =>
		left.name !== right.name
			? left.name.localeCompare(right.name)
			: left.version !== right.version
				? left.version.localeCompare(right.version)
				: left.path.localeCompare(right.path),
	);

function spdxId(runtimePackage: RuntimePackage): string {
	const label = `${runtimePackage.name}-${runtimePackage.version}`.replace(/[^A-Za-z0-9.-]+/gu, "-");
	return `SPDXRef-Package-${label}-${digest(runtimePackage.path).slice(0, 12)}`;
}

const byPath = new Map(runtimePackages.map((runtimePackage) => [runtimePackage.path, runtimePackage]));
const relationshipRows = [...relationships].sort().map((edge) => {
	const [fromPath, toPath] = edge.split("\u0000");
	const from = fromPath === undefined ? undefined : byPath.get(fromPath);
	const to = toPath === undefined ? undefined : byPath.get(toPath);
	if (from === undefined || to === undefined) throw new Error(`Invalid dependency edge: ${edge}`);
	return { spdxElementId: spdxId(from), relationshipType: "DEPENDS_ON", relatedSpdxElement: spdxId(to) };
});
const rootPackage = byPath.get(workspacePath);
if (rootPackage === undefined) throw new Error("SBOM root package is missing");
const created = new Date(`${qualityBaseline.evaluatedAt}T00:00:00.000Z`).toISOString();
const namespaceHash = digest(
	JSON.stringify({
		packages: runtimePackages.map(({ path, name, version, license, integrity }) => ({
			path,
			name,
			version,
			license,
			integrity,
		})),
		relationships: relationshipRows,
	}),
);
const sbom = {
	spdxVersion: "SPDX-2.3",
	dataLicense: "CC0-1.0",
	SPDXID: "SPDXRef-DOCUMENT",
	name: `${manifest.name}-${manifest.version}`,
	documentNamespace: `https://spdx.org/spdxdocs/${manifest.name}-${manifest.version}-${namespaceHash}`,
	creationInfo: {
		created,
		creators: ["Tool: pi-research-agent generate-release-metadata"],
	},
	packages: runtimePackages.map((runtimePackage) => ({
		SPDXID: spdxId(runtimePackage),
		name: runtimePackage.name,
		versionInfo: runtimePackage.version,
		downloadLocation: runtimePackage.resolved ?? "NOASSERTION",
		filesAnalyzed: false,
		licenseConcluded: runtimePackage.license,
		licenseDeclared: runtimePackage.license,
		copyrightText: "NOASSERTION",
		externalRefs: [
			{
				referenceCategory: "PACKAGE-MANAGER",
				referenceType: "purl",
				referenceLocator: `pkg:npm/${encodeURIComponent(runtimePackage.name)}@${runtimePackage.version}`,
			},
		],
		...(runtimePackage.integrity === null ? {} : { packageComment: `npm integrity: ${runtimePackage.integrity}` }),
	})),
	relationships: [
		{
			spdxElementId: "SPDXRef-DOCUMENT",
			relationshipType: "DESCRIBES",
			relatedSpdxElement: spdxId(rootPackage),
		},
		...relationshipRows,
	],
};

const dependencyRows = runtimePackages
	.filter(({ path }) => path !== workspacePath)
	.map(
		({ name, version, license, resolved }) =>
			`| ${name} | ${version} | ${license} | ${resolved === null ? "lockfile" : `[npm](${resolved})`} |`,
	);
const peerRows = Object.entries(manifest.peerDependencies)
	.sort(([left], [right]) => left.localeCompare(right))
	.map(([name, version]) => `| ${name} | ${version} | Host-provided; not bundled |`);
const notices = `# Third-party notices

Generated from the production dependency closure in the repository package lock. Development dependencies and host-provided peer dependencies are not bundled with Pi Research Agent.

## Runtime dependency closure

| Package | Version | Declared license | Locked source |
|---|---:|---|---|
${dependencyRows.join("\n")}

## Host peer dependencies

| Package | Range | Distribution status |
|---|---:|---|
${peerRows.join("\n")}

The authoritative license text for each dependency is distributed with that dependency. Pi Research Agent itself is licensed under Apache-2.0.
`;
const outputs = new Map([
	[join(packageRoot, "SBOM.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`],
	[join(packageRoot, "THIRD_PARTY_NOTICES.md"), notices],
]);
if (process.argv.includes("--check")) {
	for (const [path, expected] of outputs) {
		let actual: string;
		try {
			actual = readFileSync(path, "utf8");
		} catch {
			throw new Error(`Release metadata is missing: ${path.slice(packageRoot.length)}`);
		}
		if (actual !== expected) throw new Error(`Release metadata is stale: ${path.slice(packageRoot.length)}`);
	}
} else {
	for (const [path, content] of outputs) writeFileSync(path, content);
}
