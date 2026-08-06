import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, type ExtensionCommandContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { RESEARCH_AGENT_VERSION } from "../../extensions/research.ts";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));

describe("Pi package compatibility", () => {
	it("loads and disables the package through Pi", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-research-agent-"));
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);

		try {
			const settingsManager = SettingsManager.inMemory({ packages: [packageDir] });
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const loaded = loader.getExtensions();
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);
			expect(loaded.extensions[0].path).toBe(join(packageDir, "extensions", "research.ts"));

			const notify = vi.fn();
			await loaded.extensions[0].commands.get("research-version")?.handler("", {
				hasUI: true,
				ui: { notify },
			} as unknown as ExtensionCommandContext);
			expect(notify).toHaveBeenCalledWith("pi-research-agent v0.1.0", "info");

			settingsManager.setPackages([{ source: packageDir, autoload: false }]);
			await loader.reload();
			expect(loader.getExtensions().extensions).toEqual([]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps manifest contracts aligned", async () => {
		const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
			version: string;
			engines: { node: string };
			peerDependencies: Record<string, string>;
			pi: { extensions: string[]; skills: string[]; prompts: string[] };
		};

		expect(RESEARCH_AGENT_VERSION).toBe(manifest.version);
		expect(manifest.engines.node).toBe(">=22.19.0");
		expect(manifest.pi.extensions).toEqual(["./extensions/research.ts"]);
		expect(manifest.pi.skills).toEqual(["./skills"]);
		expect(manifest.pi.prompts).toEqual(["./prompts"]);
		expect(manifest.peerDependencies).toEqual({
			"@earendil-works/pi-agent-core": "*",
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			typebox: "*",
		});
	});
});
