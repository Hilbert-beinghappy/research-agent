// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashBytes } from "../../src/contracts/integrity.ts";

interface MemoryStoreBaseline {
	qualification: string;
	configuration: { transactions: number; seed: number };
	counts: { signals: number; candidates: number; committed: number };
	recordRootHash: string;
	input: { storeSha256: string; transactionsSha256: string; qualificationScriptSha256: string };
	checks: Record<string, boolean>;
	usage: { modelCalls: number; apiRequests: number; modelCostUsd: number; apiCostUsd: number };
	status: string;
}

const packageRoot = join(import.meta.dirname, "..", "..");

describe("Personal Memory qualification baseline", () => {
	it("binds a passing 10,000-transaction receipt to the current implementation", async () => {
		const baseline = JSON.parse(
			await readFile(join(packageRoot, "evals/v3/baselines/memory-store-darwin-arm64.json"), "utf8"),
		) as MemoryStoreBaseline;
		expect(baseline).toMatchObject({
			qualification: "pi-research-agent-v3-memory-store",
			configuration: { transactions: 10_000, seed: 1_592_598_566 },
			counts: { signals: 7_971, candidates: 2_029, committed: 10_000 },
			recordRootHash: "sha256:6c768df9c6badc408a5b6912f205f18617679e5cee70afa583d06a80946d8bd7",
			usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
			status: "passed",
		});
		expect(baseline.checks).toEqual({
			profileOpenedReadWrite: true,
			profileRevisionExact: true,
			recordCountsExact: true,
			committedJournalsExact: true,
			noPendingTransactions: true,
			recordRootExact: true,
		});
		const [store, transactions, script] = await Promise.all([
			readFile(join(packageRoot, "src/memory/store.ts")),
			readFile(join(packageRoot, "src/memory/transactions.ts")),
			readFile(join(packageRoot, "scripts/qualify-memory-store.ts")),
		]);
		expect({
			storeSha256: hashBytes(store).value,
			transactionsSha256: hashBytes(transactions).value,
			qualificationScriptSha256: hashBytes(script).value,
		}).toEqual(baseline.input);
	});
});
