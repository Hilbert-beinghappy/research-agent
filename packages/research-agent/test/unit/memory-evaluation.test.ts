// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateMemoryLongitudinalDataset, type MemoryLongitudinalDatasetV1 } from "../../src/memory/evaluation.ts";

let golden: MemoryLongitudinalDatasetV1;
let baseline: unknown;

function cloneGolden(): MemoryLongitudinalDatasetV1 {
	return structuredClone(golden);
}

beforeAll(async () => {
	golden = JSON.parse(
		await readFile(new URL("../../evals/v3/memory-longitudinal-golden.json", import.meta.url), "utf8"),
	) as MemoryLongitudinalDatasetV1;
	baseline = JSON.parse(
		await readFile(new URL("../../evals/v3/baselines/memory-longitudinal-synthetic.json", import.meta.url), "utf8"),
	) as unknown;
});

describe("Personal Memory longitudinal evaluation", () => {
	it("matches the bound aggregate baseline without exporting participant or task references", () => {
		const report = evaluateMemoryLongitudinalDataset(golden);
		expect(report).toEqual(baseline);
		expect(report).toMatchObject({
			status: "infrastructure_passed",
			longitudinal: {
				betaPilotStarted: false,
				stableV3LongitudinalEligible: false,
				status: "synthetic_only",
			},
		});
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("participantRef");
		expect(serialized).not.toContain("taskRef");
		expect(serialized).not.toContain("sha256:");
	});

	it("rejects semantic payloads, clear identifiers, impossible receipts, and invalid denominators", () => {
		const semanticPayload = cloneGolden();
		Object.assign(semanticPayload.tasks[0] ?? {}, { semanticValue: "private preference" });
		expect(() => evaluateMemoryLongitudinalDataset(semanticPayload)).toThrow("prohibited fields");

		const clearIdentifier = cloneGolden();
		if (clearIdentifier.tasks[0] === undefined) throw new Error("golden task missing");
		clearIdentifier.tasks[0].participantRef = "participant-1";
		expect(() => evaluateMemoryLongitudinalDataset(clearIdentifier)).toThrow("SHA-256 ref");

		const receiptWithoutApplication = cloneGolden();
		if (receiptWithoutApplication.tasks[6] === undefined) throw new Error("golden off task missing");
		receiptWithoutApplication.tasks[6].receiptPresent = true;
		expect(() => evaluateMemoryLongitudinalDataset(receiptWithoutApplication)).toThrow(
			"applies memory in the off condition",
		);

		const falseMemoryWithoutApplication = cloneGolden();
		if (falseMemoryWithoutApplication.tasks[6] === undefined) throw new Error("golden off task missing");
		falseMemoryWithoutApplication.tasks[6].falseMemory = true;
		expect(() => evaluateMemoryLongitudinalDataset(falseMemoryWithoutApplication)).toThrow(
			"false memory without application",
		);

		const zeroContext = cloneGolden();
		if (zeroContext.tasks[0] === undefined) throw new Error("golden task missing");
		zeroContext.tasks[0].availableContextTokens = 0;
		expect(() => evaluateMemoryLongitudinalDataset(zeroContext)).toThrow("must be positive");

		const duplicateControl = cloneGolden();
		const control = duplicateControl.participantControls[0];
		if (control === undefined) throw new Error("golden control missing");
		duplicateControl.participantControls.push(structuredClone(control));
		expect(() => evaluateMemoryLongitudinalDataset(duplicateControl)).toThrow("duplicates participantRef");
	});

	it("does not echo prohibited field names", () => {
		const maliciousFieldName = cloneGolden();
		Object.assign(maliciousFieldName.tasks[0] ?? {}, { "PII=p03@example.invalid": "synthetic" });
		expect(() => evaluateMemoryLongitudinalDataset(maliciousFieldName)).toThrowError(
			/^task 0 contains prohibited fields$/u,
		);
	});

	it("fails hard gates when an attack class or deterministic correction coverage is missing", () => {
		const missingAttackClass = cloneGolden();
		missingAttackClass.securityChecks = missingAttackClass.securityChecks.filter(
			({ kind }) => kind !== "sensitive_inference",
		);
		expect(evaluateMemoryLongitudinalDataset(missingAttackClass)).toMatchObject({
			status: "hard_gate_failed",
			deterministicGates: { attackSuccessesZero: false },
		});

		const incompleteCorrection = cloneGolden();
		incompleteCorrection.correctionChecks = incompleteCorrection.correctionChecks.filter(
			({ action }) => action !== "delete",
		);
		expect(evaluateMemoryLongitudinalDataset(incompleteCorrection)).toMatchObject({
			status: "hard_gate_failed",
			deterministicGates: { correctionAndDeletionDeterministic: false },
		});

		const citationRegression = cloneGolden();
		if (citationRegression.tasks[0] === undefined) throw new Error("golden task missing");
		citationRegression.tasks[0].criticalGates.citation = false;
		expect(evaluateMemoryLongitudinalDataset(citationRegression)).toMatchObject({
			status: "hard_gate_failed",
			deterministicGates: { qualityNonRegression: false },
		});
	});
});
