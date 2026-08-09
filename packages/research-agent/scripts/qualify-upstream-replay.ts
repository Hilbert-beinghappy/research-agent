// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRepository = "https://github.com/Hilbert-beinghappy/research-agent.git";
const targetRepository = "https://github.com/earendil-works/pi.git";
const sourceBaselineCommit = "61628e574878d6ae4927f4019803a151d7829ba2";
const targetCommit = "97f0ccdd96cc207b6ad3630c56eea4d32dbdcf53";
const baselineTree = "3a2cb6544cd4aead69788065b2c32a457043b585";
const maxBuffer = 64 * 1_024 * 1_024;

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function git(args: string[], cwd = repositoryRoot, input?: Uint8Array): Buffer {
	const result = spawnSync("git", args, { cwd, input, maxBuffer });
	if (result.status !== 0) {
		const message = result.stderr.toString("utf8").trim();
		throw new Error(message.length > 0 ? message : `git ${args[0] ?? "command"} failed`);
	}
	return result.stdout;
}

function gitText(args: string[], cwd = repositoryRoot): string {
	return git(args, cwd).toString("utf8").trim();
}

let outputPath: string | null = null;
let upstreamRef: string | null = null;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
	const flag = args[index];
	const value = args[index + 1];
	if ((flag === "--output" || flag === "--upstream-ref") && value !== undefined && !value.startsWith("--")) {
		if (flag === "--output" && outputPath === null) outputPath = resolve(process.cwd(), value);
		else if (flag === "--upstream-ref" && upstreamRef === null) upstreamRef = value;
		else throw new TypeError(`Duplicate ${flag}`);
		index += 1;
		continue;
	}
	throw new TypeError("usage: qualify-upstream-replay.ts --upstream-ref <full-ref> [--output <path>]");
}
if (upstreamRef === null || !upstreamRef.startsWith("refs/")) {
	throw new TypeError("--upstream-ref requires a full refs/... name");
}

const sourceCandidateCommit = gitText(["rev-parse", "--verify", "HEAD^{commit}"]);
const sourceCandidateTree = gitText(["rev-parse", "HEAD^{tree}"]);
const checks = {
	candidateIsHead: false,
	githubShaAbsentOrMatchesHead: false,
	commitObjectsPresent: false,
	upstreamRefMatchesTarget: false,
	baselineTreesMatch: false,
	linearPatchChain: false,
	appliedPatchCountExact: false,
	resultTreeMatchesCandidate: false,
};
const patches: Array<{ id: string; parent: string; tree: string; subject: string }> = [];
let sourcePatchCount = 0;
let resolvedUpstreamCommit: string | null = null;
let result: { commit: string; tree: string } | null = null;
let failure: { stage: string; message: string } | null = null;
let stage = "validate_candidate_identity";
let temporaryDirectory: string | null = null;

try {
	check(sourceCandidateCommit === gitText(["rev-parse", "HEAD"]), "Candidate commit is not checked-out HEAD");
	checks.candidateIsHead = true;
	check(
		process.env.GITHUB_SHA === undefined || process.env.GITHUB_SHA === sourceCandidateCommit,
		"GITHUB_SHA does not match checked-out HEAD",
	);
	checks.githubShaAbsentOrMatchesHead = true;

	stage = "validate_commit_objects";
	for (const commit of [sourceBaselineCommit, sourceCandidateCommit]) {
		check(gitText(["rev-parse", "--verify", `${commit}^{commit}`]) === commit, `Missing commit ${commit}`);
	}
	checks.commitObjectsPresent = true;

	stage = "validate_upstream_ref";
	resolvedUpstreamCommit = gitText(["rev-parse", "--verify", `${upstreamRef}^{commit}`]);
	check(resolvedUpstreamCommit === targetCommit, `${upstreamRef} does not resolve to ${targetCommit}`);
	checks.upstreamRefMatchesTarget = true;

	stage = "validate_recorded_trees";
	check(gitText(["rev-parse", `${sourceBaselineCommit}^{tree}`]) === baselineTree, "Imported baseline tree changed");
	check(gitText(["rev-parse", `${upstreamRef}^{tree}`]) === baselineTree, "Upstream target tree changed");
	checks.baselineTreesMatch = true;

	stage = "validate_patch_chain";
	const chain = gitText(["rev-list", "--reverse", "--parents", `${sourceBaselineCommit}..${sourceCandidateCommit}`])
		.split("\n")
		.filter((line) => line.length > 0);
	sourcePatchCount = chain.length;
	check(chain.length > 0, "Candidate has no patches after the imported baseline");
	let expectedParent = sourceBaselineCommit;
	for (const line of chain) {
		const [id, parent, ...extraParents] = line.split(" ");
		check(id !== undefined && parent !== undefined && extraParents.length === 0, "Patch queue is not single-parent");
		check(parent === expectedParent, `Patch ${id} does not follow ${expectedParent}`);
		patches.push({
			id,
			parent,
			tree: gitText(["rev-parse", `${id}^{tree}`]),
			subject: gitText(["show", "-s", "--format=%s", id]),
		});
		expectedParent = id;
	}
	check(expectedParent === sourceCandidateCommit, "Patch queue does not end at checked-out HEAD");
	checks.linearPatchChain = true;

	stage = "create_temporary_clone";
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-upstream-replay-"));
	const replayRoot = join(temporaryDirectory, "replay");
	git(["clone", "--shared", "--no-checkout", repositoryRoot, replayRoot]);
	git(["checkout", "--detach", targetCommit], replayRoot);

	stage = "apply_patch_queue";
	const mailbox = git(["format-patch", "--stdout", `${sourceBaselineCommit}..${sourceCandidateCommit}`]);
	git(
		[
			"-c",
			"user.name=Doro Replay Qualification",
			"-c",
			"user.email=doro-replay@invalid.example",
			"-c",
			"commit.gpgSign=false",
			"-c",
			"rerere.enabled=false",
			"-c",
			"rerere.autoupdate=false",
			"am",
			"--3way",
		],
		replayRoot,
		mailbox,
	);
	check(
		Number(gitText(["rev-list", "--count", `${targetCommit}..HEAD`], replayRoot)) === patches.length,
		"Replay commit count differs from the patch queue",
	);
	checks.appliedPatchCountExact = true;
	result = {
		commit: gitText(["rev-parse", "HEAD"], replayRoot),
		tree: gitText(["rev-parse", "HEAD^{tree}"], replayRoot),
	};
	check(result.tree === sourceCandidateTree, "Replay result tree differs from checked-out HEAD tree");
	checks.resultTreeMatchesCandidate = true;
} catch (error) {
	failure = { stage, message: error instanceof Error ? error.message : String(error) };
} finally {
	if (temporaryDirectory !== null) {
		try {
			await rm(temporaryDirectory, { recursive: true, force: true });
		} catch (error) {
			failure = {
				stage: "cleanup_temporary_clone",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

const status = failure === null && Object.values(checks).every(Boolean) ? "passed" : "failed";
const report = {
	qualification: "doro-upstream-replay-v1",
	generatedAt: new Date().toISOString(),
	platform: `${process.platform}-${process.arch}`,
	node: process.version,
	source: {
		repository: sourceRepository,
		githubSha: process.env.GITHUB_SHA ?? null,
		baseline: { commit: sourceBaselineCommit, tree: baselineTree },
		candidate: { commit: sourceCandidateCommit, tree: sourceCandidateTree },
	},
	target: {
		repository: targetRepository,
		ref: upstreamRef,
		commit: targetCommit,
		resolvedCommit: resolvedUpstreamCommit,
		tree: baselineTree,
		verification: "explicit-full-ref-resolves-to-exact-commit",
	},
	replay: {
		method: "git-format-patch+git-am-3way",
		baseCommit: targetCommit,
		patchCount: sourcePatchCount,
		orderedPatchIds: patches.map(({ id }) => id),
	},
	patches,
	result,
	conflictDecisions: [],
	checks,
	failure,
	status,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath !== null) {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, output);
}
process.stdout.write(output);
if (status !== "passed") process.exitCode = 1;
