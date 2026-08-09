// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface ReplayReport {
	qualification: string;
	source: { candidate: { commit: string; tree: string } };
	target: { ref: string; commit: string; resolvedCommit: string | null; verification: string };
	replay: { patchCount: number; orderedPatchIds: string[] };
	result: { commit: string; tree: string } | null;
	checks: Record<string, boolean>;
	failure: { stage: string; message: string } | null;
	status: string;
}

const packageRoot = join(import.meta.dirname, "..", "..");
const repositoryRoot = join(packageRoot, "..", "..");
let temporaryDirectory: string | null = null;

afterEach(async () => {
	if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = null;
});

describe("upstream replay qualification", () => {
	it("writes a failed report when the required upstream ref is missing", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-upstream-replay-test-"));
		const outputPath = join(temporaryDirectory, "report.json");
		const missingRef = `refs/doro-upstream-replay-test/missing-${process.pid}`;
		const executed = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				join(packageRoot, "scripts/qualify-upstream-replay.ts"),
				"--upstream-ref",
				missingRef,
				"--output",
				outputPath,
			],
			{
				cwd: repositoryRoot,
				encoding: "utf8",
				env: { ...process.env, GITHUB_SHA: undefined },
				maxBuffer: 64 * 1_024 * 1_024,
			},
		);
		expect(executed.status).toBe(1);
		const report = JSON.parse(await readFile(outputPath, "utf8")) as ReplayReport;
		expect(report).toMatchObject({
			qualification: "doro-upstream-replay-v1",
			target: {
				ref: missingRef,
				commit: "97f0ccdd96cc207b6ad3630c56eea4d32dbdcf53",
				resolvedCommit: null,
				verification: "explicit-full-ref-resolves-to-exact-commit",
			},
			replay: { patchCount: 0, orderedPatchIds: [] },
			result: null,
			failure: { stage: "validate_upstream_ref" },
			status: "failed",
		});
		expect(report.source.candidate.commit).toMatch(/^[0-9a-f]{40}$/u);
		expect(report.source.candidate.tree).toMatch(/^[0-9a-f]{40}$/u);
		expect(report.checks.upstreamRefMatchesTarget).toBe(false);
	});
});
