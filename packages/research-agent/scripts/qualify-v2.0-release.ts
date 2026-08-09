// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";
import { hashCanonicalJson } from "../src/kernel/integrity.ts";

interface PackResult {
	filename: string;
	entryCount: number;
	files: Array<{ path: string; size: number }>;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const contractsRoot = join(repositoryRoot, "packages/research-agent-contracts");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const agentManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
	name: string;
	version: string;
};
const contractsManifest = JSON.parse(await readFile(join(contractsRoot, "package.json"), "utf8")) as {
	name: string;
	version: string;
};

const build = spawnSync(npm, ["run", "build"], {
	cwd: packageRoot,
	encoding: "utf8",
	maxBuffer: 16 * 1_024 * 1_024,
	shell: process.platform === "win32",
});
if (build.status !== 0) throw new Error(`package build failed with exit code ${build.status ?? "unknown"}`);

function pack(root: string, destination: string): PackResult {
	const result = spawnSync(npm, ["pack", "--json", "--pack-destination", destination], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 16 * 1_024 * 1_024,
		shell: process.platform === "win32",
	});
	if (result.status !== 0) throw new Error(`npm pack failed with exit code ${result.status ?? "unknown"}`);
	const packed = (JSON.parse(result.stdout) as PackResult[])[0];
	if (packed === undefined) throw new Error("npm pack returned no result");
	return packed;
}

async function sha256(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

async function qualifyPackage(root: string, first: string, second: string) {
	const left = pack(root, first);
	const right = pack(root, second);
	const leftEntries = left.files.map(({ path, size }) => ({ path, size }));
	const rightEntries = right.files.map(({ path, size }) => ({ path, size }));
	const leftHash = await sha256(join(first, left.filename));
	const rightHash = await sha256(join(second, right.filename));
	return {
		entryCount: left.entryCount,
		entryManifestHash: hashCanonicalJson(leftEntries).value,
		entryManifestMatches: canonicalStringify(leftEntries) === canonicalStringify(rightEntries),
		tarballs: {
			first: { filename: left.filename, sha256: leftHash },
			second: { filename: right.filename, sha256: rightHash },
		},
		tarballBytesMatch: leftHash === rightHash,
	};
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-release-"));
try {
	const directories = ["agent-a", "agent-b", "contracts-a", "contracts-b"].map((name) =>
		join(temporaryDirectory, name),
	);
	await Promise.all(directories.map((directory) => mkdir(directory)));
	const agent = await qualifyPackage(packageRoot, directories[0]!, directories[1]!);
	const contracts = await qualifyPackage(contractsRoot, directories[2]!, directories[3]!);
	const passed =
		agent.entryManifestMatches &&
		agent.tarballBytesMatch &&
		contracts.entryManifestMatches &&
		contracts.tarballBytesMatch;
	const artifactDirectoryIndex = process.argv.indexOf("--artifact-directory");
	if (artifactDirectoryIndex >= 0) {
		const artifactDirectory = process.argv[artifactDirectoryIndex + 1];
		if (artifactDirectory === undefined) throw new TypeError("--artifact-directory requires a path");
		if (passed) {
			const absoluteDirectory = resolve(process.cwd(), artifactDirectory);
			await mkdir(absoluteDirectory);
			await Promise.all([
				copyFile(
					join(directories[0]!, agent.tarballs.first.filename),
					join(absoluteDirectory, agent.tarballs.first.filename),
					constants.COPYFILE_EXCL,
				),
				copyFile(
					join(directories[2]!, contracts.tarballs.first.filename),
					join(absoluteDirectory, contracts.tarballs.first.filename),
					constants.COPYFILE_EXCL,
				),
			]);
		}
	}
	const report = {
		qualification: `pi-research-agent-v${agentManifest.version}-release`,
		generatedAt: new Date().toISOString(),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		versions: {
			agent: `${agentManifest.name}@${agentManifest.version}`,
			contracts: `${contractsManifest.name}@${contractsManifest.version}`,
		},
		agent,
		contracts,
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
	if (!passed) process.exitCode = 1;
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
