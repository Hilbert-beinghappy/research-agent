#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { runResearchRpcServer } from "../dist/rpc/index.js";
import { createResearchSdk, RESEARCH_AGENT_SDK_VERSION } from "../dist/sdk/index.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
	process.stdout.write("Usage: research-agent-rpc [--include-host-paths] [--project <path>]...\n");
	process.exit(0);
}
if (args.includes("--version")) {
	process.stdout.write(`${RESEARCH_AGENT_SDK_VERSION}\n`);
	process.exit(0);
}
const projectRoots = [];
let includeHostPaths = false;
for (let index = 0; index < args.length; index += 1) {
	if (args[index] === "--include-host-paths") {
		includeHostPaths = true;
		continue;
	}
	if (args[index] !== "--project" || args[index + 1] === undefined) {
		throw new TypeError("Usage: research-agent-rpc [--include-host-paths] [--project <path>]...");
	}
	projectRoots.push(args[index + 1]);
	index += 1;
}
const sdk = await createResearchSdk(projectRoots, { includeHostPaths });
await runResearchRpcServer(sdk, { input: process.stdin, output: process.stdout });
