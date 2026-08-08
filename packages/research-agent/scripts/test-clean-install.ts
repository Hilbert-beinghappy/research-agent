// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface PackResult {
	filename: string;
}

interface Lockfile {
	packages: Record<string, { version?: string }>;
}

interface PackageManifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
	bin?: Record<string, string>;
	pi?: { extensions?: string[] };
}

interface ProbeResult {
	extension: string;
	commands: number;
	project: string;
	sdk: string;
	packageVersion: string;
	projectSchemaVersion: string;
	sdkCapabilityVersion: number;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const contractsRoot = join(repositoryRoot, "packages/research-agent-contracts");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const piVersionIndex = process.argv.indexOf("--pi-version");
const requestedPiVersion = piVersionIndex < 0 ? null : (process.argv[piVersionIndex + 1] ?? null);
if (piVersionIndex >= 0 && (requestedPiVersion === null || !/^\d+\.\d+\.\d+$/u.test(requestedPiVersion))) {
	throw new TypeError("--pi-version requires an exact semantic version");
}

function run(command: string, args: string[], cwd: string, input?: string): string {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		input,
		maxBuffer: 16 * 1_024 * 1_024,
		shell: process.platform === "win32" && command.endsWith(".cmd"),
	});
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args[0] ?? ""} failed with exit code ${result.status ?? "unknown"}\n${result.stderr.trim()}`,
		);
	}
	return result.stdout;
}

const lockfile = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8")) as Lockfile;
const typeboxVersion = lockfile.packages["node_modules/typebox"]?.version;
if (typeboxVersion === undefined) throw new Error("typebox is absent from package-lock.json");
const peerPackages = ["packages/agent", "packages/ai", "packages/coding-agent"].map(
	(path) => JSON.parse(readFileSync(join(repositoryRoot, path, "package.json"), "utf8")) as PackageManifest,
);
const agentManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
const contractsManifest = JSON.parse(readFileSync(join(contractsRoot, "package.json"), "utf8")) as PackageManifest;
if (agentManifest.dependencies?.["@research-agent/contracts"] !== contractsManifest.version) {
	throw new Error("Agent and contracts package mapping differs");
}
if (
	JSON.stringify(agentManifest.bin) !== JSON.stringify({ "research-agent-rpc": "./bin/research-agent-rpc.mjs" }) ||
	JSON.stringify(agentManifest.pi?.extensions) !== JSON.stringify(["./extensions/research.ts"])
) {
	throw new Error("Doro must expose one Pi Extension path and no standalone CLI");
}

const tempRoot = await mkdtemp(join(tmpdir(), "pi-research-agent-install-"));
try {
	run(npm, ["run", "build"], packageRoot);
	const packDirectory = join(tempRoot, "pack");
	const installDirectory = join(tempRoot, "install");
	await mkdir(packDirectory);
	await mkdir(installDirectory);
	const packedContracts = JSON.parse(
		run(npm, ["pack", "--json", "--pack-destination", packDirectory], contractsRoot),
	) as PackResult[];
	const contractsFilename = packedContracts[0]?.filename;
	if (contractsFilename === undefined) throw new Error("contracts npm pack returned no tarball");
	const packed = JSON.parse(
		run(npm, ["pack", "--json", "--pack-destination", packDirectory], packageRoot),
	) as PackResult[];
	const filename = packed[0]?.filename;
	if (filename === undefined) throw new Error("npm pack returned no tarball");
	await writeFile(
		join(installDirectory, "package.json"),
		`${JSON.stringify({ name: "pi-research-agent-clean-install", private: true, type: "module" }, null, 2)}\n`,
	);
	run(
		npm,
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--package-lock=false",
			join(packDirectory, contractsFilename),
			join(packDirectory, filename),
			...peerPackages.map(({ name, version }) => `${name}@${requestedPiVersion ?? version}`),
			`typebox@${typeboxVersion}`,
		],
		installDirectory,
	);
	const installedAgent = JSON.parse(
		readFileSync(join(installDirectory, "node_modules/pi-research-agent/package.json"), "utf8"),
	) as PackageManifest;
	const installedContracts = JSON.parse(
		readFileSync(join(installDirectory, "node_modules/@research-agent/contracts/package.json"), "utf8"),
	) as PackageManifest;
	if (installedAgent.version !== agentManifest.version || installedContracts.version !== contractsManifest.version) {
		throw new Error("Installed package version mapping differs from packed manifests");
	}
	const initializeUrl = pathToFileURL(
		join(installDirectory, "node_modules/pi-research-agent/dist/project/init.js"),
	).href;
	const probe = run(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			[
				'import { mkdir, mkdtemp, rm } from "node:fs/promises";',
				'import { tmpdir } from "node:os";',
				'import { join, resolve } from "node:path";',
				'import { RESEARCH_SCHEMA_VERSION } from "@research-agent/contracts";',
				'import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";',
				'import { createResearchSdk } from "pi-research-agent/sdk";',
				`import { initializeProject } from ${JSON.stringify(initializeUrl)};`,
				`const expectedPackageVersion = ${JSON.stringify(agentManifest.version)};`,
				'const root = await mkdtemp(join(tmpdir(), "pi-research-agent-probe-"));',
				"try {",
				'  const cwd = join(root, "project"); const agentDir = join(root, "agent");',
				"  await Promise.all([mkdir(cwd), mkdir(agentDir)]);",
				'  const packageDir = resolve("node_modules/pi-research-agent");',
				"  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [packageDir] }) });",
				"  await loader.reload();",
				"  const loaded = loader.getExtensions();",
				"  if (loaded.errors.length !== 0) throw new Error(JSON.stringify(loaded.errors));",
				'  if (loaded.extensions.length !== 1) throw new Error("extension count mismatch");',
				'  if (!loaded.extensions[0].commands.has("research-version")) throw new Error("version command missing");',
				'  const projectRoot = join(root, "research-project");',
				'  const initialized = await initializeProject(projectRoot, { title: "Clean install" });',
				"  const sdk = await createResearchSdk([projectRoot]);",
				'  const capabilities = await sdk.invoke({ protocol: "pi-research-rpc", version: 1, requestId: "clean-install", method: "system.capabilities", params: null });',
				'  if (!capabilities.ok || capabilities.value.packageVersion !== expectedPackageVersion || capabilities.value.projectSchemaVersion !== RESEARCH_SCHEMA_VERSION || capabilities.value.version !== 2) throw new Error("SDK capability probe failed");',
				'  const opened = await sdk.invoke({ protocol: "pi-research-rpc", version: 1, requestId: "open", method: "project.open", params: { projectId: initialized.manifest.projectId } });',
				'  if (!opened.ok || JSON.stringify(opened).includes(projectRoot)) throw new Error("SDK open probe failed or leaked host path");',
				'  process.stdout.write(JSON.stringify({ extension: "loaded", commands: loaded.extensions[0].commands.size, project: "initialized-and-opened", sdk: "loaded", packageVersion: capabilities.value.packageVersion, projectSchemaVersion: capabilities.value.projectSchemaVersion, sdkCapabilityVersion: capabilities.value.version }));',
				"} finally { await rm(root, { recursive: true, force: true }); }",
			].join("\n"),
		],
		installDirectory,
	);
	const parsedProbe = JSON.parse(probe) as ProbeResult;
	const rpcExecutable = join(
		installDirectory,
		"node_modules/.bin",
		process.platform === "win32" ? "research-agent-rpc.cmd" : "research-agent-rpc",
	);
	const rpcVersion = run(rpcExecutable, ["--version"], installDirectory).trim();
	if (rpcVersion !== agentManifest.version) throw new Error("Installed RPC executable version mismatch");
	const rpcResponse = JSON.parse(
		run(
			rpcExecutable,
			[],
			installDirectory,
			`${JSON.stringify({ protocol: "pi-research-rpc", version: 1, requestId: "rpc-clean-install", method: "system.capabilities", params: null })}\n`,
		).trim(),
	) as {
		protocol?: string;
		version?: number;
		result?: {
			ok?: boolean;
			value?: { hostPaths?: string; packageVersion?: string; projectSchemaVersion?: string; version?: number };
		};
	};
	if (
		rpcResponse.protocol !== "pi-research-rpc" ||
		rpcResponse.version !== 1 ||
		rpcResponse.result?.ok !== true ||
		rpcResponse.result.value?.hostPaths !== "redacted" ||
		rpcResponse.result.value.packageVersion !== agentManifest.version ||
		rpcResponse.result.value.projectSchemaVersion !== parsedProbe.projectSchemaVersion ||
		rpcResponse.result.value.version !== 2
	) {
		throw new Error("Installed RPC inspection probe failed");
	}
	for (const executable of ["doro", "doro.cmd", "doro.ps1"]) {
		if (existsSync(join(installDirectory, "node_modules/.bin", executable))) {
			throw new Error("Clean install exposed an unauthorized standalone doro executable");
		}
	}
	run(
		npm,
		[
			"uninstall",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--package-lock=false",
			"pi-research-agent",
			"@research-agent/contracts",
		],
		installDirectory,
	);
	for (const removedPath of [
		join(installDirectory, "node_modules/pi-research-agent"),
		join(installDirectory, "node_modules/@research-agent/contracts"),
		rpcExecutable,
	]) {
		try {
			readFileSync(removedPath);
			throw new Error(`Clean uninstall left ${removedPath}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	process.stdout.write(
		`${JSON.stringify(
			{
				status: "passed",
				platform: process.platform,
				node: process.version,
				piVersion: requestedPiVersion ?? peerPackages[0]?.version,
				typeboxVersion,
				identity: {
					product: "Doro",
					form: "pi-package-profile",
					packageVersion: agentManifest.version,
					contractsVersion: contractsManifest.version,
					projectSchemaVersion: parsedProbe.projectSchemaVersion,
					rpcProtocolVersion: rpcResponse.version,
					sdkCapabilityVersion: parsedProbe.sdkCapabilityVersion,
					standaloneDoroCli: false,
				},
				probe: {
					...parsedProbe,
					rpc: "inspected",
					rpcVersion,
					uninstall: "verified",
				},
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
