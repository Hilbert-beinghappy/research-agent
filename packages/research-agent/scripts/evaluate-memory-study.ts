// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateMemoryStudyEvidence } from "../src/memory/study-evidence.ts";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--input" || args[1]?.trim().length === 0) {
	throw new TypeError("usage: evaluate-memory-study.ts --input <path>");
}
const inputPath = resolve(process.cwd(), args[1] as string);
const inputText = await readFile(inputPath, "utf8");
let input: unknown;
try {
	input = JSON.parse(inputText) as unknown;
} catch {
	throw new TypeError("study evidence input is not valid JSON");
}
const report = evaluateMemoryStudyEvidence(input);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
