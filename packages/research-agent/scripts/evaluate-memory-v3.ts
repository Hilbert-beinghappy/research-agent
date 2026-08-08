// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";
import { evaluateMemoryLongitudinalDataset } from "../src/memory/evaluation.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--input" || args[1]?.trim().length === 0))
	throw new TypeError("usage: evaluate-memory-v3.ts [--input <path>]");
const inputPath =
	args.length === 0
		? resolve(packageRoot, "evals/v3/memory-longitudinal-golden.json")
		: resolve(process.cwd(), args[1] as string);

const report = evaluateMemoryLongitudinalDataset(JSON.parse(await readFile(inputPath, "utf8")) as unknown);
if (args.length === 0) {
	const expected = JSON.parse(
		await readFile(resolve(packageRoot, "evals/v3/baselines/memory-longitudinal-synthetic.json"), "utf8"),
	) as unknown;
	if (canonicalStringify(report) !== canonicalStringify(expected)) {
		throw new Error("Memory longitudinal golden metrics differ from the bound synthetic baseline");
	}
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "infrastructure_passed") process.exitCode = 1;
