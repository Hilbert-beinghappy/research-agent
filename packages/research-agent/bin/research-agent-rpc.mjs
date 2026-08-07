#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runResearchRpcServer } from "../src/rpc/index.mjs";
import { createResearchSdk, RESEARCH_AGENT_SDK_VERSION } from "../src/sdk/index.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
	process.stdout.write("Usage: research-agent-rpc [--project <path>]...\n");
	process.exit(0);
}
if (args.includes("--version")) {
	process.stdout.write(`${RESEARCH_AGENT_SDK_VERSION}\n`);
	process.exit(0);
}
const projectRoots = [];
for (let index = 0; index < args.length; index += 1) {
	if (args[index] !== "--project" || args[index + 1] === undefined) {
		throw new TypeError("Usage: research-agent-rpc [--project <path>]...");
	}
	projectRoots.push(args[index + 1]);
	index += 1;
}
const sdk = await createResearchSdk(projectRoots);
await runResearchRpcServer(sdk, { input: process.stdin, output: process.stdout });
