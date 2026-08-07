// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdapterPackage } from "../src/adapters/conformance.ts";

interface IsolationBaseline {
	status: string;
	profile: string;
	checks: Record<string, boolean>;
	acceptedNetworkConnections: number;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const testPath = join(packageRoot, "test/e2e/scenario-e.test.ts");
const adapterRoot = join(packageRoot, "examples/adapters/community-http-source");
const isolationPath = join(packageRoot, "evals/v1.5/baselines/strong-isolation-darwin-arm64.json");

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

if (process.platform !== "darwin") throw new Error("Scenario E strong-isolation qualification requires macOS");
const isolation = JSON.parse(await readFile(isolationPath, "utf8")) as IsolationBaseline;
const adapter = await loadAdapterPackage(adapterRoot);
const test = spawnSync(
	process.execPath,
	[join(repositoryRoot, "node_modules/vitest/dist/cli.js"), "--run", "test/e2e/scenario-e.test.ts"],
	{ cwd: packageRoot, encoding: "utf8", maxBuffer: 8 * 1_024 * 1_024 },
);
const isolationPassed =
	isolation.status === "passed" &&
	isolation.profile === "strong_isolation" &&
	isolation.acceptedNetworkConnections === 0 &&
	Object.values(isolation.checks).every(Boolean);
const checks = {
	publicAdapterPackageVerified:
		adapter.packageId === "community-http-source" && adapter.requiredBrokers.includes("http"),
	approvalRequiredBeforeHttpBrokerSuccess: test.status === 0,
	adapterDenialAndCrashDoNotBreakCore: test.status === 0,
	sdkRemainsUsableAfterAdapterCrash: test.status === 0,
	directNetworkPrivateReadProjectWriteCredentialAndSubprocessDenied: isolationPassed,
};
const passed = Object.values(checks).every(Boolean);
const report = {
	qualification: "pi-research-agent-v2.0-scenario-e",
	generatedAt: new Date().toISOString(),
	platform: `${process.platform}-${process.arch}`,
	node: process.version,
	input: {
		testSha256: sha256(await readFile(testPath)),
		adapterPackageHash: adapter.packageHash.value,
		isolationBaselineSha256: sha256(await readFile(isolationPath)),
	},
	checks,
	usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	status: passed ? "passed" : "failed",
};
const output = `${JSON.stringify(report, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
	const outputPath = process.argv[outputIndex + 1];
	if (outputPath === undefined) throw new TypeError("--output requires a path");
	const absolutePath = resolve(process.cwd(), outputPath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, output);
}
process.stdout.write(output);
if (!passed) {
	if (test.stderr.trim() !== "") process.stderr.write(test.stderr);
	process.exitCode = 1;
}
