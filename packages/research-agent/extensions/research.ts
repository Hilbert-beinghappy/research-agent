// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerResearchCommands } from "../src/extension/commands.ts";

export const RESEARCH_AGENT_VERSION = "0.1.0";

export default function researchExtension(pi: ExtensionAPI): void {
	pi.registerCommand("research-version", {
		description: "Show the installed Pi Research Agent version",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`pi-research-agent v${RESEARCH_AGENT_VERSION}`, "info");
		},
	});
	registerResearchCommands(pi, RESEARCH_AGENT_VERSION);
}
