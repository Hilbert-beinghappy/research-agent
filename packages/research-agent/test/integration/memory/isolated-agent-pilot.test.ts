// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../../src/contracts/canonical-json.ts";

type Condition = "memory_on" | "memory_off";
type LifecycleAction = "correct" | "forget" | "delete";

interface ParticipantResult {
	format: "doro-memory-agent-pilot-participant";
	version: 1;
	synthetic: true;
	participantCode: string;
	participantRef: string;
	scenarioCode: string;
	profileId: string;
	homeRef: string;
	order: [Condition, Condition];
	conditionResults: Array<{
		condition: Condition;
		sequence: number;
		applied: boolean;
		receiptDelta: number;
		signalDelta: number;
	}>;
	lifecycle: { action: LifecycleAction; passed: boolean };
	boundaries: {
		profileCount: number;
		restrictedProject: boolean;
		siblingReadBlocked: boolean;
		restrictedSignalDelta: number;
		finalProfileRevision: number;
	};
	betaPilotStarted: false;
	stableStudyEligible: false;
}

const worker = join(import.meta.dirname, "..", "..", "fixtures", "memory-agent-pilot-worker.ts");
const scenarios = [
	"systematic-review",
	"policy-comparison",
	"construct-review",
	"program-evaluation",
	"digital-strategy",
	"algorithm-governance",
	"robustness-plan",
	"interview-coding",
	"meta-analysis",
	"manuscript-review",
] as const;
const preferences = [
	"请记住我的长期偏好：默认用中文",
	"请记住我的长期偏好：因果表述保持保守",
	"请记住我的长期偏好：默认用表格",
	"请记住我的长期偏好：默认用英文",
	"请记住我的长期偏好：因果表述保持保守",
	"请记住我的长期偏好：默认用表格",
	"请记住我的长期偏好：默认用中文",
	"请记住我的长期偏好：默认用英文",
	"请记住我的长期偏好：因果表述保持保守",
	"请记住我的长期偏好：默认用表格",
] as const;
const lifecycles: LifecycleAction[] = [
	"correct",
	"forget",
	"delete",
	"correct",
	"forget",
	"delete",
	"correct",
	"forget",
	"delete",
	"correct",
];

let temporaryDirectory: string | null = null;

afterEach(async () => {
	if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = null;
});

function hmac(secret: string, domain: string, value: string): `hmac-sha256:${string}` {
	return `hmac-sha256:${createHmac("sha256", secret).update(`${domain}\0${value}`).digest("hex")}`;
}

async function runWorker(configPath: string): Promise<void> {
	const child = spawn(process.execPath, ["--experimental-strip-types", worker, "--launch", configPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const [code] = (await once(child, "exit")) as [number | null];
	if (code !== 0) throw new Error(`synthetic participant failed (${code}): ${stderr}`);
}

function exactResult(input: unknown): asserts input is ParticipantResult {
	expect(input).not.toBeNull();
	expect(typeof input).toBe("object");
	const result = input as Record<string, unknown>;
	expect(Object.keys(result).sort()).toEqual(
		[
			"format",
			"version",
			"synthetic",
			"participantCode",
			"participantRef",
			"scenarioCode",
			"profileId",
			"homeRef",
			"order",
			"conditionResults",
			"lifecycle",
			"boundaries",
			"betaPilotStarted",
			"stableStudyEligible",
		].sort(),
	);
	expect(Array.isArray(result.conditionResults)).toBe(true);
	for (const condition of result.conditionResults as Array<Record<string, unknown>>) {
		expect(Object.keys(condition).sort()).toEqual(
			["condition", "sequence", "applied", "receiptDelta", "signalDelta"].sort(),
		);
	}
	expect(Object.keys(result.lifecycle as Record<string, unknown>).sort()).toEqual(["action", "passed"].sort());
	expect(Object.keys(result.boundaries as Record<string, unknown>).sort()).toEqual(
		[
			"profileCount",
			"restrictedProject",
			"siblingReadBlocked",
			"restrictedSignalDelta",
			"finalProfileRevision",
		].sort(),
	);
}

async function allFileText(root: string): Promise<string> {
	const texts: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) texts.push(await readFile(path, "utf8"));
		}
	};
	await walk(root);
	return texts.join("\n");
}

describe("isolated synthetic Agent pilot", () => {
	it.skipIf(process.platform !== "darwin")(
		"runs ten sandboxed participant processes without cross-profile memory or mode leakage",
		async () => {
			temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-agent-pilot-"));
			const coordinatorSecret = "isolated-agent-pilot-test-secret";
			const randomizationSeed = "doro-agent-pilot-v1-2026-08-09";
			expect(createHash("sha256").update(randomizationSeed).digest("hex")).toBe(
				"a42ccf0fbbe455529a812c6abf3843daf61020ad9a0bcae2a446194794ce8df6",
			);
			const participantCodes = Array.from({ length: 10 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`);
			const onFirst = new Set(
				participantCodes
					.map((participantCode) => ({
						participantCode,
						rank: createHash("sha256").update(`${randomizationSeed}\0${participantCode}`).digest("hex"),
					}))
					.sort((left, right) => left.rank.localeCompare(right.rank))
					.slice(0, 5)
					.map(({ participantCode }) => participantCode),
			);
			const configs = [];
			const participantDirectories = participantCodes.map((participantCode) =>
				join(temporaryDirectory as string, participantCode.toLowerCase()),
			);
			await Promise.all(participantDirectories.map((directory) => mkdir(directory)));
			await Promise.all(
				participantDirectories.map((directory, index) =>
					writeFile(join(directory, "probe.txt"), `synthetic-probe-${participantCodes[index]}\n`, { mode: 0o600 }),
				),
			);
			for (let index = 0; index < 10; index += 1) {
				const participantCode = participantCodes[index] as string;
				const participantDirectory = participantDirectories[index] as string;
				const configPath = join(participantDirectory, "config.json");
				const outputPath = join(participantDirectory, "result.json");
				const value = {
					participantCode,
					participantRef: hmac(coordinatorSecret, "participant", participantCode),
					homeRef: hmac(coordinatorSecret, "home", participantCode),
					scenarioCode: scenarios[index],
					profileId: `profile-${participantCode.toLowerCase()}`,
					doroHome: join(participantDirectory, "doro"),
					projectRoot: join(participantDirectory, "project"),
					outputPath,
					forbiddenProbePath: join(
						participantDirectories[(index + 1) % participantDirectories.length] as string,
						"probe.txt",
					),
					order: onFirst.has(participantCode)
						? (["memory_on", "memory_off"] as const)
						: (["memory_off", "memory_on"] as const),
					sessionIds: {
						memory_on: hmac(coordinatorSecret, "session", `${participantCode}:memory_on`),
						memory_off: hmac(coordinatorSecret, "session", `${participantCode}:memory_off`),
					},
					lifecycle: lifecycles[index],
					preference: preferences[index],
				};
				await writeFile(configPath, `${canonicalStringify(value)}\n`, { mode: 0o600 });
				configs.push({ ...value, configPath });
			}

			const outcomes = await Promise.allSettled(configs.map(({ configPath }) => runWorker(configPath)));
			const failure = outcomes.find((outcome) => outcome.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			const rawResults = await Promise.all(
				configs.map(async ({ outputPath }) => JSON.parse(await readFile(outputPath, "utf8")) as unknown),
			);
			const results = rawResults.map((result) => {
				exactResult(result);
				return result;
			});
			expect(new Set(results.map(({ participantRef }) => participantRef)).size).toBe(10);
			expect(new Set(results.map(({ homeRef }) => homeRef)).size).toBe(10);
			expect(results.filter(({ order }) => order[0] === "memory_on")).toHaveLength(5);
			expect(results.filter(({ order }) => order[0] === "memory_off")).toHaveLength(5);
			expect(results.filter(({ lifecycle }) => lifecycle.action === "correct")).toHaveLength(4);
			expect(results.filter(({ lifecycle }) => lifecycle.action === "forget")).toHaveLength(3);
			expect(results.filter(({ lifecycle }) => lifecycle.action === "delete")).toHaveLength(3);

			for (const result of results) {
				expect(result).toMatchObject({
					format: "doro-memory-agent-pilot-participant",
					version: 1,
					synthetic: true,
					lifecycle: { passed: true },
					boundaries: {
						profileCount: 1,
						restrictedProject: true,
						siblingReadBlocked: true,
						restrictedSignalDelta: 0,
					},
					betaPilotStarted: false,
					stableStudyEligible: false,
				});
				const on = result.conditionResults.find(({ condition }) => condition === "memory_on");
				const off = result.conditionResults.find(({ condition }) => condition === "memory_off");
				expect(on).toMatchObject({ applied: true, receiptDelta: 1, signalDelta: 0 });
				expect(off).toMatchObject({ applied: false, receiptDelta: 0, signalDelta: 0 });
			}

			const profileIds = configs.map(({ profileId }) => profileId);
			for (const [index, participant] of configs.entries()) {
				expect(results[index]).toMatchObject({
					participantCode: participant.participantCode,
					participantRef: participant.participantRef,
					homeRef: participant.homeRef,
					scenarioCode: participant.scenarioCode,
					profileId: participant.profileId,
					order: participant.order,
					lifecycle: { action: participant.lifecycle },
				});
				expect(await realpath(participant.doroHome)).not.toBe(await realpath(participant.projectRoot));
				const text = await allFileText(join(participant.doroHome, "profiles", participant.profileId));
				for (const foreignProfileId of profileIds.filter((_, candidateIndex) => candidateIndex !== index)) {
					expect(text).not.toContain(foreignProfileId);
				}
				for (const foreignParticipantCode of participantCodes.filter(
					(_, candidateIndex) => candidateIndex !== index,
				)) {
					expect(text).not.toContain(`qaa-${foreignParticipantCode}`);
				}
			}
			expect(await allFileText(temporaryDirectory)).not.toContain(coordinatorSecret);
		},
		60_000,
	);
});
