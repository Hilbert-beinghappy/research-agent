// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { calculateGrowthChecks, type DiagnosticCaseResult } from "../../scripts/diagnose-project-transactions.ts";

function measurement(
	writesPerProcess: number,
	repetition: number,
	elapsedMs: number,
	processes = 2,
): DiagnosticCaseResult {
	return {
		processes,
		writesPerProcess,
		repetition,
		elapsedMs,
		conflicts: 0,
		conflictRate: 0,
		finalRevision: writesPerProcess * processes,
		operationCount: writesPerProcess * processes,
		pendingTransactions: 0,
		projectValid: true,
		fileHashCount: 0,
		performanceBudgetMs: 225_000,
		performanceBudgetPassed: true,
		conflictRateBudget: 0.001,
		conflictRateBudgetPassed: true,
		phaseTimings: {},
		status: "passed",
		errorCode: null,
	};
}

describe("transaction diagnostic growth statistics", () => {
	it("uses the median of independent measurements instead of matching single repetitions", () => {
		const results = [
			measurement(125, 1, 100),
			measurement(125, 2, 100),
			measurement(125, 3, 1_000),
			measurement(250, 1, 1_000),
			measurement(250, 2, 200),
			measurement(250, 3, 200),
		];

		expect(calculateGrowthChecks(results, 2.6)).toEqual([
			{
				processes: 2,
				fromTotalWrites: 250,
				toTotalWrites: 500,
				fromMedianElapsedMs: 100,
				toMedianElapsedMs: 200,
				ratio: 2,
				budget: 2.6,
				passed: true,
			},
		]);
	});

	it("keeps process-count series independent", () => {
		const results = [
			...([100, 100, 100] as const).map((elapsedMs, index) => measurement(125, index + 1, elapsedMs, 1)),
			...([300, 300, 300] as const).map((elapsedMs, index) => measurement(250, index + 1, elapsedMs, 1)),
			...([200, 200, 200] as const).map((elapsedMs, index) => measurement(125, index + 1, elapsedMs, 2)),
			...([400, 400, 400] as const).map((elapsedMs, index) => measurement(250, index + 1, elapsedMs, 2)),
		];

		expect(calculateGrowthChecks(results, 2.6)).toMatchObject([
			{ processes: 1, ratio: 3, passed: false },
			{ processes: 2, ratio: 2, passed: true },
		]);
	});
});
