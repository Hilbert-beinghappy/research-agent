import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import researchExtension from "../../extensions/research.ts";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import {
	RESEARCH_LEGACY_SCHEMA_VERSION,
	RESEARCH_SCHEMA_VERSION,
	type ResearchTask,
} from "../../src/contracts/schemas.ts";
import { RESEARCH_SESSION_ENTRY_TYPE } from "../../src/extension/commands.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes } from "../../src/kernel/integrity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import { openProject } from "../../src/project/open.ts";
import { calculateRecordSetIndex, listProjectRecordIds, projectRecordPath } from "../../src/project/record-index.ts";
import { readRecord } from "../../src/project/records.ts";
import { prepareProjectTransaction } from "../../src/project/transactions.ts";

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
	const select = vi.fn(async (_title: string, options: string[]) => options[0]);
	const setStatus = vi.fn();
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
			ui: { notify, confirm, select, setStatus },
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
		select,
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
	if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("research extension commands", () => {
	it("runs the M0 project, recovery, session, governance, and policy slice", async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-commands-"));
		const projectRoot = join(temporaryDirectory, "fixture project");
		await mkdir(projectRoot);
		const harness = createHarness();
		const ctx = harness.context(projectRoot);

		expect([...harness.commands.keys()].sort()).toEqual([
			"research-backup",
			"research-doctor",
			"research-domain",
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
		const ordinaryContext = ordinary.context(temporaryDirectory);
		await ordinary.emit("session_start", { type: "session_start", reason: "new" }, ordinaryContext);
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
					templateVersion: RESEARCH_SCHEMA_VERSION,
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
