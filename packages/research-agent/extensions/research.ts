// SPDX-License-Identifier: Apache-2.0

import { type ExtensionAPI, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { registerResearchCommands } from "../src/extension/commands.ts";

export const RESEARCH_AGENT_VERSION = "2.0.0";

const BOCCHI_COLORS = {
	K: 235,
	P: 211,
	S: 223,
	B: 75,
	Y: 220,
	H: 218,
	D: 239,
} as const;

const BOCCHI_PIXELS = [
	"....................",
	".......KKKKKK.......",
	".....KKPPPPPPKK.....",
	"....KPPPPPPPPPPK....",
	"..B.KPPPPPPPPPPPK...",
	".BYKKPPPPPPPPPPPK...",
	"..KPPPKPPPPKPPPPK...",
	"...KPKSSSSSSKPPK....",
	"...KPSSBSSBSSPPK....",
	"...KPSSBSSBSSPPK....",
	"...KPPSSKSSSPPPK....",
	"....KSSSSSSSSPK.....",
	"....KKPPPPPPPKK.....",
	".....KHHHHHHK.......",
	"....KHHHHHHHHK......",
	"....KHSHHHHSHK......",
	"....KHHHHHHHHK......",
	".....KDDDDDDK.......",
	".....KDKKKKDK.......",
	".....KK....KK.......",
	"....KK......KK......",
	"....................",
] as const;

const ansiForeground = (color: number): string => `\x1b[38;5;${color}m`;
const ansiBackground = (color: number): string => `\x1b[48;5;${color}m`;

function renderBocchiPixel(top: string, bottom: string): string {
	if (top === "." && bottom === ".") return " ";
	if (top === bottom) return `${ansiForeground(BOCCHI_COLORS[top as keyof typeof BOCCHI_COLORS])}█`;
	if (bottom === ".") return `${ansiForeground(BOCCHI_COLORS[top as keyof typeof BOCCHI_COLORS])}▀`;
	if (top === ".") return `${ansiForeground(BOCCHI_COLORS[bottom as keyof typeof BOCCHI_COLORS])}▄`;
	return `${ansiForeground(BOCCHI_COLORS[top as keyof typeof BOCCHI_COLORS])}${ansiBackground(BOCCHI_COLORS[bottom as keyof typeof BOCCHI_COLORS])}▀`;
}

function renderBocchi(): string[] {
	const lines: string[] = [];
	for (let row = 0; row < BOCCHI_PIXELS.length; row += 2) {
		const top = BOCCHI_PIXELS[row];
		const bottom = BOCCHI_PIXELS[row + 1];
		let line = "";
		for (let column = 0; column < top.length; column += 1) {
			line += renderBocchiPixel(top[column] ?? ".", bottom?.[column] ?? ".");
		}
		lines.push(`${line}\x1b[0m`);
	}
	return lines;
}

export default function researchExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader(() => ({
			render: () => [
				...renderBocchi(),
				`Doro Research Agent v${RESEARCH_AGENT_VERSION} Powered by Pi ${PI_VERSION}`,
			],
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
