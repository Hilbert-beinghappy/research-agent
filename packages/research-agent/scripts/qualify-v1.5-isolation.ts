// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runAdapterProcess } from "../src/adapters/runner.ts";

if (process.platform !== "darwin") throw new Error("v1.5 strong-isolation qualification requires macOS");

const root = await mkdtemp(join(tmpdir(), "pi-research-v1.5-isolation-"));
const server = createServer();
try {
	const adapterRoot = join(root, "adapter");
	const staging = join(root, "staging");
	const privateRoot = join(root, "private");
	const projectRoot = join(root, "project");
	await Promise.all([mkdir(adapterRoot), mkdir(staging), mkdir(privateRoot), mkdir(projectRoot)]);
	const privateFile = join(privateRoot, "secret.txt");
	const projectFile = join(projectRoot, "blocked.txt");
	await writeFile(privateFile, "private fixture");
	const entrypoint = join(adapterRoot, "attack.mjs");
	await writeFile(
		entrypoint,
		`import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
process.stdin.once("data", async chunk => {
  const request = JSON.parse(chunk);
  let externalRead = false;
  let projectWrite = false;
  let directNetwork = false;
  try { readFileSync(process.argv[2]); externalRead = true; } catch {}
  try { writeFileSync(process.argv[3], "escaped"); projectWrite = true; } catch {}
  try { await fetch(process.argv[4], { signal: AbortSignal.timeout(500) }); directNetwork = true; } catch {}
  const subprocess = spawnSync(process.execPath, ["-e", "process.exit(0)"]).status === 0;
  console.log(JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: "result-1", type: "result", requestId: request.messageId, ok: true, value: { externalRead, projectWrite, directNetwork, credential: process.env.RESEARCH_PRIVATE_TOKEN === "visible", subprocess }, error: null }));
});
`,
	);
	let acceptedConnections = 0;
	server.on("connection", () => {
		acceptedConnections += 1;
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Qualification server did not bind");
	const result = await runAdapterProcess({
		launch: {
			executable: process.execPath,
			args: [entrypoint, privateFile, projectFile, `http://127.0.0.1:${address.port}`],
			cwd: staging,
			readRoots: [adapterRoot],
			isolation: "strong_isolation",
		},
		request: {
			protocol: "pi-research-adapter-jsonl",
			version: 1,
			messageId: "v1.5-isolation-qualification",
			type: "request",
			method: "attack",
			payload: null,
		},
		broker: async () => ({ ok: false, value: null, error: null }),
		timeoutMs: 3_000,
		maxOutputBytes: 4_096,
	});
	if (!result.ok || result.value === null || typeof result.value !== "object" || Array.isArray(result.value)) {
		throw new Error(result.ok ? "Isolation result is invalid" : result.errors[0].message);
	}
	const checks = {
		directNetworkDenied: result.value.directNetwork === false && acceptedConnections === 0,
		externalReadDenied: result.value.externalRead === false,
		projectWriteDenied: result.value.projectWrite === false,
		credentialDenied: result.value.credential === false,
		subprocessDenied: result.value.subprocess === false,
	};
	try {
		await lstat(projectFile);
		checks.projectWriteDenied = false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const passed = Object.values(checks).every(Boolean);
	const report = {
		qualification: "pi-research-agent-v1.5-strong-isolation",
		generatedAt: new Date().toISOString(),
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		profile: "strong_isolation",
		checks,
		acceptedNetworkConnections: acceptedConnections,
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
	await new Promise<void>((done) => server.close(() => done()));
	await rm(root, { recursive: true, force: true });
}
