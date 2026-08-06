// SPDX-License-Identifier: Apache-2.0

import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import type {
	ApprovalRecord,
	JsonValue,
	OperationRecord,
	RecordKind,
	ResearchPolicyConfig,
	ResearchResult,
	ResearchTask,
	SessionLink,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { validatePersistedRecord } from "../contracts/validators.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { operationTransitionPatch } from "../kernel/operations.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { initializeProject } from "../project/init.ts";
import { migrateProject, rollbackProjectMigration } from "../project/migrate.ts";
import { type OpenedProject, openProject } from "../project/open.ts";
import { listProjectRecordIds, projectRecordId } from "../project/record-index.ts";
import { createRecord, readRecord, updateRecord } from "../project/records.ts";
import {
	commitPreparedTransaction,
	commitProjectTransaction,
	listPendingProjectTransactions,
	rollbackPreparedTransaction,
} from "../project/transactions.ts";
import { validateProject } from "../project/validate.ts";
import { createActionRequest } from "../security/policy.ts";
import { isDesignRecord } from "../tools/design.ts";
import { RESEARCH_TOOL_NAMES, type RegisterResearchToolsOptions, registerResearchTools } from "./tools.ts";

export const RESEARCH_SESSION_ENTRY_TYPE = "pi-research-agent.project-link";

interface ResearchSessionProjectLink {
	projectId: string;
	manifestPath: string;
	manifestRevision: number;
	lastOperationId: string | null;
}

type CurrentProject = Extract<OpenedProject, { compatibility: "current" }>;
type CommandResult = ResearchResult<JsonValue>;
type ResearchCommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<CommandResult>;

const GOVERNED_TOOL_NAMES = new Set(["read", "grep", "find", "ls", ...RESEARCH_TOOL_NAMES]);

function asJson(value: unknown): JsonValue {
	return canonicalizeJson(value);
}

function emitCommandResult(ctx: ExtensionCommandContext, result: CommandResult): void {
	const output = canonicalStringify(asJson(result));
	if (ctx.hasUI) ctx.ui.notify(output, result.ok ? "info" : "error");
	else process.stdout.write(`${output}\n`);
}

function isSessionProjectLink(value: unknown): value is ResearchSessionProjectLink {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const link = value as Record<string, unknown>;
	return (
		typeof link.projectId === "string" &&
		typeof link.manifestPath === "string" &&
		Number.isInteger(link.manifestRevision) &&
		(link.manifestRevision as number) >= 0 &&
		(link.lastOperationId === null || typeof link.lastOperationId === "string")
	);
}

function latestSessionProjectLink(ctx: ExtensionContext): ResearchSessionProjectLink | null {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry === undefined) continue;
		if (
			entry.type === "custom" &&
			entry.customType === RESEARCH_SESSION_ENTRY_TYPE &&
			isSessionProjectLink(entry.data)
		) {
			return entry.data;
		}
	}
	return null;
}

function operationSessionLink(ctx: ExtensionContext): SessionLink {
	return {
		piSessionId: ctx.sessionManager.getSessionId(),
		piSessionFileHash: null,
		linkedAt: new Date().toISOString(),
		firstEntryId: null,
		lastEntryId: null,
	};
}

function operationRecord(
	operationId: string,
	name: string,
	taskId: string | null,
	ctx: ExtensionContext,
	version: string,
): OperationRecord {
	const now = new Date().toISOString();
	return {
		kind: "operation",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		operationId,
		taskId,
		operationKind: "human",
		name,
		implementationVersion: version,
		status: "planned",
		session: operationSessionLink(ctx),
		actor: { type: "human", id: "pi-user" },
		modelExecution: null,
		adapterExecution: null,
		inputs: [],
		inputFiles: [],
		outputs: [],
		outputFiles: [],
		rawRequest: null,
		rawResponse: null,
		approvalIds: [],
		usage: {
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			networkRequests: 0,
			cost: { amount: 0, currency: "USD" },
		},
		error: null,
		startedAt: null,
		finishedAt: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

function initialTask(taskId: string, operationId: string, title: string): ResearchTask {
	const now = new Date().toISOString();
	return {
		kind: "task",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		taskId,
		taskType: "topic_clarification",
		title: `Clarify the research question for ${title}`,
		inputs: [],
		inputFiles: [],
		expectedOutputs: ["confirmed research question"],
		outputs: [],
		outputFiles: [],
		dependencyTaskIds: [],
		status: "planned",
		attemptCount: 0,
		maxAttempts: 3,
		idempotencyKey: `project:${taskId}:topic-clarification`,
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

function approvalRecord(
	request: ReturnType<typeof createActionRequest>,
	decision: "approved" | "denied",
	operationId: string,
): ApprovalRecord {
	const now = new Date().toISOString();
	const approvalId = createOpaqueId("approval");
	return {
		kind: "approval",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		approvalId,
		taskId: null,
		operationId,
		actionClass: request.actionClass,
		actionName: request.actionName,
		impactScope: [...request.paths],
		estimatedCost: request.estimatedCost,
		dataEgress: {
			destination: request.destination,
			dataClasses: [...request.dataClasses],
			fileRefs: [],
			recordRefs: [],
		},
		overwriteRisk: {
			paths: [...request.paths],
			destructive: request.destructive,
			recoverable: request.recoverable,
		},
		requestMessage: "Update the canonical research project policy",
		requestedAt: now,
		policySnapshotHash: request.policySnapshotHash,
		decision,
		scope: "once",
		scopeTarget: {
			projectId: request.projectId,
			sessionId: request.sessionId,
			actionFingerprint: request.actionFingerprint,
			destinationPattern: request.destination,
			pathPatterns: [...request.paths],
			maxApprovedCost: request.estimatedCost,
		},
		decidedAt: now,
		decidedBy: "user",
		expiresAt: null,
		note: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

function stripOuterQuotes(value: string): string {
	const trimmed = value.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

async function loadRecords(project: CurrentProject, kind: RecordKind) {
	const records = [];
	for (const id of await listProjectRecordIds(project.root, project.manifest, kind)) {
		const result = await readRecord(project.root, kind, id);
		if (!result.ok) throw new Error(result.errors[0].message);
		records.push(result.value);
	}
	return records;
}

function countValues(values: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

export async function projectStatus(project: CurrentProject): Promise<JsonValue> {
	const [tasks, operations, documents, evidence, citations, design] = await Promise.all([
		loadRecords(project, "task"),
		loadRecords(project, "operation"),
		loadRecords(project, "document"),
		loadRecords(project, "evidence"),
		loadRecords(project, "citation_verification"),
		Promise.all(
			(["research_question_version", "concept", "theory_relation", "design_decision", "protocol"] as const).map(
				(kind) => loadRecords(project, kind),
			),
		).then((records) => records.flat()),
	]);
	const taskRecords = tasks.filter((record) => record.kind === "task");
	const budgetActual: Record<string, number> = {};
	for (const task of taskRecords) {
		budgetActual[task.budget.actual.currency] =
			(budgetActual[task.budget.actual.currency] ?? 0) + task.budget.actual.amount;
	}
	return asJson({
		projectId: project.manifest.projectId,
		title: project.manifest.title,
		stage: project.manifest.currentStage,
		projectStatus: project.manifest.projectStatus,
		revision: project.manifest.revision,
		recordCounts: Object.fromEntries(project.manifest.recordSets.map(({ kind, count }) => [kind, count])),
		tasksByStatus: countValues(taskRecords.map(({ status }) => status)),
		operationsByStatus: countValues(
			operations.filter((record) => record.kind === "operation").map(({ status }) => status),
		),
		fullTextByStatus: countValues(
			documents.filter((record) => record.kind === "document").map(({ fullTextStatus }) => fullTextStatus),
		),
		evidenceByLevel: countValues(
			evidence.filter((record) => record.kind === "evidence").map(({ evidenceLevel }) => evidenceLevel),
		),
		citationsByStatus: countValues(
			citations.filter((record) => record.kind === "citation_verification").map(({ finalStatus }) => finalStatus),
		),
		designByStatus: countValues(design.filter(isDesignRecord).map(({ status }) => status)),
		budgetActual,
	});
}

function parsePolicyPatch(args: string, manifest: CurrentProject["manifest"]): ResearchPolicyConfig {
	if (!args.startsWith("set ")) throw new TypeError('Usage: /research-policy set {"sensitivity":"internal"}');
	const raw = canonicalizeJson(JSON.parse(args.slice(4).trim()));
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		throw new TypeError("Policy patch must be an object");
	const knownKeys = new Set(Object.keys(manifest.policy));
	for (const key of Object.keys(raw)) {
		if (!knownKeys.has(key)) throw new TypeError(`Unknown policy field: ${key}`);
	}
	const candidate = { ...manifest, policy: { ...manifest.policy, ...raw } };
	const validation = validatePersistedRecord(candidate);
	if (!validation.ok || validation.value.kind !== "research_project_manifest") {
		throw new TypeError("Policy patch does not satisfy the project contract");
	}
	return validation.value.policy;
}

function expectMutation(result: ResearchResult<unknown>): void {
	if (!result.ok) throw new Error(result.errors[0].message);
}

export function registerResearchCommands(
	pi: ExtensionAPI,
	version: string,
	toolOptions: Pick<RegisterResearchToolsOptions, "http" | "credentialAliases"> = {},
): void {
	let activeProjectRoot: string | null = null;
	let activePolicy: ResearchPolicyConfig | null = null;
	let governanceBlocked = false;

	const restrictTools = (policy: ResearchPolicyConfig): void => {
		pi.setActiveTools(
			pi.getActiveTools().filter((name) => policy.modelEgressAllowed && GOVERNED_TOOL_NAMES.has(name)),
		);
	};

	const bindProject = async (
		ctx: ExtensionContext,
		projectRoot: string,
		expectedProjectId?: string,
	): Promise<CurrentProject> => {
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current")
			throw new TypeError(`Project schema ${opened.schemaVersion} is read-only`);
		if (expectedProjectId !== undefined && opened.manifest.projectId !== expectedProjectId) {
			throw new TypeError("Session project link does not match the project manifest");
		}
		activeProjectRoot = opened.root;
		activePolicy = opened.manifest.policy;
		governanceBlocked = false;
		restrictTools(opened.manifest.policy);
		ctx.ui.setStatus("research-agent", `${opened.manifest.title} r${opened.manifest.revision}`);
		return opened;
	};

	const appendProjectLink = (project: CurrentProject): void => {
		const link: ResearchSessionProjectLink = {
			projectId: project.manifest.projectId,
			manifestPath: project.manifestPath,
			manifestRevision: project.manifest.revision,
			lastOperationId: project.manifest.lastCommittedOperationId,
		};
		pi.appendEntry(RESEARCH_SESSION_ENTRY_TYPE, link);
	};

	const requireProject = async (ctx: ExtensionContext): Promise<CurrentProject> => {
		if (activeProjectRoot !== null) return bindProject(ctx, activeProjectRoot);
		const link = latestSessionProjectLink(ctx);
		if (link === null) throw new Error("No research project is linked to this Pi session");
		return bindProject(ctx, dirname(link.manifestPath), link.projectId);
	};

	registerResearchTools(pi, { version, requireProject, appendProjectLink, ...toolOptions });

	const register = (name: string, description: string, handler: ResearchCommandHandler): void => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				let result: CommandResult;
				try {
					result = await handler(args.trim(), ctx);
				} catch (error) {
					const invalidInput = error instanceof TypeError;
					result = failureResult(
						"PERMANENT_FAILURE",
						invalidInput ? "RESEARCH_COMMAND_INVALID" : "RESEARCH_COMMAND_FAILED",
						invalidInput ? "validation" : "runtime",
						error instanceof Error ? error.message : String(error),
						null,
					);
				}
				emitCommandResult(ctx, result);
			},
		});
	};

	register(
		"research-migrate",
		"Migrate a v0.2 project to v0.3 or roll back an unchanged migration",
		async (args, ctx) => {
			const [action, migrationId] = args.split(/\s+/, 2);
			if (action === "rollback") {
				if (migrationId === undefined) throw new TypeError("Usage: /research-migrate rollback <migration-id>");
				const project = await requireProject(ctx);
				if (!ctx.hasUI) {
					return failureResult(
						"PERMISSION_BLOCKED",
						"MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED",
						"permission",
						"Migration rollback requires interactive confirmation",
						null,
					);
				}
				const confirmed = await ctx.ui.confirm(
					"Roll back research project migration",
					`Restore the v0.2 manifest snapshot from ${migrationId}? Rollback is refused if any v0.3 state was written.`,
				);
				if (!confirmed) {
					return failureResult(
						"PERMISSION_BLOCKED",
						"MIGRATION_ROLLBACK_CANCELLED",
						"cancelled",
						"Migration rollback was cancelled",
						null,
					);
				}
				const rolledBack = await rollbackProjectMigration(project.root, migrationId);
				activeProjectRoot = null;
				activePolicy = null;
				governanceBlocked = true;
				ctx.ui.setStatus("research-agent", undefined);
				return successResult(
					asJson({
						migrationId,
						schemaVersion:
							rolledBack.compatibility === "current" ? RESEARCH_SCHEMA_VERSION : rolledBack.schemaVersion,
						compatibility: rolledBack.compatibility,
					}),
					null,
				);
			}

			const linked = latestSessionProjectLink(ctx);
			const target =
				args.length > 0
					? resolve(ctx.cwd, stripOuterQuotes(args))
					: (activeProjectRoot ?? (linked === null ? ctx.cwd : dirname(linked.manifestPath)));
			const opened = await openProject(target);
			if (opened.compatibility === "current") {
				const bound = await bindProject(ctx, opened.root, opened.manifest.projectId);
				appendProjectLink(bound);
				return successResult(
					asJson({ schemaVersion: RESEARCH_SCHEMA_VERSION, revision: bound.manifest.revision, migrated: false }),
					null,
				);
			}
			if (!ctx.hasUI) {
				return failureResult(
					"PERMISSION_BLOCKED",
					"MIGRATION_CONFIRMATION_REQUIRED",
					"permission",
					`Migration from schema ${opened.schemaVersion} requires interactive confirmation`,
					null,
				);
			}
			const confirmed = await ctx.ui.confirm(
				"Migrate research project",
				`Migrate schema ${opened.schemaVersion} to ${RESEARCH_SCHEMA_VERSION}? Existing records are not rewritten.`,
			);
			if (!confirmed) {
				return failureResult(
					"PERMISSION_BLOCKED",
					"MIGRATION_CANCELLED",
					"cancelled",
					"Project migration was cancelled",
					null,
				);
			}
			const result = await migrateProject(opened.root);
			const migrated = await bindProject(ctx, opened.root);
			appendProjectLink(migrated);
			return successResult(asJson({ ...result, migrated: result.migrationId !== null }), null);
		},
	);

	register("research-init", "Initialize a governed research project in the current directory", async (args, ctx) => {
		const title = stripOuterQuotes(args) || basename(ctx.cwd);
		let project = await initializeProject(ctx.cwd, { title });
		if (project.compatibility !== "current") throw new TypeError("New project did not open read-write");
		const operationCount = project.manifest.recordSets.find(({ kind }) => kind === "operation")?.count;
		const taskCount = project.manifest.recordSets.find(({ kind }) => kind === "task")?.count;
		if (operationCount === 0 && taskCount === 0) {
			const operationId = createOpaqueId("operation");
			const taskId = createOpaqueId("task");
			expectMutation(
				await createRecord(
					project.root,
					operationRecord(operationId, "research.topic.clarify", taskId, ctx, version),
					{
						expectedManifestRevision: project.manifest.revision,
						operationId,
					},
				),
			);
			expectMutation(
				await createRecord(project.root, initialTask(taskId, operationId, title), {
					expectedManifestRevision: project.manifest.revision + 1,
					operationId,
				}),
			);
			project = await openProject(project.root, project.manifest.revision + 2);
			if (project.compatibility !== "current") throw new TypeError("Initialized project became read-only");
		} else if (operationCount === 0 || taskCount === 0) {
			throw new Error("Project bootstrap task and operation records are inconsistent");
		}
		const bound = await bindProject(ctx, project.root, project.manifest.projectId);
		appendProjectLink(bound);
		return successResult(asJson({ projectId: bound.manifest.projectId, revision: bound.manifest.revision }), null);
	});

	register("research-open", "Open and link an existing research project", async (args, ctx) => {
		const target = resolve(ctx.cwd, stripOuterQuotes(args) || ".");
		const project = await bindProject(ctx, target);
		appendProjectLink(project);
		return successResult(
			asJson({ projectId: project.manifest.projectId, revision: project.manifest.revision }),
			null,
		);
	});

	register("research-status", "Show canonical research project status", async (_args, ctx) => {
		return successResult(await projectStatus(await requireProject(ctx)), null);
	});

	register("research-resume", "Show incomplete and blocked research tasks", async (_args, ctx) => {
		const project = await requireProject(ctx);
		const [taskRecords, operationRecords, designRecords] = await Promise.all([
			loadRecords(project, "task"),
			loadRecords(project, "operation"),
			Promise.all(
				(["research_question_version", "concept", "theory_relation", "design_decision", "protocol"] as const).map(
					(kind) => loadRecords(project, kind),
				),
			).then((records) => records.flat()),
		]);
		const tasks = taskRecords
			.filter((record) => record.kind === "task")
			.filter(
				({ status }) => !["succeeded", "partially_succeeded", "failed_permanent", "cancelled"].includes(status),
			)
			.map(({ taskId, title, status, attemptCount, maxAttempts, resumeCursor, errors }) => ({
				taskId,
				title,
				status,
				attemptCount,
				maxAttempts,
				resumeCursor,
				errors,
			}));
		const operations = operationRecords
			.filter((record) => record.kind === "operation")
			.filter(
				({ status }) => !["succeeded", "partially_succeeded", "failed_permanent", "cancelled"].includes(status),
			)
			.map(({ operationId, taskId, name, status, error }) => ({ operationId, taskId, name, status, error }));
		const designAwaitingConfirmation = designRecords
			.filter(isDesignRecord)
			.filter(({ status }) => status === "awaiting_confirmation")
			.map((record) => ({
				kind: record.kind,
				id: projectRecordId(record),
				revision: record.audit.revision,
			}));
		return successResult(
			asJson({
				projectId: project.manifest.projectId,
				revision: project.manifest.revision,
				tasks,
				operations,
				designAwaitingConfirmation,
			}),
			null,
		);
	});

	register(
		"research-validate",
		"Validate project schemas, hashes, references, and pending transactions",
		async (_args, ctx) => {
			const project = await requireProject(ctx);
			const report = await validateProject(project.root);
			return report.valid
				? successResult(asJson(report), null)
				: failureResult(
						"PERMANENT_FAILURE",
						"PROJECT_VALIDATION_FAILED",
						"integrity",
						`Project validation found ${report.issues.length} issue(s)`,
						null,
						asJson(report),
					);
		},
	);

	register("research-recover", "Commit or roll back an interrupted project transaction", async (args, ctx) => {
		const project = await requireProject(ctx);
		const pending = await listPendingProjectTransactions(project.root);
		if (pending.length === 0)
			return successResult(asJson({ recovered: [], revision: project.manifest.revision }), null);
		if (!ctx.hasUI) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"RECOVERY_CONFIRMATION_REQUIRED",
				"permission",
				"Transaction recovery requires an interactive confirmation",
				null,
				{ pendingTransactionIds: pending },
			);
		}
		const [requestedAction, requestedId] = args.split(/\s+/);
		let transactionId: string | undefined = requestedId || undefined;
		let action: string | undefined = requestedAction || undefined;
		if (transactionId === undefined) {
			transactionId = pending.length === 1 ? pending[0] : await ctx.ui.select("Pending transaction", pending);
		}
		if (action !== "commit" && action !== "rollback") {
			action = await ctx.ui.select("Recovery action", ["commit", "rollback"]);
		}
		if (
			transactionId === undefined ||
			!pending.includes(transactionId) ||
			(action !== "commit" && action !== "rollback")
		) {
			return failureResult("PERMISSION_BLOCKED", "RECOVERY_CANCELLED", "cancelled", "Recovery was cancelled", null);
		}
		const confirmed = await ctx.ui.confirm(
			"Recover research project",
			`${action} interrupted transaction ${transactionId}?`,
		);
		if (!confirmed) {
			return failureResult("PERMISSION_BLOCKED", "RECOVERY_CANCELLED", "cancelled", "Recovery was cancelled", null);
		}
		if (action === "commit") await commitPreparedTransaction(project.root, transactionId);
		else await rollbackPreparedTransaction(project.root, transactionId);
		const recovered = await bindProject(ctx, project.root, project.manifest.projectId);
		appendProjectLink(recovered);
		return successResult(
			asJson({ recovered: [{ transactionId, action }], revision: recovered.manifest.revision }),
			null,
		);
	});

	register("research-policy", "View or update the canonical project policy", async (args, ctx) => {
		const project = await requireProject(ctx);
		if (args.length === 0) {
			return successResult(asJson({ revision: project.manifest.revision, policy: project.manifest.policy }), null);
		}
		const nextPolicy = parsePolicyPatch(args, project.manifest);
		if (canonicalStringify(nextPolicy) === canonicalStringify(project.manifest.policy)) {
			return successResult(asJson({ revision: project.manifest.revision, policy: project.manifest.policy }), null);
		}
		if (!ctx.hasUI) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"POLICY_CONFIRMATION_REQUIRED",
				"permission",
				"Policy updates require an interactive confirmation",
				null,
			);
		}

		const operationId = createOpaqueId("operation");
		let manifestRevision = project.manifest.revision;
		expectMutation(
			await createRecord(project.root, operationRecord(operationId, "research.policy.update", null, ctx, version), {
				expectedManifestRevision: manifestRevision,
				operationId,
			}),
		);
		manifestRevision += 1;
		let operationResult = await readRecord(project.root, "operation", operationId);
		if (!operationResult.ok || operationResult.value.kind !== "operation")
			throw new Error("Policy operation is missing");
		expectMutation(
			await updateRecord(project.root, "operation", operationId, {
				expectedManifestRevision: manifestRevision,
				expectedRecordRevision: operationResult.value.audit.revision,
				operationId,
				changes: operationTransitionPatch(operationResult.value, "awaiting_approval"),
			}),
		);
		manifestRevision += 1;
		const request = createActionRequest({
			projectId: project.manifest.projectId,
			operationId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionClass: "project_overwrite",
			actionName: "research.policy.update",
			destination: null,
			paths: ["research-project.json"],
			dataClasses: [],
			estimatedCost: null,
			destructive: false,
			recoverable: true,
			fingerprintParameters: nextPolicy,
			policy: project.manifest.policy,
		});
		const confirmed = await ctx.ui.confirm(
			"Update research policy",
			`Replace policy at revision ${project.manifest.revision} with ${canonicalStringify(nextPolicy)}?`,
		);
		const approval = approvalRecord(request, confirmed ? "approved" : "denied", operationId);
		expectMutation(
			await createRecord(project.root, approval, { expectedManifestRevision: manifestRevision, operationId }),
		);
		manifestRevision += 1;
		operationResult = await readRecord(project.root, "operation", operationId);
		if (!operationResult.ok || operationResult.value.kind !== "operation")
			throw new Error("Policy operation is missing");
		if (!confirmed) {
			expectMutation(
				await updateRecord(project.root, "operation", operationId, {
					expectedManifestRevision: manifestRevision,
					expectedRecordRevision: operationResult.value.audit.revision,
					operationId,
					changes: {
						...operationTransitionPatch(operationResult.value, "blocked"),
						approvalIds: [approval.approvalId],
					},
				}),
			);
			const deniedProject = await bindProject(ctx, project.root, project.manifest.projectId);
			appendProjectLink(deniedProject);
			return failureResult(
				"PERMISSION_BLOCKED",
				"POLICY_UPDATE_DENIED",
				"permission",
				"Policy update was denied",
				operationId,
				{ approvalId: approval.approvalId },
			);
		}

		expectMutation(
			await updateRecord(project.root, "operation", operationId, {
				expectedManifestRevision: manifestRevision,
				expectedRecordRevision: operationResult.value.audit.revision,
				operationId,
				changes: {
					...operationTransitionPatch(operationResult.value, "running"),
					approvalIds: [approval.approvalId],
				},
			}),
		);
		manifestRevision += 1;
		const beforePolicyCommit = await openProject(project.root, manifestRevision);
		if (beforePolicyCommit.compatibility !== "current") throw new TypeError("Project became read-only");
		await commitProjectTransaction(project.root, {
			expectedRevision: manifestRevision,
			writes: [],
			manifest: {
				...beforePolicyCommit.manifest,
				policy: nextPolicy,
				lastCommittedOperationId: operationId,
				updatedAt: new Date().toISOString(),
				revision: manifestRevision + 1,
			},
		});
		manifestRevision += 1;
		operationResult = await readRecord(project.root, "operation", operationId);
		if (!operationResult.ok || operationResult.value.kind !== "operation")
			throw new Error("Policy operation is missing");
		expectMutation(
			await updateRecord(project.root, "operation", operationId, {
				expectedManifestRevision: manifestRevision,
				expectedRecordRevision: operationResult.value.audit.revision,
				operationId,
				changes: operationTransitionPatch(operationResult.value, "succeeded"),
			}),
		);
		const updatedProject = await bindProject(ctx, project.root, project.manifest.projectId);
		appendProjectLink(updatedProject);
		return successResult(
			asJson({
				revision: updatedProject.manifest.revision,
				policy: updatedProject.manifest.policy,
				approvalId: approval.approvalId,
			}),
			operationId,
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		const link = latestSessionProjectLink(ctx);
		if (link === null) {
			activeProjectRoot = null;
			activePolicy = null;
			governanceBlocked = false;
			ctx.ui.setStatus("research-agent", undefined);
			return;
		}
		try {
			await bindProject(ctx, dirname(link.manifestPath), link.projectId);
		} catch (error) {
			activeProjectRoot = null;
			activePolicy = null;
			governanceBlocked = true;
			pi.setActiveTools([]);
			ctx.ui.setStatus("research-agent", undefined);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (governanceBlocked) {
			return {
				systemPrompt: `${event.systemPrompt}\n\nA linked research project could not be validated. Governed actions are blocked until /research-open succeeds.`,
			};
		}
		if (activeProjectRoot === null) return;
		const project = await requireProject(ctx);
		const summary = {
			projectId: project.manifest.projectId,
			title: project.manifest.title,
			revision: project.manifest.revision,
			stage: project.manifest.currentStage,
			policy: project.manifest.policy,
			activeTaskIds: project.manifest.activeTaskIds,
			recordCounts: Object.fromEntries(project.manifest.recordSets.map(({ kind, count }) => [kind, count])),
		};
		return {
			systemPrompt: `${event.systemPrompt}\n\nGoverned research mode is active. Canonical research state must be changed only through registered research tools and project transactions. Do not use bash, write, or edit for research state. Current project summary: ${canonicalStringify(summary)}`,
		};
	});

	pi.on("tool_call", (event) => {
		if (
			(!governanceBlocked && activeProjectRoot === null) ||
			(activePolicy?.modelEgressAllowed === true && GOVERNED_TOOL_NAMES.has(event.toolName))
		)
			return;
		const message =
			GOVERNED_TOOL_NAMES.has(event.toolName) && activePolicy?.modelEgressAllowed === false
				? `Tool ${event.toolName} is blocked because project policy disables model data egress`
				: `Tool ${event.toolName} is not available in governed research mode`;
		return {
			block: true,
			reason: canonicalStringify(
				asJson(failureResult("PERMISSION_BLOCKED", "TOOL_BLOCKED_IN_RESEARCH_MODE", "permission", message, null)),
			),
		};
	});

	pi.on("user_bash", () => {
		if (!governanceBlocked && activeProjectRoot === null) return;
		return {
			result: {
				output: canonicalStringify(
					asJson(
						failureResult(
							"PERMISSION_BLOCKED",
							"USER_BASH_BLOCKED_IN_RESEARCH_MODE",
							"permission",
							"Start an unlinked Pi session before running interactive shell commands",
							null,
						),
					),
				),
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
