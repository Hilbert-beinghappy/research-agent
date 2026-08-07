// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import type { ResearchRpcRequest, ResearchRpcResponse } from "@research-agent/contracts";
import { RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";
import { initializeProject } from "../src/project/init.ts";
import { runResearchRpcServer } from "../src/rpc/server.ts";
import { createResearchSdk } from "../src/sdk/index.ts";

function p95(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	if (value === undefined) throw new Error("Benchmark produced no measurements");
	return Number(value.toFixed(3));
}

async function rpcList(
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

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-v2.0-benchmark-"));
try {
	const projectCount = 25;
	const projectRoots = [];
	for (let index = 0; index < projectCount; index += 1) {
		const projectRoot = join(temporaryDirectory, `project-${index}`);
		await initializeProject(projectRoot, {
			title: `Multi-project benchmark ${index}`,
			domain: index % 2 === 0 ? "management" : "public-administration",
		});
		projectRoots.push(projectRoot);
	}
	const initializationStarted = performance.now();
	const sdk = await createResearchSdk(projectRoots);
	const sdkInitializationMs = Number((performance.now() - initializationStarted).toFixed(3));
	const sdkMeasurementsMs: number[] = [];
	const rpcMeasurementsMs: number[] = [];
	for (let sample = 0; sample < 10; sample += 1) {
		const request = {
			protocol: "pi-research-rpc",
			version: 1,
			requestId: `projects-${sample}`,
			method: "projects.list",
			params: null,
		} as const satisfies ResearchRpcRequest;
		let started = performance.now();
		const direct = await sdk.invoke(request);
		sdkMeasurementsMs.push(performance.now() - started);
		if (!direct.ok || !Array.isArray(direct.value) || direct.value.length !== projectCount) {
			throw new Error("SDK multi-project listing is incomplete");
		}
		started = performance.now();
		const response = await rpcList(sdk, request);
		rpcMeasurementsMs.push(performance.now() - started);
		if (
			!response.result.ok ||
			!Array.isArray(response.result.value) ||
			response.result.value.length !== projectCount
		) {
			throw new Error("RPC multi-project listing is incomplete");
		}
	}
	const thresholdMs = 2_000;
	const sdkP95Ms = p95(sdkMeasurementsMs);
	const rpcP95Ms = p95(rpcMeasurementsMs);
	const report = {
		benchmark: "pi-research-agent-v2.0",
		generatedAt: new Date().toISOString(),
		projectSchemaVersion: RESEARCH_SCHEMA_VERSION,
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
		fixture: { projects: projectCount, samples: sdkMeasurementsMs.length },
		results: {
			sdkInitialization: { elapsedMs: sdkInitializationMs, thresholdMs, passed: sdkInitializationMs < thresholdMs },
			sdkProjectList: {
				measurementsMs: sdkMeasurementsMs.map((value) => Number(value.toFixed(3))),
				p95Ms: sdkP95Ms,
				thresholdMs,
				passed: sdkP95Ms < thresholdMs,
			},
			rpcProjectList: {
				measurementsMs: rpcMeasurementsMs.map((value) => Number(value.toFixed(3))),
				p95Ms: rpcP95Ms,
				thresholdMs,
				passed: rpcP95Ms < thresholdMs,
			},
		},
		usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
	};
	const passed = Object.values(report.results).every(({ passed }) => passed);
	const output = `${JSON.stringify({ ...report, status: passed ? "passed" : "failed" }, null, 2)}\n`;
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
