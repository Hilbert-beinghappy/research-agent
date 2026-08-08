// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerResearchCommands } from "../src/extension/commands.ts";
import { RESEARCH_AGENT_PACKAGE_VERSION } from "../src/version.ts";

export const RESEARCH_AGENT_VERSION = RESEARCH_AGENT_PACKAGE_VERSION;

type Rgb = readonly [red: number, green: number, blue: number];

const BOCCHI_COLORS = {
	"1": [250, 229, 190],
	"3": [247, 174, 186],
	"4": [239, 145, 163],
	"5": [226, 116, 143],
	"6": [204, 85, 118],
	"7": [174, 63, 98],
	"8": [132, 45, 76],
	"9": [88, 33, 55],
	A: [45, 28, 37],
	C: [57, 55, 49],
	D: [91, 83, 66],
	E: [130, 101, 65],
	F: [176, 124, 39],
	G: [225, 166, 28],
	H: [255, 211, 54],
	J: [12, 58, 112],
	K: [22, 104, 179],
	L: [65, 177, 225],
	M: [164, 228, 250],
	Q: [118, 77, 58],
	R: [168, 117, 93],
	S: [205, 160, 132],
	U: [139, 151, 137],
	V: [86, 113, 101],
} as const satisfies Readonly<Record<string, Rgb>>;

const BOCCHI_PIXELS = [
	"........................",
	"........RS5SSD..........",
	".......S44443SD.........",
	"....R8R3444444S.........",
	"...8.JL54444444U........",
	".....KM54544544R........",
	".....GH45544S54R........",
	".....Q54SS35SR4R........",
	".....RS4SV31UVSQ........",
	".....655S1111S59........",
	".....465RRSRQ66..QQQ....",
	"....R4654449E58.DQQD....",
	"...R4564544C65QDVDQQ....",
	"...D55548QQ9RVSS........",
	"...A6QD4RCCVVERR........",
	"....QAAQ3FEV567.........",
	"....CCQEECCQ4R..........",
	"....9CCDCCQR3S..........",
	".....CCCAE753S..........",
	"......CCE4Q534..........",
	".......S34.634..........",
	".......646.745..........",
	".......A9A..9A..........",
	"........................",
] as const;

const ANSI_RESET = "\x1b[0m";
const ansiForeground = ([red, green, blue]: Rgb): string => `\x1b[38;2;${red};${green};${blue}m`;
const ansiBackground = ([red, green, blue]: Rgb): string => `\x1b[48;2;${red};${green};${blue}m`;

function renderBocchiPixel(top: string, bottom: string): string {
	if (top === "." && bottom === ".") return `${ANSI_RESET} `;
	if (top === bottom) return `${ANSI_RESET}${ansiForeground(BOCCHI_COLORS[top as keyof typeof BOCCHI_COLORS])}█`;
	if (bottom === ".") return `${ANSI_RESET}${ansiForeground(BOCCHI_COLORS[top as keyof typeof BOCCHI_COLORS])}▀`;
	if (top === ".") return `${ANSI_RESET}${ansiForeground(BOCCHI_COLORS[bottom as keyof typeof BOCCHI_COLORS])}▄`;
	return `${ANSI_RESET}${ansiForeground(BOCCHI_COLORS[top as keyof typeof BOCCHI_COLORS])}${ansiBackground(BOCCHI_COLORS[bottom as keyof typeof BOCCHI_COLORS])}▀`;
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
		lines.push(`${line}${ANSI_RESET}`);
	}
	return lines;
}

export default function researchExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render: () => {
				const effort = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ` with ${ctx.thinkingLevel} effort` : "";
				const details = [
					`${theme.bold("Doro Research Agent")}${theme.fg("dim", ` v${RESEARCH_AGENT_VERSION}`)}`,
					theme.fg("muted", `${ctx.model?.id ?? "No model selected"}${effort}`),
					theme.fg("dim", ctx.cwd),
				];
				return renderBocchi().map((line, index) => `${line}  ${details[index] ?? ""}`);
			},
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
