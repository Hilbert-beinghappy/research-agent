import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
		test: {
			environment: "node",
			exclude: ["**/._*"],
			fileParallelism: process.platform !== "win32",
			include: ["**/*.test.ts"],
			reporters: ["dot"],
			testTimeout: process.platform === "win32" ? 60_000 : 5_000,
		},
	}),
);
