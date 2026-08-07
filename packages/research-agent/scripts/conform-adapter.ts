// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";
import { conformAdapterPackage } from "../src/adapters/conformance.ts";
import { canonicalStringify } from "../src/contracts/canonical-json.ts";

const args = process.argv.slice(2);
const strong = args.includes("--strong");
const packageArgument = args.find((argument) => argument !== "--strong");
if (packageArgument === undefined)
	throw new TypeError("Usage: npm run conform:adapter -- <package-directory> [--strong]");
const packageRoot = resolve(packageArgument);
if (!isAbsolute(packageRoot)) throw new TypeError("Adapter package path must resolve to an absolute path");
const result = await conformAdapterPackage(packageRoot, strong ? "strong_isolation" : "jsonl_process");
process.stdout.write(`${canonicalStringify({ ...result.report, packageHash: result.packageHash })}\n`);
if (!result.report.passed) process.exitCode = 1;
