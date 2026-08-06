// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackResult {
	filename: string;
}

interface Lockfile {
	packages: Record<string, { version?: string }>;
}

interface PackageManifest {
	name: string;
	version: string;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command: string, args: string[], cwd: string): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024 });
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

const tempRoot = await mkdtemp(join(tmpdir(), "pi-research-agent-install-"));
try {
	const packDirectory = join(tempRoot, "pack");
	const installDirectory = join(tempRoot, "install");
	await mkdir(packDirectory);
	await mkdir(installDirectory);
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
			join(packDirectory, filename),
			...peerPackages.map(({ name, version }) => `${name}@${version}`),
			`typebox@${typeboxVersion}`,
		],
		installDirectory,
	);
	const probe = run(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			[
				'import { mkdir, mkdtemp, rm } from "node:fs/promises";',
				'import { tmpdir } from "node:os";',
				'import { join, resolve } from "node:path";',
				'import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";',
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
				'  process.stdout.write(JSON.stringify({ extension: "loaded", commands: loaded.extensions[0].commands.size }));',
				"} finally { await rm(root, { recursive: true, force: true }); }",
			].join("\n"),
		],
		installDirectory,
	);
	process.stdout.write(
		`${JSON.stringify(
			{
				status: "passed",
				platform: process.platform,
				node: process.version,
				typeboxVersion,
				probe: JSON.parse(probe) as unknown,
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
