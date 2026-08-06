// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackFile {
	path: string;
	size: number;
}

interface PackResult {
	entryCount: number;
	files: PackFile[];
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npm, ["pack", "--dry-run", "--json"], {
	cwd: packageRoot,
	encoding: "utf8",
	maxBuffer: 8 * 1024 * 1024,
});
if (packed.status !== 0) throw new Error(`npm pack failed with exit code ${packed.status ?? "unknown"}`);
const results = JSON.parse(packed.stdout) as PackResult[];
const result = results[0];
if (result === undefined) throw new Error("npm pack returned no package result");

const requiredPaths = [
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"LICENSE",
	"NOTICE",
	"README.md",
	"SBOM.spdx.json",
	"SECURITY.md",
	"THIRD_PARTY_NOTICES.md",
	"docs/adapter-capabilities.md",
	"docs/asset-provenance.md",
	"docs/cli.md",
	"docs/evaluation.md",
	"docs/project-format.md",
	"docs/release-v0.1.md",
	"docs/threat-model.md",
	"evals/rubrics/v0.1.json",
	"evals/v0.1/baselines/scenario-a-quality.json",
	"examples/README.md",
	"examples/algorithm-transparency-public-trust/README.md",
	"examples/algorithm-transparency-public-trust/request.json",
	"examples/digital-platform-governance/README.md",
	"examples/digital-platform-governance/request.json",
	"examples/public-sector-ai-accountability/README.md",
	"examples/public-sector-ai-accountability/request.json",
	"schemas/v0.1/persisted-record.schema.json",
	"scripts/benchmark-v0.1.ts",
	"scripts/generate-release-metadata.ts",
	"scripts/scan-release.ts",
	"scripts/test-clean-install.ts",
	"test/fixtures/projects/scenario-a/topics.json",
];
const paths = new Set(result.files.map(({ path }) => path));
for (const path of requiredPaths) {
	if (!paths.has(path)) throw new Error(`Release package is missing: ${path}`);
}

const forbiddenPathPatterns = [
	/(^|\/)\._/u,
	/(^|\/)\.env(?:\.|$)/u,
	/(^|\/)deepseek\.json$/u,
	/(^|\/)(?:task_plan|findings|progress)\.md$/u,
	/(^|\/)test\/(?:unit|integration|e2e|compat|contracts)\//u,
	/(^|\/)(?:node_modules|coverage|dist)\//u,
];
const allowedSkillPrefixes = [
	"skills/literature-evidence/",
	"skills/literature-review/",
	"skills/research-project-intake/",
];
for (const path of paths) {
	if (forbiddenPathPatterns.some((pattern) => pattern.test(path))) throw new Error(`Forbidden release path: ${path}`);
	if (path.startsWith("skills/") && !allowedSkillPrefixes.some((prefix) => path.startsWith(prefix))) {
		throw new Error(`Unreviewed Skill entered the release: ${path}`);
	}
}

const sensitiveTextPatterns: Array<[string, RegExp]> = [
	["macOS personal path", /\/(?:Users|Volumes)\/[^/\s"']+/u],
	["Windows personal path", /[A-Za-z]:\\Users\\[^\\\s"']+/u],
	["private key", /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/u],
	["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/u],
	["GitHub token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/u],
	["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/u],
	["hard-coded bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*\b/u],
];
let scannedBytes = 0;
for (const file of result.files) {
	const bytes = readFileSync(join(packageRoot, file.path));
	scannedBytes += bytes.byteLength;
	if (bytes.includes(0)) continue;
	const text = bytes.toString("utf8");
	if (file.path.endsWith(".ts") && !text.startsWith("// SPDX-License-Identifier: Apache-2.0\n")) {
		throw new Error(`Source file is missing an Apache-2.0 SPDX header: ${file.path}`);
	}
	for (const [label, pattern] of sensitiveTextPatterns) {
		if (pattern.test(text)) throw new Error(`${label} detected in release file: ${file.path}`);
	}
}

const sbom = JSON.parse(readFileSync(join(packageRoot, "SBOM.spdx.json"), "utf8")) as {
	spdxVersion?: string;
	packages?: Array<{ licenseDeclared?: string }>;
};
if (sbom.spdxVersion !== "SPDX-2.3" || sbom.packages === undefined || sbom.packages.length === 0) {
	throw new Error("SPDX SBOM is missing or invalid");
}
if (sbom.packages.some(({ licenseDeclared }) => licenseDeclared === undefined || licenseDeclared === "NOASSERTION")) {
	throw new Error("SPDX SBOM contains an unknown declared license");
}

process.stdout.write(
	`${JSON.stringify(
		{
			status: "passed",
			entryCount: result.entryCount,
			scannedBytes,
			spdxPackages: sbom.packages.length,
			skills: allowedSkillPrefixes.map((prefix) => prefix.slice("skills/".length, -1)),
		},
		null,
		2,
	)}\n`,
);
