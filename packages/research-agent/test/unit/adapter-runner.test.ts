// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAdapterProcess } from "../../src/adapters/runner.ts";

const request = {
	protocol: "pi-research-adapter-jsonl",
	version: 1,
	messageId: "request-1",
	type: "request",
	method: "fixture",
	payload: null,
} as const;

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-research-adapter-runner-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function script(name: string, source: string): Promise<string> {
	const path = join(root, name);
	await writeFile(path, source);
	return path;
}

function run(entrypoint: string, overrides: Partial<Parameters<typeof runAdapterProcess>[0]> = {}) {
	return runAdapterProcess({
		launch: { executable: process.execPath, args: [entrypoint], cwd: root, isolation: "jsonl_process" },
		request,
		broker: async () => ({ ok: false, value: null, error: null }),
		timeoutMs: 1_000,
		maxOutputBytes: 4_096,
		...overrides,
	});
}

describe("adapter JSONL runner", () => {
	it("returns one schema-valid result", async () => {
		const entrypoint = await script(
			"success.mjs",
			'process.stdin.once("data", chunk => { const request = JSON.parse(chunk); console.log(JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: "result-1", type: "result", requestId: request.messageId, ok: true, value: { received: request.method }, error: null })); });\n',
		);
		await expect(run(entrypoint)).resolves.toMatchObject({ ok: true, value: { received: "fixture" } });
	});

	it.each([
		["malformed JSONL", 'console.log("not-json");\n', "ADAPTER_PROTOCOL_INVALID"],
		["process crash", "process.exit(3);\n", "ADAPTER_CRASH"],
	] as const)("contains %s without affecting the host", async (_label, source, code) => {
		const entrypoint = await script("failure.mjs", source);
		await expect(run(entrypoint)).resolves.toMatchObject({ ok: false, errors: [{ code }] });
	});

	it("enforces output and time limits", async () => {
		const oversized = await script("oversized.mjs", 'process.stdout.write("x".repeat(2048));\n');
		await expect(run(oversized, { maxOutputBytes: 128 })).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "ADAPTER_OUTPUT_TOO_LARGE" }],
		});
		const hanging = await script("hanging.mjs", "setInterval(() => {}, 1000);\n");
		await expect(run(hanging, { timeoutMs: 50 })).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "ADAPTER_TIMEOUT" }],
		});
	});

	it("routes network and credential intent only through the host broker", async () => {
		const entrypoint = await script(
			"broker.mjs",
			`let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.type === "request") {
      console.log(JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: "broker-1", type: "broker_request", requestId: message.messageId, broker: message.method, payload: null }));
    } else {
      console.log(JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: "result-1", type: "result", requestId: "request-1", ok: false, value: null, error: message.error }));
    }
  }
});
`,
		);
		const broker = vi.fn(async () => ({
			ok: false,
			value: null,
			error: { code: "BROKER_DENIED", message: "denied", retryable: false, details: null },
		}));
		await expect(run(entrypoint, { request: { ...request, method: "credential" }, broker })).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "BROKER_DENIED" }],
		});
		expect(broker).toHaveBeenCalledWith(expect.objectContaining({ broker: "credential" }));

		broker.mockClear();
		await run(entrypoint, { request: { ...request, method: "http" }, broker });
		expect(broker).toHaveBeenCalledWith(expect.objectContaining({ broker: "http" }));
	});

	it.skipIf(process.platform !== "darwin")(
		"strong isolation denies direct network, credential, external read/write, and subprocess access",
		async () => {
			const adapterRoot = join(root, "adapter");
			const staging = join(root, "staging");
			const privateRoot = join(root, "private");
			const projectRoot = join(root, "project");
			await Promise.all([mkdir(adapterRoot), mkdir(staging), mkdir(privateRoot), mkdir(projectRoot)]);
			const privateFile = join(privateRoot, "secret.txt");
			const projectFile = join(projectRoot, "blocked.txt");
			await writeFile(privateFile, "secret");
			const entrypoint = join(adapterRoot, "attack.mjs");
			await writeFile(
				entrypoint,
				`import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
process.stdin.once("data", async chunk => {
  const request = JSON.parse(chunk);
  let read = false;
  let write = false;
  let network = false;
  try { readFileSync(process.argv[2]); read = true; } catch {}
  try { writeFileSync(process.argv[3], "escaped"); write = true; } catch {}
  try { await fetch(process.argv[4], { signal: AbortSignal.timeout(500) }); network = true; } catch {}
  const spawned = spawnSync(process.execPath, ["-e", "process.exit(0)"]).status === 0;
  console.log(JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: "result-1", type: "result", requestId: request.messageId, ok: true, value: { read, write, network, credential: process.env.SUPER_SECRET === "visible", spawned }, error: null }));
});
`,
			);
			let acceptedConnections = 0;
			const server = createServer(() => {
				acceptedConnections += 1;
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("Test server did not bind");
			try {
				const result = await runAdapterProcess({
					launch: {
						executable: process.execPath,
						args: [entrypoint, privateFile, projectFile, `http://127.0.0.1:${address.port}`],
						cwd: staging,
						readRoots: [adapterRoot],
						isolation: "strong_isolation",
					},
					request,
					broker: async () => ({ ok: false, value: null, error: null }),
					timeoutMs: 3_000,
					maxOutputBytes: 4_096,
				});
				expect(result).toMatchObject({
					ok: true,
					value: { read: false, write: false, network: false, credential: false, spawned: false },
				});
				expect(acceptedConnections).toBe(0);
			} finally {
				server.close();
			}
		},
	);
});
