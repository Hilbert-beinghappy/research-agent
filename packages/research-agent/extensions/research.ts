// SPDX-License-Identifier: Apache-2.0

import { type ExtensionAPI, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { registerResearchCommands } from "../src/extension/commands.ts";

export const RESEARCH_AGENT_VERSION = "2.0.0";

export default function researchExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader(() => ({
			render: () => [`Doro Research Agent v${RESEARCH_AGENT_VERSION} Powered by Pi ${PI_VERSION}`],
			invalidate() {},
		}));
	});

	pi.registerCommand("research-version", {
		description: "Show the installed Pi Research Agent version",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`pi-research-agent v${RESEARCH_AGENT_VERSION}`, "info");
		},
	});
	registerResearchCommands(pi, RESEARCH_AGENT_VERSION);
}
