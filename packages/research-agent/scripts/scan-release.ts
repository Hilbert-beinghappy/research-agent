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
	"GOVERNANCE.md",
	"LICENSE",
	"NOTICE",
	"README.md",
	"SBOM.spdx.json",
	"SECURITY.md",
	"THIRD_PARTY_NOTICES.md",
	"docs/adapter-capabilities.md",
	"docs/api.md",
	"docs/ai-disclosure-template.md",
	"docs/asset-provenance.md",
	"docs/cli.md",
	"docs/backup-restore.md",
	"docs/compatibility/pi-baselines.json",
	"docs/evaluation.md",
	"docs/install-upgrade-recovery.md",
	"docs/project-format.md",
	"docs/release-v0.1.md",
	"docs/release-v0.2.md",
	"docs/release-v0.3.md",
	"docs/release-v0.4.md",
	"docs/release-v0.5.md",
	"docs/release-v1.0.md",
	"docs/rfcs/0000-template.md",
	"docs/monitoring.md",
	"docs/review-rubrics.md",
	"docs/submission-gate.md",
	"docs/support-matrix.md",
	"docs/threat-model.md",
	"evals/rubrics/v0.1.json",
	"evals/rubrics/v0.2.json",
	"evals/rubrics/v0.3.json",
	"evals/rubrics/v0.4.json",
	"evals/rubrics/v0.5.json",
	"evals/rubrics/v1.0.json",
	"evals/v0.1/baselines/scenario-a-quality.json",
	"evals/v0.2/design-fixtures.json",
	"evals/v0.2/model-design-prompt.md",
	"evals/v0.2/baselines/deepseek-v4-flash-design-boundary.json",
	"evals/v0.2/baselines/design-method-boundary.json",
	"evals/v0.2/baselines/performance-darwin-arm64.json",
	"evals/v0.3/failure-injection.json",
	"evals/v0.3/qualitative-audit-gate.json",
	"evals/v0.3/model-method-prompt.md",
	"evals/v0.3/baselines/deepseek-v4-flash-method-boundary.json",
	"evals/v0.3/baselines/runtime-clean-room-darwin-arm64.json",
	"evals/v0.3/baselines/performance-darwin-arm64.json",
	"evals/v0.4/failure-cases.json",
	"evals/v0.4/model-writing-prompt.md",
	"evals/v0.4/baselines/deepseek-v4-flash-writing-boundary.json",
	"evals/v0.4/baselines/performance-darwin-arm64.json",
	"evals/v0.5/failure-cases.json",
	"evals/v0.5/model-adapter-monitor-prompt.md",
	"evals/v0.5/model-output.schema.json",
	"evals/v0.5/baselines/deepseek-v4-flash-adapter-monitor-boundary.json",
	"evals/v0.5/baselines/performance-darwin-arm64.json",
	"evals/v1.0/failure-cases.json",
	"evals/v1.0/model-output.schema.json",
	"evals/v1.0/model-recovery-routing-prompt.md",
	"evals/v1.0/scenario-d-gate.json",
	"evals/v1.0/baselines/deepseek-v4-flash-recovery-routing-boundary.json",
	"evals/v1.0/baselines/performance-darwin-arm64.json",
	"examples/README.md",
	"examples/algorithm-transparency-public-trust/README.md",
	"examples/algorithm-transparency-public-trust/request.json",
	"examples/digital-platform-governance/README.md",
	"examples/digital-platform-governance/request.json",
	"examples/public-sector-ai-accountability/README.md",
	"examples/public-sector-ai-accountability/request.json",
	"examples/research-design/quantitative.md",
	"examples/research-design/qualitative.md",
	"examples/quantitative-synthetic/README.md",
	"examples/quantitative-synthetic/data.csv",
	"examples/quantitative-synthetic/analysis.py",
	"examples/quantitative-synthetic/analysis.R",
	"examples/quantitative-synthetic/requirements.txt",
	"examples/quantitative-synthetic/renv.lock",
	"examples/qualitative-synthetic/README.md",
	"examples/qualitative-synthetic/interviews.txt",
	"examples/qualitative-synthetic/codebook.json",
	"examples/manuscripts/README.md",
	"examples/manuscripts/quantitative.md",
	"examples/manuscripts/qualitative.md",
	"examples/knowledge-vault/README.md",
	"examples/knowledge-vault/Research Index.md",
	"examples/knowledge-vault/Sources.base",
	"examples/knowledge-vault/profile.json",
	"examples/knowledge-vault/sources/Synthetic-governance-source--source_synthetic.md",
	"examples/knowledge-vault/evidence/evidence_synthetic.md",
	"examples/knowledge-vault/claims/claim_synthetic.md",
	"examples/long-running-projects/README.md",
	"examples/long-running-projects/projects.json",
	"schemas/v0.1/persisted-record.schema.json",
	"schemas/v0.1/research-result.schema.json",
	"schemas/v0.2/persisted-record.schema.json",
	"schemas/v0.2/research-result.schema.json",
	"schemas/v0.3/persisted-record.schema.json",
	"schemas/v0.3/research-result.schema.json",
	"schemas/v0.4/persisted-record.schema.json",
	"schemas/v0.4/research-result.schema.json",
	"schemas/v0.5/persisted-record.schema.json",
	"schemas/v0.5/project-catalog.schema.json",
	"schemas/v0.5/research-result.schema.json",
	"schemas/v1.0/persisted-record.schema.json",
	"schemas/v1.0/project-backup.schema.json",
	"schemas/v1.0/project-catalog.schema.json",
	"schemas/v1.0/research-result.schema.json",
	"scripts/benchmark-v0.1.ts",
	"scripts/benchmark-v0.2.ts",
	"scripts/benchmark-v0.3.ts",
	"scripts/benchmark-v0.4.ts",
	"scripts/benchmark-v0.5.ts",
	"scripts/benchmark-v1.0.ts",
	"scripts/evaluate-v0.2.ts",
	"scripts/evaluate-v0.3.ts",
	"scripts/evaluate-v0.4.ts",
	"scripts/evaluate-v0.5.ts",
	"scripts/evaluate-v1.0.ts",
	"scripts/generate-release-metadata.ts",
	"scripts/qualify-v0.3-runtimes.ts",
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
	"skills/academic-review/",
	"skills/academic-revision/",
	"skills/academic-writing/",
	"skills/literature-evidence/",
	"skills/literature-review/",
	"skills/research-design/",
	"skills/research-project-intake/",
	"skills/quantitative-research/",
	"skills/qualitative-research/",
	"skills/knowledge-export/",
	"skills/literature-monitoring/",
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
