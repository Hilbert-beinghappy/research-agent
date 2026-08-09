// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import { configuredProfileRoots, registerMemorySignalCapture } from "../../src/extension/memory-capture.ts";
import { deletePersonalMemory } from "../../src/memory/deletion.ts";
import { applyMemoryFeedback } from "../../src/memory/feedback.ts";
import { memoryProfileRoot } from "../../src/memory/layout.ts";
import { retrievePersonalMemory } from "../../src/memory/retrieval.ts";
import { captureExplicitPreferenceInput } from "../../src/memory/signals.ts";
import { createMemoryProfile, openMemoryProfile } from "../../src/memory/store.ts";
import { initializeProject } from "../../src/project/init.ts";
import { commitProjectTransaction } from "../../src/project/transactions.ts";
import { createStrongProcessLaunch } from "../../src/security/process-isolation.ts";

type Condition = "memory_on" | "memory_off";
type LifecycleAction = "correct" | "forget" | "delete";
type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface PilotConfig {
	participantCode: string;
	participantRef: string;
	homeRef: string;
	scenarioCode: string;
	profileId: string;
	doroHome: string;
	projectRoot: string;
	outputPath: string;
	forbiddenProbePath: string;
	order: [Condition, Condition];
	sessionIds: { memory_on: string; memory_off: string };
	lifecycle: LifecycleAction;
	preference: string;
}

const configKeys = new Set([
	"participantCode",
	"participantRef",
	"homeRef",
	"scenarioCode",
	"profileId",
	"doroHome",
	"projectRoot",
	"outputPath",
	"forbiddenProbePath",
	"order",
	"sessionIds",
	"lifecycle",
	"preference",
]);
const conditionSet = new Set<Condition>(["memory_on", "memory_off"]);
const lifecycleSet = new Set<LifecycleAction>(["correct", "forget", "delete"]);
const hmacPattern = /^hmac-sha256:[a-f0-9]{64}$/u;

function config(input: unknown): PilotConfig {
	if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("invalid config");
	const value = input as Record<string, unknown>;
	if (Object.keys(value).length !== configKeys.size || Object.keys(value).some((key) => !configKeys.has(key))) {
		throw new TypeError("invalid config keys");
	}
	if (
		typeof value.participantCode !== "string" ||
		!/^P(?:0[1-9]|10)$/u.test(value.participantCode) ||
		typeof value.participantRef !== "string" ||
		!hmacPattern.test(value.participantRef) ||
		typeof value.homeRef !== "string" ||
		!hmacPattern.test(value.homeRef) ||
		typeof value.scenarioCode !== "string" ||
		!/^[a-z][a-z0-9-]{0,63}$/u.test(value.scenarioCode) ||
		typeof value.profileId !== "string" ||
		!/^profile-p(?:0[1-9]|10)$/u.test(value.profileId) ||
		typeof value.preference !== "string" ||
		!Array.isArray(value.order) ||
		value.order.length !== 2 ||
		!value.order.every((condition) => conditionSet.has(condition as Condition)) ||
		value.order[0] === value.order[1] ||
		!lifecycleSet.has(value.lifecycle as LifecycleAction)
	) {
		throw new TypeError("invalid config values");
	}
	for (const key of ["doroHome", "projectRoot", "outputPath", "forbiddenProbePath"] as const) {
		if (typeof value[key] !== "string" || !isAbsolute(value[key])) throw new TypeError("invalid config path");
	}
	if (value.sessionIds === null || typeof value.sessionIds !== "object" || Array.isArray(value.sessionIds)) {
		throw new TypeError("invalid session IDs");
	}
	const sessionIds = value.sessionIds as Record<string, unknown>;
	if (
		Object.keys(sessionIds).length !== 2 ||
		typeof sessionIds.memory_on !== "string" ||
		typeof sessionIds.memory_off !== "string" ||
		!hmacPattern.test(sessionIds.memory_on) ||
		!hmacPattern.test(sessionIds.memory_off) ||
		sessionIds.memory_on === sessionIds.memory_off
	) {
		throw new TypeError("invalid session IDs");
	}
	return value as unknown as PilotConfig;
}

function harness(cwd: string, sessionId: string) {
	const handlers = new Map<string, EventHandler[]>();
	const pi = {
		on(event: string, handler: EventHandler): void {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;
	registerMemorySignalCapture(pi);
	const context = {
		cwd,
		model: {
			id: "synthetic-local-model",
			provider: "local",
			baseUrl: "http://127.0.0.1:1/v1",
			contextWindow: 20_000,
		},
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 20_000, percent: 5 }),
		sessionManager: { getSessionId: () => sessionId, getLeafId: () => `${sessionId}-turn` },
		ui: { setStatus: () => undefined },
	} as unknown as ExtensionContext;
	return async (event: string, value: Record<string, unknown>): Promise<unknown[]> => {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(value, context));
		return results;
	};
}

async function writable(profileRoot: string) {
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
	if (opened.mode !== "read-write") throw new Error("profile is not writable");
	return opened;
}

async function runParticipant(input: PilotConfig): Promise<void> {
	let siblingReadBlocked = false;
	try {
		await readFile(input.forbiddenProbePath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM" || code === "ENOENT") siblingReadBlocked = true;
		else throw error;
	}
	if (!siblingReadBlocked) throw new Error("sibling participant data was readable");
	process.env.DORO_HOME = input.doroHome;
	const profileRoot = memoryProfileRoot(input.doroHome, input.profileId);
	await createMemoryProfile(profileRoot, { profileId: input.profileId });
	const configuredRoots = await configuredProfileRoots();
	if (
		configuredRoots.length !== 1 ||
		(await realpath(configuredRoots[0] as string)) !== (await realpath(profileRoot))
	) {
		throw new Error("expected exactly one configured profile");
	}
	const captured = await captureExplicitPreferenceInput(profileRoot, {
		text: input.preference,
		inputSource: "interactive",
		hasAttachments: false,
		observedAt: new Date().toISOString(),
		sourceRefs: [{ kind: "session", locator: `session:${input.sessionIds.memory_on}`, dataClass: "public" }],
	});
	if (captured.outcome !== "persisted") throw new Error("preference was not persisted");
	const activated = await writable(profileRoot);
	const activatedItem = activated.activeItems[0];
	if (activatedItem === undefined || activated.activeItems.length !== 1)
		throw new Error("expected one activated item");
	const canaryValue = `qaa-${input.participantCode}`;
	await applyMemoryFeedback(
		profileRoot,
		{
			feedbackId: `feedback-canary-${input.participantCode.toLowerCase()}`,
			target: { memoryId: activatedItem.memoryId, revision: activatedItem.revision },
			action: "correct",
			correction: { key: "language", value: canaryValue },
			sourceRef: { kind: "session", locator: `session:${input.sessionIds.memory_on}`, dataClass: "public" },
			reasonCode: "synthetic-isolation-canary",
			requestedAt: new Date().toISOString(),
		},
		{ expectedProfileRevision: activated.profile.revision },
	);

	const initialized = await initializeProject(input.projectRoot, {
		title: `Synthetic agent pilot ${input.scenarioCode}`,
		domain: "public-administration",
	});
	if (initialized.compatibility !== "current") throw new Error("project is not current");
	await commitProjectTransaction(input.projectRoot, {
		expectedRevision: initialized.manifest.revision,
		writes: [],
		manifest: {
			...initialized.manifest,
			policy: { ...initialized.manifest.policy, sensitivity: "restricted" },
			revision: initialized.manifest.revision + 1,
			updatedAt: new Date().toISOString(),
		},
	});

	const beforeTasks = await writable(profileRoot);
	const conditionResults = [];
	for (const [index, condition] of input.order.entries()) {
		process.env.DORO_MEMORY_MODE = condition === "memory_on" ? "on" : "off";
		const emit = harness(input.projectRoot, input.sessionIds[condition]);
		const before = await writable(profileRoot);
		await emit("input", {
			type: "input",
			text: "请记住我的长期偏好：默认用英文",
			source: "interactive",
		});
		const result = await emit("before_agent_start", {
			type: "before_agent_start",
			prompt: `Synthetic task ${input.scenarioCode}`,
			systemPrompt: "synthetic-agent-pilot",
			systemPromptOptions: {},
		});
		const after = await writable(profileRoot);
		const first = result[0];
		conditionResults.push({
			condition,
			sequence: index + 1,
			applied:
				first !== null &&
				typeof first === "object" &&
				typeof (first as Record<string, unknown>).systemPrompt === "string" &&
				((first as Record<string, unknown>).systemPrompt as string).includes(
					"User preferences; not domain facts or research evidence.",
				) &&
				((first as Record<string, unknown>).systemPrompt as string).includes(canaryValue),
			receiptDelta: after.counts.receipts - before.counts.receipts,
			signalDelta: after.counts.signals - before.counts.signals,
		});
	}
	const afterTasks = await writable(profileRoot);
	const active = afterTasks.activeItems[0];
	if (active === undefined || afterTasks.activeItems.length !== 1) throw new Error("expected one active item");
	const requestedAt = new Date().toISOString();
	let lifecyclePassed = false;
	if (input.lifecycle === "delete") {
		const deleted = await deletePersonalMemory(
			profileRoot,
			{
				feedbackId: `feedback-delete-${input.participantCode.toLowerCase()}`,
				target: { memoryId: active.memoryId, revision: active.revision },
				sourceRef: { kind: "session", locator: `session:${input.sessionIds.memory_on}`, dataClass: "public" },
				requestedAt,
				reasonCode: "privacy_request",
			},
			{ expectedProfileRevision: afterTasks.profile.revision },
		);
		lifecyclePassed = deleted.verification.status === "verified";
	} else {
		await applyMemoryFeedback(
			profileRoot,
			{
				feedbackId: `feedback-${input.lifecycle}-${input.participantCode.toLowerCase()}`,
				target: { memoryId: active.memoryId, revision: active.revision },
				action: input.lifecycle,
				correction: input.lifecycle === "correct" ? { key: active.key, value: "en-US" } : null,
				sourceRef: { kind: "session", locator: `session:${input.sessionIds.memory_on}`, dataClass: "public" },
				reasonCode: `synthetic-${input.lifecycle}`,
				requestedAt,
			},
			{ expectedProfileRevision: afterTasks.profile.revision },
		);
		const retrieval = await retrievePersonalMemory(profileRoot, {
			taskCategories: ["writing", "output"],
			keywords: [],
			effect: "formatting",
			allowedDataClasses: ["public", "internal"],
			criticalDecision: false,
			availableContextTokens: 20_000,
			requestedMaxTokens: 800,
			now: new Date().toISOString(),
		});
		lifecyclePassed =
			input.lifecycle === "correct"
				? retrieval.status === "applied" && retrieval.items[0]?.revision === active.revision + 1
				: retrieval.status === "empty" && retrieval.items.length === 0;
	}
	const final = await writable(profileRoot);
	const report = {
		format: "doro-memory-agent-pilot-participant",
		version: 1,
		synthetic: true,
		participantCode: input.participantCode,
		participantRef: input.participantRef,
		scenarioCode: input.scenarioCode,
		profileId: input.profileId,
		homeRef: input.homeRef,
		order: input.order,
		conditionResults,
		lifecycle: { action: input.lifecycle, passed: lifecyclePassed },
		boundaries: {
			profileCount: configuredRoots.length,
			restrictedProject: true,
			siblingReadBlocked,
			restrictedSignalDelta: afterTasks.counts.signals - beforeTasks.counts.signals,
			finalProfileRevision: final.profile.revision,
		},
		betaPilotStarted: false,
		stableStudyEligible: false,
	};
	await writeFile(input.outputPath, `${canonicalStringify(report)}\n`, { flag: "wx", mode: 0o600 });
}

function within(root: string, path: string): boolean {
	const candidate = relative(root, path);
	return (
		candidate !== "" &&
		!isAbsolute(candidate) &&
		candidate !== ".." &&
		!candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	);
}

async function launchParticipant(configPath: string, input: PilotConfig): Promise<void> {
	const assignedRoot = resolve(dirname(configPath));
	if (
		![input.doroHome, input.projectRoot, input.outputPath].every((path) => within(assignedRoot, path)) ||
		within(assignedRoot, input.forbiddenProbePath)
	) {
		throw new TypeError("participant paths violate isolation boundaries");
	}
	const cwd = await realpath(assignedRoot);
	const packageRoot = join(import.meta.dirname, "..", "..");
	const launch = await createStrongProcessLaunch({
		executable: process.execPath,
		args: ["--experimental-strip-types", import.meta.filename, "--run", configPath],
		cwd,
		readRoots: [
			packageRoot,
			join(packageRoot, "..", "research-agent-contracts"),
			join(packageRoot, "..", "..", "node_modules"),
		],
	});
	const child = spawn(launch.executable, launch.args, { cwd, stdio: "inherit" });
	const [code] = (await once(child, "exit")) as [number | null];
	if (code !== 0) throw new Error("isolated participant process failed");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length !== 2 || (args[0] !== "--launch" && args[0] !== "--run")) throw new TypeError("usage");
	const input = config(JSON.parse(await readFile(args[1] as string, "utf8")) as unknown);
	if (args[0] === "--launch") await launchParticipant(args[1] as string, input);
	else await runParticipant(input);
}

await main().catch(() => {
	process.stderr.write("synthetic agent pilot worker failed\n");
	process.exitCode = 1;
});
