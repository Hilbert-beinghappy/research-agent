// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashBytes } from "../../src/contracts/integrity.ts";

interface RetrievalQualificationBaseline {
	qualification: string;
	configuration: { sizes: number[]; iterations: number; warmupIterations: number };
	benchmarks: Array<{ size: number; p95Ms: number; topMemoryId: string }>;
	endToEndTenThousand: { p95Ms: number; estimatedTokens: number; selectedItems: number };
	context: { estimatedTokens: number; maximumTokens: number; availableContextTokens: number };
	input: { retrievalSha256: string; qualificationScriptSha256: string };
	checks: Record<string, boolean>;
	usage: { modelCalls: number; apiRequests: number; modelCostUsd: number; apiCostUsd: number };
	status: string;
}

const packageRoot = join(import.meta.dirname, "..", "..");

describe("Personal Memory retrieval qualification baseline", () => {
	it("binds deterministic 1k/10k/50k retrieval and token gates to the current implementation", async () => {
		const baseline = JSON.parse(
			await readFile(join(packageRoot, "evals/v3/baselines/memory-retrieval-darwin-arm64.json"), "utf8"),
		) as RetrievalQualificationBaseline;
		expect(baseline).toMatchObject({
			qualification: "pi-research-agent-v3-memory-retrieval",
			configuration: { sizes: [1_000, 10_000, 50_000], iterations: 30, warmupIterations: 5 },
			usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
			status: "passed",
		});
		expect(baseline.benchmarks.find(({ size }) => size === 10_000)?.p95Ms).toBeLessThanOrEqual(75);
		expect(baseline.endToEndTenThousand.p95Ms).toBeLessThanOrEqual(75);
		expect(baseline.endToEndTenThousand.selectedItems).toBe(8);
		expect(baseline.benchmarks.every(({ topMemoryId }) => topMemoryId === "memory-00000")).toBe(true);
		expect(baseline.context.estimatedTokens).toBeLessThanOrEqual(baseline.context.maximumTokens);
		expect(baseline.context.estimatedTokens).toBeLessThanOrEqual(
			Math.floor(baseline.context.availableContextTokens * 0.05),
		);
		expect(Object.values(baseline.checks).every(Boolean)).toBe(true);
		const [retrieval, script] = await Promise.all([
			readFile(join(packageRoot, "src/memory/retrieval.ts")),
			readFile(join(packageRoot, "scripts/qualify-memory-retrieval.ts")),
		]);
		expect({
			retrievalSha256: hashBytes(retrieval).value,
			qualificationScriptSha256: hashBytes(script).value,
		}).toEqual(baseline.input);
	});
});
