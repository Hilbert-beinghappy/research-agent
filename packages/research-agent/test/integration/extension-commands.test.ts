import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness as createPiHarness, fauxModel } from "../../../coding-agent/test/test-harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../../coding-agent/test/utilities.ts";
import researchExtension from "../../extensions/research.ts";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import {
	RESEARCH_LEGACY_SCHEMA_VERSION,
	RESEARCH_SCHEMA_VERSION,
	type ResearchTask,
} from "../../src/contracts/schemas.ts";
import { BUILT_IN_DOMAIN_PACKAGE_VERSION } from "../../src/domain/packages.ts";
import { RESEARCH_SESSION_ENTRY_TYPE } from "../../src/extension/commands.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes } from "../../src/kernel/integrity.ts";
import { memoryProfileRoot } from "../../src/memory/layout.ts";
import { retrievePersonalMemoryForUse } from "../../src/memory/receipts.ts";
import { appendMemoryItem, createMemoryProfile, openMemoryProfile } from "../../src/memory/store.ts";
import { runMemoryTransaction } from "../../src/memory/transactions.ts";
import { initializeProject } from "../../src/project/init.ts";
import { PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import { openProject } from "../../src/project/open.ts";
import { calculateRecordSetIndex, listProjectRecordIds, projectRecordPath } from "../../src/project/record-index.ts";
import { readRecord } from "../../src/project/records.ts";
import { commitProjectTransaction, prepareProjectTransaction } from "../../src/project/transactions.ts";
import { validateProject } from "../../src/project/validate.ts";
import { RESEARCH_AGENT_PACKAGE_VERSION } from "../../src/version.ts";
import { itemDraft, retrievalQuery } from "./memory/security/retrieval-fixtures.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface SessionEntryData {
	type: "custom";
	customType: string;
	data: unknown;
	id: string;
	parentId: string | null;
	timestamp: string;
}

function createHarness(initialEntries: SessionEntryData[] = []) {
	const commands = new Map<string, CommandHandler>();
	const handlers = new Map<string, EventHandler[]>();
	const sessionEntries = [...initialEntries];
	const notify = vi.fn();
	const confirm = vi.fn(async () => true);
	const input = vi.fn(async () => "correct horse transfer secret");
	const select = vi.fn(async (_title: string, options: string[]) => options[0]);
	const setStatus = vi.fn();
	const setHeader = vi.fn();
	let activeTools = ["read", "bash", "edit", "write"];
	const setActiveTools = vi.fn((names: string[]) => {
		activeTools = [...names];
	});
	const pi = {
		registerTool(tool: { name: string }): void {
			activeTools = [...new Set([...activeTools, tool.name])];
		},
		registerCommand(name: string, options: { handler: CommandHandler }): void {
			commands.set(name, options.handler);
		},
		on(event: string, handler: EventHandler): void {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		appendEntry(customType: string, data: unknown): void {
			sessionEntries.push({
				type: "custom",
				customType,
				data,
				id: `entry-${sessionEntries.length + 1}`,
				parentId: sessionEntries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
			});
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools,
	} as unknown as ExtensionAPI;
	researchExtension(pi);

	const context = (cwd: string, hasUI = true): ExtensionCommandContext =>
		({
			cwd,
			hasUI,
			mode: hasUI ? "tui" : "print",
			ui: { notify, confirm, input, select, setStatus, setHeader },
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => join(cwd, "session.jsonl"),
				getEntries: () => [...sessionEntries],
			},
		}) as unknown as ExtensionCommandContext;

	return {
		commands,
		sessionEntries,
		notify,
		confirm,
		input,
		select,
		setHeader,
		setActiveTools,
		activeTools: () => activeTools,
		context,
		emit: async (event: string, value: Record<string, unknown>, ctx: ExtensionContext) => {
			const results = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler(value, ctx));
			return results;
		},
	};
}

function commandResult(harness: ReturnType<typeof createHarness>): Record<string, unknown> {
	const call = harness.notify.mock.calls.at(-1);
	if (call === undefined || typeof call[0] !== "string") throw new Error("command did not notify a result");
	return JSON.parse(call[0]) as Record<string, unknown>;
}

function syntheticTask(taskId: string, operationId: string): ResearchTask {
	const now = new Date().toISOString();
	return {
		kind: "task",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		taskId,
		taskType: "synthetic_recovery",
		title: "Recover a staged synthetic task",
		inputs: [],
		inputFiles: [],
		expectedOutputs: ["recovered task"],
		outputs: [],
		outputFiles: [],
		dependencyTaskIds: [],
		status: "planned",
		attemptCount: 0,
		maxAttempts: 1,
		idempotencyKey: `recovery:${taskId}`,
		operationIds: [operationId],
		errors: [],
		resumeCursor: null,
		budget: { estimated: null, actual: { amount: 0, currency: "USD" } },
		createdAt: now,
		startedAt: null,
		finishedAt: null,
		updatedAt: now,
		revision: 0,
	};
}

let temporaryDirectory: string | undefined;

afterEach(async () => {
	vi.unstubAllEnvs();
	if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("research extension commands", () => {
	it("restores governed project state after a real Pi compaction and extension reload", async () => {
		const compactionEntryIds: string[] = [];
		let researchExtensionLoads = 0;
		const extensionFactories = [
			{
				path: "<research-agent-compaction-reload>",
				factory: (pi: ExtensionAPI) => {
					researchExtensionLoads += 1;
					researchExtension(pi);
				},
			},
			{
				path: "<deterministic-compaction-fixture>",
				factory: (pi: ExtensionAPI) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Deterministic compaction fixture summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", (event) => {
						compactionEntryIds.push(event.compactionEntry.id);
					});
				},
			},
		];
		const loadExtensions = () => createTestExtensionsResult(extensionFactories);
		let extensionsResult = await loadExtensions();
		const baseResourceLoader = createTestResourceLoader();
		const resourceLoader = {
			...baseResourceLoader,
			getExtensions: () => extensionsResult,
			reload: async () => {
				extensionsResult = await loadExtensions();
			},
		};
		const harness = await createPiHarness({
			model: {
				...fauxModel,
				id: "remote-compaction-fixture",
				provider: "remote-compaction-fixture",
				baseUrl: "https://remote-model.invalid/v1",
			},
			responses: ["first fixture response", "second fixture response"],
			resourceLoader,
			settings: { compaction: { keepRecentTokens: 1 } },
		});

		try {
			const projectRoot = join(harness.tempDir, "project");
			const initialized = await initializeProject(projectRoot, { title: "Compaction reload fixture" });
			if (initialized.compatibility !== "current") throw new Error("expected current project");
			await commitProjectTransaction(projectRoot, {
				expectedRevision: initialized.manifest.revision,
				writes: [],
				manifest: {
					...initialized.manifest,
					policy: { ...initialized.manifest.policy, modelEgressAllowed: false },
					revision: initialized.manifest.revision + 1,
					updatedAt: new Date().toISOString(),
				},
			});

			await harness.session.bindExtensions({ shutdownHandler: () => {} });
			await harness.session.prompt(`/research-open "${projectRoot}"`);
			expect(harness.session.getActiveToolNames()).toEqual([]);

			await harness.session.prompt("first compactable fixture turn");
			await harness.session.prompt("second compactable fixture turn");
			await harness.session.compact();

			const compactionEntry = harness.sessionManager
				.getEntries()
				.reverse()
				.find((entry) => entry.type === "compaction");
			expect(compactionEntry).toMatchObject({
				type: "compaction",
				summary: "Deterministic compaction fixture summary",
				fromHook: true,
			});
			expect(compactionEntryIds).toEqual([compactionEntry?.id]);

			await harness.session.reload();

			expect(researchExtensionLoads).toBe(2);
			expect(harness.session.getAllTools().map(({ name }) => name)).toContain("research_query_corpus");
			expect(harness.session.getActiveToolNames()).toEqual([]);
			const restored = await harness.session.extensionRunner.emitBeforeAgentStart("continue", undefined, "base", {
				cwd: harness.tempDir,
			});
			expect(restored?.systemPrompt).toContain("Governed research mode is active");
			expect(restored?.systemPrompt).toContain(initialized.manifest.projectId);
			expect(restored?.systemPrompt).toContain('"modelEgressAllowed":false');
		} finally {
			harness.cleanup();
		}
	});

	it("runs the M0 project, recovery, session, governance, and policy slice", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-commands-"));
		const projectRoot = join(temporaryDirectory, "fixture project");
		await mkdir(projectRoot);
		const harness = createHarness();
		const ctx = harness.context(projectRoot);

		expect([...harness.commands.keys()].sort()).toEqual([
			"memory",
			"research-adapter",
			"research-backup",
			"research-doctor",
			"research-domain",
			"research-exchange",
			"research-init",
			"research-migrate",
			"research-model-route",
			"research-monitor",
			"research-open",
			"research-policy",
			"research-recover",
			"research-restore",
			"research-resume",
			"research-status",
			"research-validate",
			"research-version",
		]);
		await harness.commands.get("research-init")?.('"Fixture Project"', ctx);
		expect(commandResult(harness)).toMatchObject({ ok: true, value: { revision: 2 } });
		await harness.commands.get("research-init")?.('"Fixture Project"', ctx);
		expect(commandResult(harness)).toMatchObject({ ok: true, value: { revision: 2 } });

		let opened = await openProject(projectRoot, 2);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		expect(opened.manifest.recordSets.find(({ kind }) => kind === "operation")?.count).toBe(1);
		expect(opened.manifest.recordSets.find(({ kind }) => kind === "task")?.count).toBe(1);
		expect(opened.manifest.activeTaskIds).toHaveLength(1);
		const linkEntry = harness.sessionEntries.at(-1);
		expect(linkEntry?.customType).toBe(RESEARCH_SESSION_ENTRY_TYPE);
		expect(Object.keys(linkEntry?.data as object).sort()).toEqual([
			"lastOperationId",
			"manifestPath",
			"manifestRevision",
			"projectId",
		]);

		await harness.commands.get("research-status")?.("", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { revision: 2, recordCounts: { source: 0, task: 1, operation: 1 } },
		});
		await harness.commands.get("research-resume")?.("", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { tasks: [{ status: "planned" }], operations: [{ status: "planned" }] },
		});
		await harness.commands.get("research-validate")?.("", ctx);
		expect(commandResult(harness)).toMatchObject({ ok: true, value: { valid: true, checkedRecords: 2 } });

		const operationId = (await listProjectRecordIds(projectRoot, opened.manifest, "operation"))[0];
		if (operationId === undefined) throw new Error("missing bootstrap operation");
		const taskId = createOpaqueId("task");
		const task = syntheticTask(taskId, operationId);
		const content = `${canonicalStringify(task)}\n`;
		const taskIndex = await calculateRecordSetIndex(projectRoot, opened.manifest, "task", {
			id: taskId,
			hash: hashBytes(content),
		});
		const transactionId = await prepareProjectTransaction(projectRoot, {
			expectedRevision: opened.manifest.revision,
			writes: [{ path: projectRecordPath(opened.manifest, "task", taskId), content }],
			manifest: {
				...opened.manifest,
				activeTaskIds: [...opened.manifest.activeTaskIds, taskId],
				recordSets: opened.manifest.recordSets.map((recordSet) =>
					recordSet.kind === "task" ? { ...recordSet, ...taskIndex } : recordSet,
				),
				lastCommittedOperationId: operationId,
				updatedAt: new Date().toISOString(),
				revision: opened.manifest.revision + 1,
			},
		});
		await harness.commands.get("research-validate")?.("", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: false,
			errors: [{ code: "PROJECT_VALIDATION_FAILED", details: { pendingTransactionIds: [transactionId] } }],
		});
		await harness.commands.get("research-recover")?.(`commit ${transactionId}`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { recovered: [{ transactionId, action: "commit" }], revision: 3 },
		});
		expect(await readRecord(projectRoot, "task", taskId)).toMatchObject({ ok: true, value: { taskId } });
		await harness.commands.get("research-validate")?.("", ctx);
		expect(commandResult(harness)).toMatchObject({ ok: true, value: { valid: true, checkedRecords: 3 } });

		const noUiContext = harness.context(projectRoot, false);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await harness.commands.get("research-policy")?.(
			'set {"sensitivity":"internal","modelEgressAllowed":false}',
			noUiContext,
		);
		const machineResult = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
		stdout.mockRestore();
		expect(machineResult).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "POLICY_CONFIRMATION_REQUIRED" }],
		});
		expect(await openProject(projectRoot, 3)).toMatchObject({ manifest: { policy: { sensitivity: "public" } } });

		await harness.commands.get("research-policy")?.('set {"sensitivity":"internal","modelEgressAllowed":false}', ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { revision: 9, policy: { sensitivity: "internal", modelEgressAllowed: false } },
		});
		opened = await openProject(projectRoot, 9);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		expect(opened.manifest.recordSets.find(({ kind }) => kind === "approval")?.count).toBe(1);
		expect(opened.manifest.recordSets.find(({ kind }) => kind === "operation")?.count).toBe(2);
		await harness.commands.get("research-validate")?.("", ctx);
		expect(commandResult(harness)).toMatchObject({ ok: true, value: { valid: true, revision: 9 } });

		const latestLink = harness.sessionEntries.at(-1);
		if (latestLink === undefined) throw new Error("missing refreshed project link");
		for (let session = 1; session <= 10; session += 1) {
			const resumed = createHarness([latestLink]);
			const resumedContext = resumed.context(projectRoot);
			await resumed.emit("session_start", { type: "session_start", reason: `resume-${session}` }, resumedContext);
			expect(resumed.setActiveTools).toHaveBeenCalled();
		}
		const reloaded = createHarness([latestLink]);
		const reloadContext = reloaded.context(projectRoot);
		await reloaded.emit("session_start", { type: "session_start", reason: "reload" }, reloadContext);
		expect(reloaded.activeTools()).toEqual([]);
		const promptResults = await reloaded.emit(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
			reloadContext,
		);
		expect(promptResults.at(-1)).toMatchObject({ systemPrompt: expect.stringContaining("Governed research mode") });
		expect(
			(await reloaded.emit("tool_call", { type: "tool_call", toolName: "write", input: {} }, reloadContext)).at(-1),
		).toMatchObject({ block: true });
		expect(
			(await reloaded.emit("tool_call", { type: "tool_call", toolName: "read", input: {} }, reloadContext)).at(-1),
		).toMatchObject({ block: true, reason: expect.stringContaining("disables model data egress") });
		expect(
			(await reloaded.emit("user_bash", { type: "user_bash", command: "pwd" }, reloadContext)).at(-1),
		).toMatchObject({
			result: { exitCode: 1 },
		});

		const openedFromAnotherSession = createHarness();
		const parentContext = openedFromAnotherSession.context(temporaryDirectory);
		await openedFromAnotherSession.commands.get("research-open")?.(`"${projectRoot}"`, parentContext);
		expect(commandResult(openedFromAnotherSession)).toMatchObject({ ok: true, value: { revision: 9 } });
		expect(openedFromAnotherSession.activeTools()).toEqual([]);

		const ordinary = createHarness();
		const ordinaryContext = {
			...ordinary.context(temporaryDirectory),
			model: { id: "deepseek-v4-flash" },
			thinkingLevel: "max",
		} as unknown as ExtensionContext;
		await ordinary.emit("session_start", { type: "session_start", reason: "new" }, ordinaryContext);
		const theme = {
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		} as unknown as Theme;
		const headerFactory = ordinary.setHeader.mock.calls.at(-1)?.[0] as
			| ((tui: unknown, theme: Theme) => { render: (width: number) => string[] })
			| undefined;
		const header = headerFactory?.(undefined, theme).render(80);
		expect(header).toHaveLength(12);
		expect(header?.[0]).toContain(`Doro Research Agent v${RESEARCH_AGENT_PACKAGE_VERSION}`);
		expect(header?.[1]).toContain("deepseek-v4-flash with max effort");
		expect(header?.join("\n")).not.toContain("Powered by Pi");
		expect(header?.[2]).toContain(temporaryDirectory);
		expect(header?.join("\n")).toContain("65;177;225");
		expect(header?.join("\n")).toContain("255;211;54");
		expect(header?.join("\n")).toContain("239;145;163");
		expect(header?.[0]?.startsWith("\x1b[0m ")).toBe(true);
		expect(ordinary.activeTools()).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"research_search_sources",
			"research_import_sources",
			"research_documents",
			"research_query_corpus",
			"research_commit_evidence",
			"research_verify_citations",
			"research_artifacts",
			"research_knowledge",
			"research_monitor",
			"research_design",
			"research_analysis",
			"research_qualitative",
			"research_manuscript",
			"research_review",
			"research_memory_inspect",
			"research_memory_feedback",
		]);
		expect(
			(await ordinary.emit("tool_call", { type: "tool_call", toolName: "write", input: {} }, ordinaryContext)).at(
				-1,
			),
		).toBeUndefined();

		const brokenLink = {
			...latestLink,
			data: {
				...(latestLink.data as object),
				manifestPath: join(temporaryDirectory, "missing", "research-project.json"),
			},
		};
		const failedClosed = createHarness([brokenLink]);
		const failedContext = failedClosed.context(temporaryDirectory);
		await failedClosed.emit("session_start", { type: "session_start", reason: "reload" }, failedContext);
		expect(failedClosed.activeTools()).toEqual([]);
		expect(
			(await failedClosed.emit("tool_call", { type: "tool_call", toolName: "write", input: {} }, failedContext)).at(
				-1,
			),
		).toMatchObject({ block: true });
	});

	it("manages one Personal Memory profile through the bounded /memory command family", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-memory-commands-"));
		const doroHome = join(temporaryDirectory, "source-home");
		const profileId = "profile-command";
		const profileRoot = memoryProfileRoot(doroHome, profileId);
		const created = await createMemoryProfile(profileRoot, { profileId });
		if (created.mode !== "read-write") throw new Error("expected writable memory profile");
		await runMemoryTransaction(profileRoot, 0, (profile, transactionId) => ({
			profile: {
				...profile,
				revision: 1,
				sensitivityPolicy: {
					...profile.sensitivityPolicy,
					allowedDataClasses: ["public", "internal", "restricted"],
				},
				updatedAt: new Date().toISOString(),
				lastTransactionId: transactionId,
			},
			writes: [],
			result: null,
		}));
		await appendMemoryItem(
			profileRoot,
			itemDraft(profileId, "memory-language", {
				category: "writing",
				key: "language",
				value: "zh-CN",
				allowedEffects: ["formatting"],
			}),
			{ expectedProfileRevision: 1 },
		);
		await appendMemoryItem(
			profileRoot,
			{
				...itemDraft(profileId, "memory-secret", {
					category: "writing",
					key: "tone",
					value: "conservative",
					dataClass: "restricted",
					allowedEffects: ["formatting"],
				}),
				status: "quarantined",
				scope: { level: "project", projectId: "restricted-project" },
				allowedEffects: [],
			},
			{ expectedProfileRevision: 2 },
		);
		await retrievePersonalMemoryForUse(profileRoot, retrievalQuery(), {
			sessionRef: { kind: "session", locator: "session:memory-command", dataClass: "internal" },
			taskRef: { kind: "task", locator: "task:memory-command", dataClass: "internal" },
			decisionCodeBefore: "format.default",
			decisionCodeAfter: "format.personalized",
			explanationCodes: ["memory.preference_applied"],
			criticalResearchDecisionTouched: false,
			approvalRequired: false,
			appliedAt: "2026-08-08T12:00:00.000Z",
		});
		vi.stubEnv("DORO_HOME", doroHome);
		const harness = createHarness();
		const ctx = harness.context(temporaryDirectory);

		await harness.commands.get("memory")?.("status", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { availability: "available", profileRevision: 4, profileStatus: "active", activeItemCount: 1 },
		});
		await harness.commands.get("memory")?.("list writing", ctx);
		expect(commandResult(harness)).toMatchObject({ ok: true, value: { items: [{}, {}] } });
		expect(harness.notify.mock.calls.at(-1)?.[0]).not.toContain("conservative");
		await harness.commands.get("memory")?.("show memory-secret", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { item: { memoryId: "memory-secret", value: "[redacted:restricted]" } },
		});
		expect(harness.notify.mock.calls.at(-1)?.[0]).not.toContain("conservative");
		await harness.commands.get("memory")?.("explain last", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { receipt: { effect: "formatting", decisionCodeAfter: "format.personalized" } },
		});
		expect(harness.notify.mock.calls.at(-1)?.[0]).not.toContain("session:memory-command");

		const bundlePath = join(temporaryDirectory, "profile.doro-memory");
		await harness.commands.get("memory")?.(`export "${bundlePath}"`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { destinationName: "profile.doro-memory", profileId, profileRevision: 4 },
		});
		expect(harness.notify.mock.calls.at(-1)?.[0]).not.toContain(temporaryDirectory);
		await expect(access(bundlePath)).resolves.toBeUndefined();
		const conflictHome = join(temporaryDirectory, "conflict-home");
		await createMemoryProfile(memoryProfileRoot(conflictHome, "profile-other"), { profileId: "profile-other" });
		vi.stubEnv("DORO_HOME", conflictHome);
		await harness.commands.get("memory")?.(`import "${bundlePath}"`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: false,
			status: "DATA_CONFLICT",
			errors: [{ code: "MEMORY_IMPORT_PROFILE_CONFLICT" }],
		});
		await expect(access(memoryProfileRoot(conflictHome, profileId))).rejects.toThrow();
		const targetHome = join(temporaryDirectory, "target-home");
		vi.stubEnv("DORO_HOME", targetHome);
		await harness.commands.get("memory")?.(`import "${bundlePath}"`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { outcome: "imported", profileId, manifestRecorded: true },
		});
		await expect(openMemoryProfile(memoryProfileRoot(targetHome, profileId))).resolves.toMatchObject({
			mode: "read-write",
			activeItems: expect.arrayContaining([
				expect.objectContaining({ memoryId: "memory-language", value: "zh-CN" }),
			]),
		});
		vi.stubEnv("DORO_HOME", doroHome);

		await harness.commands.get("memory")?.("pause", ctx);
		expect(commandResult(harness)).toMatchObject({ ok: true, value: { changed: true, profileStatus: "paused" } });
		await harness.emit(
			"input",
			{ type: "input", text: "请记住我的长期偏好：默认用中文", source: "interactive" },
			ctx,
		);
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 6, status: "paused" },
			activeItems: [],
			counts: { signals: 0 },
		});
		await harness.commands.get("memory")?.("resume", ctx);
		expect(commandResult(harness)).toMatchObject({ ok: true, value: { changed: true, profileStatus: "active" } });
		await harness.emit(
			"input",
			{ type: "input", text: "请记住我的长期偏好：默认用中文", source: "interactive" },
			ctx,
		);
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({
			mode: "read-write",
			profile: { revision: 8, status: "active" },
			counts: { signals: 1 },
		});

		await harness.commands.get("memory")?.('correct memory-language --value "en-US"', ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { item: { memoryId: "memory-language", revision: 2, value: "en-US" } },
		});
		await harness.commands.get("memory")?.("forget memory-language", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { item: { memoryId: "memory-language", revision: 3, status: "forgotten", value: null } },
		});
		await harness.commands.get("memory")?.("delete memory-secret", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: {
				committed: true,
				memoryId: "memory-secret",
				verificationTransactionId: expect.any(String),
				verification: {
					verificationId: expect.any(String),
					deletionTransactionId: expect.any(String),
					status: "verified",
				},
			},
		});
		await harness.commands.get("memory")?.("verify-delete memory-secret", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: {
				status: "verified",
				residueCodes: [],
				attestationRecorded: true,
				verificationTransactionId: expect.any(String),
			},
		});
		await harness.commands.get("memory")?.("verify-delete memory-missing", ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			errors: [{ code: "MEMORY_DELETE_VERIFICATION_FAILED", category: "integrity" }],
			value: {
				memoryId: "memory-missing",
				status: "failed",
				attestationRecorded: false,
				verificationTransactionId: null,
				errorCode: "MEMORY_DELETE_VERIFICATION_FAILED",
			},
		});
		await expect(openMemoryProfile(profileRoot)).resolves.toMatchObject({ counts: { audit: 2 } });

		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await harness.commands.get("memory")?.("status", harness.context(temporaryDirectory, false));
		expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: true });
		await harness.commands.get("memory")?.("pause", harness.context(temporaryDirectory, false));
		expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "MEMORY_CONFIRMATION_REQUIRED" }],
		});
		stdout.mockRestore();
		expect(JSON.stringify(harness.notify.mock.calls)).not.toContain("correct horse transfer secret");
	});

	it("creates the first Personal Memory profile only after interactive confirmation", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-memory-first-use-"));
		const agentDir = join(temporaryDirectory, "pi-agent");
		const doroHome = join(agentDir, "doro");
		vi.stubEnv("DORO_HOME", "");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const harness = createHarness();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await harness.commands.get("memory")?.("status", harness.context(temporaryDirectory, false));
		expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
			ok: true,
			value: { availability: "unavailable", reasonCode: "memory.profile_unavailable" },
		});
		stdout.mockRestore();
		await expect(access(join(doroHome, "profiles"))).rejects.toThrow();

		await harness.commands.get("memory")?.("status", harness.context(temporaryDirectory));
		const initialized = commandResult(harness);
		expect(initialized).toMatchObject({
			ok: true,
			value: { availability: "available", profileRevision: 0, profileStatus: "active" },
		});
		expect(harness.confirm).toHaveBeenCalledWith(
			"Initialize Personal Memory",
			expect.stringContaining("empty, local Doro memory profile"),
		);
		const profileId = (initialized.value as { profileId: string }).profileId;
		await expect(openMemoryProfile(memoryProfileRoot(doroHome, profileId))).resolves.toMatchObject({
			mode: "read-write",
			profile: { profileId, revision: 0, status: "active" },
		});
		if (process.platform !== "win32") {
			expect((await stat(memoryProfileRoot(doroHome, profileId))).mode & 0o777).toBe(0o700);
		}
	});

	it("persists a deterministic model-route decision without calling a model", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-model-route-command-"));
		const projectRoot = join(temporaryDirectory, "project");
		await mkdir(projectRoot);
		const harness = createHarness();
		const ctx = harness.context(projectRoot);
		await harness.commands.get("research-init")?.('"Route Project"', ctx);
		await harness.commands.get("research-model-route")?.(
			JSON.stringify({
				request: {
					dataClasses: ["public_metadata"],
					requiredCapabilities: ["structured-output"],
					estimatedInputTokens: 100,
					maxCost: null,
				},
				candidates: [
					{
						provider: "local",
						model: "fixture-local",
						local: true,
						available: true,
						capabilities: ["structured-output"],
						contextWindow: 1_000,
						estimatedCost: { amount: 0, currency: "USD" },
					},
				],
			}),
			ctx,
		);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: {
				kind: "model_route_decision",
				selected: { model: "fixture-local" },
			},
			meta: { operationId: expect.any(String) },
		});
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		expect(opened.manifest.recordSets.find(({ kind }) => kind === "model_route_decision")?.count).toBe(1);
		expect(opened.manifest.recordSets.find(({ kind }) => kind === "operation")?.count).toBe(2);
		expect((await validateProject(projectRoot)).issues).toEqual([]);
	});

	it("registers an Adapter and requires ledgered approval for exchange writes", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-exchange-command-"));
		const projectRoot = join(temporaryDirectory, "project");
		const bundle = join(temporaryDirectory, "bundle");
		const imported = join(temporaryDirectory, "imported");
		const exampleAdapter = fileURLToPath(new URL("../../examples/adapters/open-catalog/", import.meta.url));
		await mkdir(projectRoot);
		const harness = createHarness();
		const ctx = harness.context(projectRoot);
		await harness.commands.get("research-init")?.('"Exchange Project"', ctx);
		await harness.commands.get("research-policy")?.('set {"unknownThirdPartyCode":"ask"}', ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { policy: { unknownThirdPartyCode: "ask" } },
		});

		await harness.commands.get("research-adapter")?.(`inspect "${exampleAdapter}"`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { packageId: "example-open-catalog", contractVersion: 1 },
		});
		await harness.commands.get("research-adapter")?.(`register "${exampleAdapter}"`, ctx);
		const adapterRegistration = commandResult(harness);
		const adapterRegistered = adapterRegistration.ok === true;
		if (process.platform === "darwin") expect(adapterRegistered).toBe(true);
		else if (process.platform === "win32") expect(adapterRegistered).toBe(false);
		if (adapterRegistered) {
			expect(adapterRegistration).toMatchObject({
				ok: true,
				value: {
					status: "active",
					manifest: { packageId: "example-open-catalog" },
					conformance: { passed: true },
					isolationProfile: "strong_isolation",
				},
			});
		} else {
			expect(adapterRegistration).toMatchObject({
				ok: false,
				status: "PERMISSION_BLOCKED",
				errors: [{ code: "ADAPTER_CONFORMANCE_BLOCKED" }],
			});
		}

		await harness.commands.get("research-exchange")?.(`pack "${bundle}"`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { manifest: { format: "pi-research-exchange-bundle", includesRawMaterials: false } },
		});
		await expect(access(join(bundle, "bundle.json"))).resolves.toBeUndefined();
		expect(harness.confirm).toHaveBeenCalledWith(
			"Confirm research project exchange",
			expect.stringContaining("without raw project material"),
		);

		await harness.commands.get("research-exchange")?.(
			`unpack ${JSON.stringify({ bundle, destination: imported })}`,
			ctx,
		);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: { manifest: { projectId: expect.any(String) } },
		});
		await expect(openProject(imported)).resolves.toMatchObject({ compatibility: "current" });
		expect((await validateProject(projectRoot)).issues).toEqual([]);
		expect((await openProject(projectRoot)).manifest).toMatchObject({
			recordSets: expect.arrayContaining([
				expect.objectContaining({ kind: "adapter_registration", count: adapterRegistered ? 1 : 0 }),
				expect.objectContaining({ kind: "exchange_record", count: 2 }),
			]),
		});

		const deniedBundle = join(temporaryDirectory, "no-ui-bundle");
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await harness.commands.get("research-exchange")?.(`pack "${deniedBundle}"`, harness.context(projectRoot, false));
		const denied = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
		stdout.mockRestore();
		expect(denied).toMatchObject({ ok: false, status: "PERMISSION_BLOCKED" });
		await expect(access(deniedBundle)).rejects.toThrow();
	});

	it("initializes and changes a domain only through a confirmed manifest update", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-domain-command-"));
		const projectRoot = join(temporaryDirectory, "domain-project");
		await mkdir(projectRoot);
		const harness = createHarness();
		const ctx = harness.context(projectRoot);
		await harness.commands.get("research-init")?.('--domain sociology "Domain Fixture"', ctx);
		expect(await openProject(projectRoot)).toMatchObject({
			manifest: {
				title: "Domain Fixture",
				domain: {
					id: "sociology",
					templatePackage: "pi-research-domain-sociology",
					templateVersion: BUILT_IN_DOMAIN_PACKAGE_VERSION,
				},
			},
		});

		const managementManifest = fileURLToPath(new URL("../../domains/management/domain.json", import.meta.url));
		const noUiContext = harness.context(projectRoot, false);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await harness.commands.get("research-domain")?.(`set "${managementManifest}"`, noUiContext);
		const blocked = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
		stdout.mockRestore();
		expect(blocked).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "DOMAIN_CONFIRMATION_REQUIRED" }],
		});

		harness.confirm.mockResolvedValueOnce(false);
		await harness.commands.get("research-domain")?.(`set "${managementManifest}"`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: false,
			errors: [{ code: "DOMAIN_UPDATE_DENIED" }],
		});
		expect(await openProject(projectRoot)).toMatchObject({ manifest: { domain: { id: "sociology" } } });

		await harness.commands.get("research-domain")?.(`set "${managementManifest}"`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: {
				domain: {
					id: "management",
					templatePackage: "pi-research-domain-management",
					templateVersion: "1.1.0",
				},
				approvalId: expect.any(String),
			},
		});
		expect(await openProject(projectRoot)).toMatchObject({ manifest: { domain: { id: "management" } } });
		const promptResults = await harness.emit(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
			ctx,
		);
		expect(promptResults.at(-1)).toMatchObject({
			systemPrompt: expect.stringContaining("unit-of-analysis"),
		});

		const sameVersionManifest = JSON.parse(await readFile(managementManifest, "utf8")) as {
			resources: { value: unknown }[];
		};
		sameVersionManifest.resources[0] = {
			...sameVersionManifest.resources[0],
			value: ["unapproved-same-version-resource"],
		};
		const sameVersionPath = join(temporaryDirectory, "same-version-domain.json");
		await writeFile(sameVersionPath, JSON.stringify(sameVersionManifest));
		await harness.commands.get("research-domain")?.(`set "${sameVersionPath}"`, ctx);
		const unchangedPrompt = await harness.emit(
			"before_agent_start",
			{ type: "before_agent_start", prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
			ctx,
		);
		expect(unchangedPrompt.at(-1)).toMatchObject({
			systemPrompt: expect.not.stringContaining("unapproved-same-version-resource"),
		});
	});

	it("requires confirmation to migrate and rolls back only an unchanged v0.5 manifest", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-migration-command-"));
		const projectRoot = join(temporaryDirectory, "legacy-project");
		await initializeProject(projectRoot, { title: "Legacy migration fixture" });
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
			schemaVersion: string;
			recordSets: { kind: string }[];
		};
		manifest.schemaVersion = RESEARCH_LEGACY_SCHEMA_VERSION;
		await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

		const harness = createHarness();
		const headless = harness.context(temporaryDirectory, false);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await harness.commands.get("research-migrate")?.(`"${projectRoot}"`, headless);
		const blocked = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
		stdout.mockRestore();
		expect(blocked).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "MIGRATION_CONFIRMATION_REQUIRED" }],
		});
		expect(await openProject(projectRoot)).toMatchObject({
			compatibility: "migration_required",
			schemaVersion: RESEARCH_LEGACY_SCHEMA_VERSION,
		});

		const ctx = harness.context(temporaryDirectory);
		await harness.commands.get("research-migrate")?.(`"${projectRoot}"`, ctx);
		const migrated = commandResult(harness);
		expect(migrated).toMatchObject({
			ok: true,
			value: {
				fromVersion: RESEARCH_LEGACY_SCHEMA_VERSION,
				toVersion: RESEARCH_SCHEMA_VERSION,
				migrated: true,
				migrationId: expect.any(String),
			},
		});
		const migrationId = (migrated.value as { migrationId: string }).migrationId;
		expect(await openProject(projectRoot)).toMatchObject({ compatibility: "current", mode: "read-write" });

		await harness.commands.get("research-migrate")?.(`rollback ${migrationId}`, ctx);
		expect(commandResult(harness)).toMatchObject({
			ok: true,
			value: {
				migrationId,
				schemaVersion: RESEARCH_LEGACY_SCHEMA_VERSION,
				compatibility: "migration_required",
			},
		});
		expect(await openProject(projectRoot)).toMatchObject({
			mode: "read-only",
			compatibility: "migration_required",
		});
	});
});
