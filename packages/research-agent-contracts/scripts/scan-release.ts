// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackResult {
	entryCount: number;
	files: Array<{ path: string; size: number }>;
}

interface PackageManifest {
	exports: Record<string, string | { import: string; types: string }>;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npm, ["pack", "--dry-run", "--json"], {
	cwd: packageRoot,
	encoding: "utf8",
	maxBuffer: 4 * 1024 * 1024,
	shell: process.platform === "win32",
});
if (packed.status !== 0) throw new Error(`npm pack failed with exit code ${packed.status ?? "unknown"}`);
const result = (JSON.parse(packed.stdout) as PackResult[])[0];
if (result === undefined) throw new Error("npm pack returned no package result");
const paths = new Set(result.files.map(({ path }) => path));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
for (const [subpath, target] of Object.entries(manifest.exports)) {
	if (typeof target === "string") {
		if (subpath !== "./package.json" || target !== "./package.json") {
			throw new Error(`Unexpected string export: ${subpath}`);
		}
		continue;
	}
	if (!target.import.startsWith("./dist/") || !target.types.startsWith("./dist/")) {
		throw new Error(`Contracts export is not compiled: ${subpath}`);
	}
}
for (const path of [
	"LICENSE",
	"README.md",
	"package.json",
	"dist/index.d.ts",
	"dist/index.js",
	"dist/adapter-protocol.d.ts",
	"dist/adapter-protocol.js",
	"dist/adapters.d.ts",
	"dist/adapters.js",
	"dist/sdk-rpc.d.ts",
	"dist/sdk-rpc.js",
	"dist/schemas.d.ts",
	"dist/schemas.js",
	"dist/validators.d.ts",
	"dist/validators.js",
	"schemas/v1.5/adapter-package.schema.json",
	"schemas/v1.5/adapter-protocol.schema.json",
	"schemas/v1.5/exchange-bundle.schema.json",
	"schemas/v1.5/collaboration-change-set.schema.json",
	"schemas/v1.5/model-route-decision.schema.json",
	"schemas/v2.0/research-rpc-request.schema.json",
	"schemas/v2.0/research-rpc-response.schema.json",
	"schemas/v2.0/research-sdk-capabilities.schema.json",
]) {
	if (!paths.has(path)) throw new Error(`Contracts release is missing: ${path}`);
}
const sensitivePatterns: Array<[string, RegExp]> = [
	["AppleDouble", /(^|\/)\._/u],
	["private config", /(^|\/)(?:deepseek\.json|\.env(?:\.|$))/u],
	["personal path", /\/(?:Users|Volumes)\/[^/\s"']+/u],
	["secret", /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}\b/u],
];
if ([...paths].some((path) => path.startsWith("src/"))) {
	throw new Error("TypeScript source entered contracts release");
}
let scannedBytes = 0;
for (const file of result.files) {
	for (const [label, pattern] of sensitivePatterns) {
		if (pattern.test(file.path)) throw new Error(`${label} path entered contracts release: ${file.path}`);
	}
	const bytes = readFileSync(join(packageRoot, file.path));
	scannedBytes += bytes.byteLength;
	if (bytes.includes(0)) continue;
	const text = bytes.toString("utf8");
	if (
		file.path.endsWith(".ts") &&
		!file.path.endsWith(".d.ts") &&
		!text.startsWith("// SPDX-License-Identifier: Apache-2.0\n")
	) {
		throw new Error(`Source file is missing an Apache-2.0 SPDX header: ${file.path}`);
	}
	for (const [label, pattern] of sensitivePatterns.slice(2)) {
		if (pattern.test(text)) throw new Error(`${label} detected in contracts release: ${file.path}`);
	}
}
process.stdout.write(
	`${JSON.stringify({ status: "passed", entryCount: result.entryCount, scannedBytes, schemas: 17 }, null, 2)}\n`,
);
