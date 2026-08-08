// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ResearchRpcRequest, ResearchRpcResponse } from "@research-agent/contracts";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { runResearchRpcServer } from "../src/rpc/server.ts";
import { createResearchSdk, RESEARCH_AGENT_SDK_VERSION } from "../src/sdk/index.ts";
import { RESEARCH_AGENT_PACKAGE_VERSION } from "../src/version.ts";

interface PackageManifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	bin?: Record<string, string>;
	pi?: { extensions?: string[] };
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function readManifest(path: string): Promise<PackageManifest> {
	return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
}

function gitValue(args: string[]): string {
	const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

async function rpc(
	sdk: Awaited<ReturnType<typeof createResearchSdk>>,
	request: ResearchRpcRequest,
): Promise<ResearchRpcResponse> {
	const input = new PassThrough();
	const output = new PassThrough();
	output.setEncoding("utf8");
	let text = "";
	output.on("data", (chunk: string) => {
		text += chunk;
	});
	const running = runResearchRpcServer(sdk, { input, output });
	input.end(`${JSON.stringify(request)}\n`);
	await running;
	return JSON.parse(text) as ResearchRpcResponse;
}

const [rootManifest, agentManifest, contractsManifest, ...piManifests] = await Promise.all([
	readManifest(join(repositoryRoot, "package.json")),
	readManifest(join(packageRoot, "package.json")),
	readManifest(join(repositoryRoot, "packages/research-agent-contracts/package.json")),
	...["agent", "ai", "coding-agent"].map((name) =>
		readManifest(join(repositoryRoot, `packages/${name}/package.json`)),
	),
]);
check(agentManifest.name === "pi-research-agent", "Research Agent package name changed");
check(agentManifest.version === RESEARCH_AGENT_PACKAGE_VERSION, "Package manifest and runtime version differ");
check(RESEARCH_AGENT_SDK_VERSION === RESEARCH_AGENT_PACKAGE_VERSION, "SDK and package versions differ");
check(contractsManifest.name === "@research-agent/contracts", "Contracts package name changed");
check(
	agentManifest.dependencies?.["@research-agent/contracts"] === contractsManifest.version,
	"Research Agent dependency does not pin the mapped contracts version",
);
check(
	canonicalStringify(agentManifest.bin) ===
		canonicalStringify({ "research-agent-rpc": "./bin/research-agent-rpc.mjs" }),
	"Release must expose only the inspection RPC executable",
);
check(
	canonicalStringify(agentManifest.pi?.extensions) === canonicalStringify(["./extensions/research.ts"]),
	"Release must load Doro through the Pi Extension path",
);

const request = {
	protocol: "pi-research-rpc",
	version: 1,
	requestId: "release-identity",
	method: "system.capabilities",
	params: null,
} as const satisfies ResearchRpcRequest;
const sdk = await createResearchSdk([]);
const capabilities = await sdk.invoke(request);
check(capabilities.ok, "SDK capability probe failed");
check(
	capabilities.value !== null && typeof capabilities.value === "object" && !Array.isArray(capabilities.value),
	"SDK capability payload is not an object",
);
check(capabilities.value.version === 2, "SDK capability version changed");
check(capabilities.value.packageVersion === agentManifest.version, "SDK capability package version differs");
check(capabilities.value.projectSchemaVersion === RESEARCH_SCHEMA_VERSION, "SDK project schema version differs");
const response = await rpc(sdk, request);
check(response.protocol === "pi-research-rpc" && response.version === 1, "RPC wire identity changed");
check(
	canonicalStringify(response.result) === canonicalStringify(capabilities),
	"SDK and RPC capability results differ",
);

const commit = gitValue(["rev-parse", "HEAD"]);
const tree = gitValue(["rev-parse", "HEAD^{tree}"]);
const githubSha = process.env.GITHUB_SHA;
check(githubSha === undefined || githubSha === commit, "GITHUB_SHA does not match checked-out HEAD");
if (process.argv.includes("--require-clean")) {
	check(gitValue(["status", "--porcelain", "--untracked-files=no"]) === "", "Tracked working tree is not clean");
}
const piVersions = Object.fromEntries(piManifests.map(({ name, version }) => [name, version]));
const report = {
	format: "doro-release-identity",
	version: 1,
	candidate: {
		commit,
		tree,
		expectedTag: `${agentManifest.name}-v${agentManifest.version}`,
	},
	product: {
		name: "Doro",
		form: "pi-package-profile",
		package: agentManifest.name,
		piExtension: agentManifest.pi?.extensions?.[0] ?? null,
		inspectionExecutable: Object.keys(agentManifest.bin ?? {})[0] ?? null,
		standaloneDoroCli: false,
	},
	versions: {
		rootMonorepo: rootManifest.version,
		piPackages: piVersions,
		researchAgentPackage: agentManifest.version,
		sdkPackageIdentity: RESEARCH_AGENT_SDK_VERSION,
		contractsPackage: contractsManifest.version,
		projectSchema: RESEARCH_SCHEMA_VERSION,
		rpcWire: { protocol: response.protocol, version: response.version },
		sdkCapability: capabilities.value.version,
	},
	usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	status: "passed",
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
