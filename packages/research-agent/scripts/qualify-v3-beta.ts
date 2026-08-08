// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_SCHEMA_VERSION } from "@research-agent/contracts/memory";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../src/contracts/integrity.ts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { evaluateMemoryLongitudinalDataset } from "../src/memory/evaluation.ts";
import { RESEARCH_AGENT_SDK_VERSION } from "../src/sdk/index.ts";
import { RESEARCH_AGENT_PACKAGE_VERSION } from "../src/version.ts";

interface PackageManifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
}

interface QualificationBaseline {
	qualification: string;
	platform: string;
	configuration: Record<string, unknown>;
	input: Record<string, string>;
	checks: Record<string, boolean>;
	status: string;
}

interface Sbom {
	name?: string;
	packages?: Array<{ name?: string; versionInfo?: string }>;
}

interface CompatibilityMatrix {
	researchAgentVersion?: string;
	packageLanes?: Array<{ piVersion?: string; blocking?: boolean }>;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const contractsRoot = join(repositoryRoot, "packages/research-agent-contracts");
const memorySchemaNames = [
	"encrypted-transfer-envelope",
	"memory-candidate-draft",
	"memory-deletion-tombstone",
	"memory-feedback",
	"memory-item",
	"memory-snapshot-manifest",
	"memory-use-receipt",
	"preference-signal",
	"researcher-profile",
] as const;

async function json<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function fileHash(path: string): Promise<string> {
	return hashBytes(await readFile(path)).value;
}

function gitValue(args: string[]): string {
	const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function allTrue(checks: Record<string, boolean>): boolean {
	return Object.keys(checks).length > 0 && Object.values(checks).every(Boolean);
}

let outputPath: string | null = null;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
	const argument = args[index];
	if (argument === "--output" && outputPath === null) {
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) throw new TypeError("--output requires a path");
		outputPath = resolve(process.cwd(), value);
		index += 1;
		continue;
	}
	throw new TypeError("usage: qualify-v3-beta.ts [--output <path>]");
}

const [
	agentManifest,
	contractsManifest,
	lockfile,
	storeBaseline,
	retrievalBaseline,
	longitudinalInput,
	expectedLongitudinal,
	sbom,
	transferVector,
	compatibilityMatrix,
] = await Promise.all([
	json<PackageManifest>(join(packageRoot, "package.json")),
	json<PackageManifest>(join(contractsRoot, "package.json")),
	json<{ packages: Record<string, { version?: string }> }>(join(repositoryRoot, "package-lock.json")),
	json<QualificationBaseline>(join(packageRoot, "evals/v3/baselines/memory-store-darwin-arm64.json")),
	json<QualificationBaseline>(join(packageRoot, "evals/v3/baselines/memory-retrieval-darwin-arm64.json")),
	json<unknown>(join(packageRoot, "evals/v3/memory-longitudinal-golden.json")),
	json<unknown>(join(packageRoot, "evals/v3/baselines/memory-longitudinal-synthetic.json")),
	json<Sbom>(join(packageRoot, "SBOM.spdx.json")),
	json<{
		format?: string;
		version?: number;
		cipher?: string;
		kdf?: { name?: string; N?: number; r?: number; p?: number; maxmem?: number };
	}>(join(packageRoot, "evals/v3/memory-transfer-v1-crypto-vector.json")),
	json<CompatibilityMatrix>(join(packageRoot, "docs/compatibility/pi-baselines.json")),
]);

const schemaManifest = await Promise.all(
	memorySchemaNames.map(async (name) => {
		const path = `schemas/memory/v1.0/${name}.schema.json`;
		return { path, sha256: await fileHash(join(contractsRoot, ...path.split("/"))) };
	}),
);
const implementationHashes = {
	storeSha256: await fileHash(join(packageRoot, "src/memory/store.ts")),
	transactionsSha256: await fileHash(join(packageRoot, "src/memory/transactions.ts")),
	storeQualificationSha256: await fileHash(join(packageRoot, "scripts/qualify-memory-store.ts")),
	retrievalSha256: await fileHash(join(packageRoot, "src/memory/retrieval.ts")),
	retrievalQualificationSha256: await fileHash(join(packageRoot, "scripts/qualify-memory-retrieval.ts")),
};
const longitudinal = evaluateMemoryLongitudinalDataset(longitudinalInput);
const commit = gitValue(["rev-parse", "HEAD"]);
const tree = gitValue(["rev-parse", "HEAD^{tree}"]);
const githubSha = process.env.GITHUB_SHA;
const expectedTag = `pi-research-agent-v${RESEARCH_AGENT_PACKAGE_VERSION}`;
const tagged = gitValue(["tag", "--list", expectedTag]);
const sbomRoot = sbom.packages?.find(({ name }) => name === agentManifest.name);
const technicalChecks = {
	versionMapping:
		agentManifest.name === "pi-research-agent" &&
		agentManifest.version === RESEARCH_AGENT_PACKAGE_VERSION &&
		RESEARCH_AGENT_SDK_VERSION === RESEARCH_AGENT_PACKAGE_VERSION &&
		contractsManifest.name === "@research-agent/contracts" &&
		contractsManifest.version === "2.1.0" &&
		agentManifest.dependencies?.["@research-agent/contracts"] === contractsManifest.version,
	lockfileCurrent:
		lockfile.packages["packages/research-agent"]?.version === agentManifest.version &&
		lockfile.packages["packages/research-agent-contracts"]?.version === contractsManifest.version,
	projectSchemaUnchanged: RESEARCH_SCHEMA_VERSION === "1.5.1",
	memorySchemaV1: MEMORY_SCHEMA_VERSION === "1.0.0" && schemaManifest.length === 9,
	storeBaselineBound:
		storeBaseline.qualification === "pi-research-agent-v3-memory-store" &&
		storeBaseline.configuration.transactions === 10_000 &&
		storeBaseline.status === "passed" &&
		allTrue(storeBaseline.checks) &&
		storeBaseline.input.storeSha256 === implementationHashes.storeSha256 &&
		storeBaseline.input.transactionsSha256 === implementationHashes.transactionsSha256 &&
		storeBaseline.input.qualificationScriptSha256 === implementationHashes.storeQualificationSha256,
	retrievalBaselineBound:
		retrievalBaseline.qualification === "pi-research-agent-v3-memory-retrieval" &&
		retrievalBaseline.status === "passed" &&
		allTrue(retrievalBaseline.checks) &&
		retrievalBaseline.input.retrievalSha256 === implementationHashes.retrievalSha256 &&
		retrievalBaseline.input.qualificationScriptSha256 === implementationHashes.retrievalQualificationSha256,
	longitudinalBaselineBound:
		canonicalStringify(longitudinal) === canonicalStringify(expectedLongitudinal) &&
		longitudinal.status === "infrastructure_passed" &&
		longitudinal.dataset.synthetic &&
		!longitudinal.longitudinal.betaPilotStarted &&
		!longitudinal.longitudinal.stableV3LongitudinalEligible,
	transferVectorV1:
		transferVector.format === "doro-memory-transfer-crypto-vector" &&
		transferVector.version === 1 &&
		transferVector.cipher === "AES-256-GCM" &&
		transferVector.kdf?.name === "scrypt" &&
		transferVector.kdf?.N === 131_072 &&
		transferVector.kdf?.r === 8 &&
		transferVector.kdf?.p === 1 &&
		transferVector.kdf?.maxmem === 256 * 1_024 * 1_024,
	compatibilityMapping:
		compatibilityMatrix.researchAgentVersion === agentManifest.version &&
		["0.83.0", "0.84.0"].every((version) =>
			compatibilityMatrix.packageLanes?.some(({ piVersion, blocking }) => piVersion === version && blocking),
		),
	sbomCurrent:
		sbom.name === `${agentManifest.name}-${agentManifest.version}` && sbomRoot?.versionInfo === agentManifest.version,
	releaseTagAbsent: tagged.length === 0,
	githubShaMatches: githubSha === undefined || githubSha === commit,
	trackedTreeClean: gitValue(["status", "--porcelain", "--untracked-files=no"]) === "",
};
const technicalPreflightPassed = Object.values(technicalChecks).every(Boolean);
const artifactHashes = {
	memorySchemaManifest: hashCanonicalJson(schemaManifest).value,
	memoryContractsGolden: await fileHash(join(contractsRoot, "test/fixtures/memory-v1/golden.json")),
	transferCryptoVector: await fileHash(join(packageRoot, "evals/v3/memory-transfer-v1-crypto-vector.json")),
	migrationGuide: await fileHash(join(packageRoot, "docs/memory-v3-migration.md")),
	trialProtocol: await fileHash(join(packageRoot, "docs/memory-v3-beta-trial.md")),
	releaseBoundary: await fileHash(join(packageRoot, "docs/release-v3.0.0-beta.1.md")),
	compatibilityMatrix: await fileHash(join(packageRoot, "docs/compatibility/pi-baselines.json")),
	sbom: await fileHash(join(packageRoot, "SBOM.spdx.json")),
};
const report = {
	qualification: "pi-research-agent-v3.0.0-beta.1-technical-preflight",
	generatedAt: new Date().toISOString(),
	platform: `${process.platform}-${process.arch}`,
	node: process.version,
	candidate: { commit, tree, expectedTag },
	versions: {
		agent: agentManifest.version,
		sdk: RESEARCH_AGENT_SDK_VERSION,
		contracts: contractsManifest.version,
		memorySchema: MEMORY_SCHEMA_VERSION,
		projectSchema: RESEARCH_SCHEMA_VERSION,
	},
	artifactHashes,
	baselines: {
		store: { platform: storeBaseline.platform, status: storeBaseline.status },
		retrieval: { platform: retrievalBaseline.platform, status: retrievalBaseline.status },
		longitudinal: {
			status: longitudinal.longitudinal.status,
			betaPilotStarted: longitudinal.longitudinal.betaPilotStarted,
			stableV3LongitudinalEligible: longitudinal.longitudinal.stableV3LongitudinalEligible,
		},
	},
	technicalChecks,
	eligibility: {
		technicalPreflightPassed,
		betaReleaseEligible: false,
		stableReleaseEligible: false,
		reasonCodes: ["beta_pilot_not_started", "stable_longitudinal_study_incomplete"],
	},
	usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	status: technicalPreflightPassed ? "technical_preflight_passed" : "technical_preflight_failed",
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath !== null) {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, output);
}
process.stdout.write(output);
if (!technicalPreflightPassed) process.exitCode = 1;
