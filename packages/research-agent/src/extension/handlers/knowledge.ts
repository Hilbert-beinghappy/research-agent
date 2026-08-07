// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { accessPolicySnapshot } from "../../access/policy.ts";
import { createZoteroWriteIntent, parseZoteroWriteResponse } from "../../adapters/export/zotero.ts";
import { fetchHttpTransport } from "../../adapters/http/transport.ts";
import type {
	ArtifactRecord,
	FileRef,
	JsonValue,
	Money,
	MonitorSubscription,
	OperationRecord,
	RecordRef,
	ResearchResult,
	SourceRecord,
} from "../../contracts/schemas.ts";
import { hashBytes, hashCanonicalJson } from "../../kernel/integrity.ts";
import { resolveProjectPath, validateProjectRelativePath } from "../../kernel/paths.ts";
import { failureResult, successResult } from "../../kernel/results.ts";
import {
	buildProjectCatalog,
	parseProjectCatalog,
	queryProjectCatalog,
	serializeProjectCatalog,
} from "../../knowledge/catalog.ts";
import { openProject } from "../../project/open.ts";
import { listProjectRecordIds } from "../../project/record-index.ts";
import { readRecord } from "../../project/records.ts";
import { brokerProjectFile } from "../../security/broker-files.ts";
import { createActionRequest } from "../../security/policy.ts";
import {
	type ArtifactToolValue,
	commitPreparedArtifact,
	prepareArtifact,
	validateArtifact,
} from "../../tools/artifacts.ts";
import {
	createExportProfile,
	loadExportProfile,
	profileArtifactType,
	profileSummary,
	recordZoteroLinks,
	sourcesNeedingExport,
} from "../../tools/knowledge.ts";
import {
	createMonitorSubscription,
	loadMonitorSubscription,
	recordMonitorBatch,
	reviseMonitorSubscription,
} from "../../tools/monitoring.ts";
import { commitSourceCandidates, metadataObject, type SourceCandidateInput } from "../../tools/sources.ts";
import {
	adapterOperation,
	addOperationInputs,
	approveAction,
	type CurrentProject,
	defaultHttpOptions,
	governedRequest,
	jsonResult,
	jsonValue,
	objectValue,
	propagatedFailure,
	type RegisterResearchToolsOptions,
	recordReference,
	researchResult,
	sourceAdapter,
	sourceRecord,
	type ToolOutcome,
	thrownFailure,
	trackedTool,
} from "../tool-operations.ts";
import { ArtifactsParameters, KnowledgeParameters, MonitorParameters } from "../tool-schemas.ts";
import { runModelVisibleHandler } from "./runtime.ts";

export function registerKnowledgeHandlers(pi: ExtensionAPI, options: RegisterResearchToolsOptions): void {
	pi.registerTool({
		name: "research_artifacts",
		label: "Generate research artifacts",
		description:
			"Generate deterministic Markdown, JSON, RIS, BibTeX, Obsidian, DOCX, PDF, XLSX, or PPTX artifacts and enforce evidence and submission gates.",
		promptSnippet:
			"Generate project artifacts without treating unlocated evidence or unverified citations as complete",
		parameters: ArtifactsParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["research_artifact"],
				"Project policy does not allow this model to generate research artifacts",
				(project) =>
					trackedTool(project, ctx, options, "research.artifacts", (operation) =>
						artifactTool(project, ctx, params, operation),
					),
			);
		},
	});

	pi.registerTool({
		name: "research_knowledge",
		label: "Export research knowledge",
		description:
			"Create versioned export profiles, write portable project artifacts, reconcile Zotero item links, and build derived cross-project catalogs.",
		promptSnippet: "Export canonical project records without making external adapters the source of truth",
		parameters: KnowledgeParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["research_knowledge"],
				"Project policy does not allow this model to export research knowledge",
				(project) => {
					const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
					return trackedTool(project, ctx, options, "research.knowledge", (operation) =>
						knowledgeTool(project, ctx, options, params, operation, executionSignal),
					);
				},
			);
		},
	});

	pi.registerTool({
		name: "research_monitor",
		label: "Monitor research literature",
		description:
			"Create immutable literature-monitor subscriptions and run one user-confirmed, checkpointed Crossref or OpenAlex batch.",
		promptSnippet: "Run literature monitoring only on demand and preserve cursor, cost, failures, and deduplication",
		parameters: MonitorParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["bibliographic_metadata", "research_abstract"],
				"Project policy does not allow this model to monitor research literature",
				(project) => {
					const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
					return trackedTool(project, ctx, options, "research.monitor", (operation) =>
						monitorTool(project, ctx, options, params, operation, executionSignal),
					);
				},
			);
		},
	});
}

export async function artifactTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof ArtifactsParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<ArtifactToolValue>> {
	if (params.action === "validate") {
		if (params.sourceRefs.length !== 1 || params.sourceRefs[0]?.kind !== "artifact") {
			return {
				result: failureResult(
					"PERMANENT_FAILURE",
					"ARTIFACT_VALIDATE_INPUT_INVALID",
					"validation",
					"validate requires exactly one ArtifactRecord reference",
					operation.operationId,
				),
			};
		}
		const artifactRef = params.sourceRefs[0];
		const artifactResult = await readRecord(project.root, "artifact", artifactRef.id);
		if (!artifactResult.ok) return { result: propagatedFailure(artifactResult, operation.operationId) };
		if (artifactResult.value.kind !== "artifact") {
			return {
				result: failureResult(
					"PERMANENT_FAILURE",
					"ARTIFACT_RECORD_INVALID",
					"integrity",
					`Record ${artifactRef.id} is not an artifact`,
					operation.operationId,
				),
			};
		}
		const artifact: ArtifactRecord = artifactResult.value;
		const inputUpdate = await addOperationInputs(
			project.root,
			operation.operationId,
			[{ kind: "artifact", id: artifact.artifactId, revision: artifact.audit.revision }],
			[artifact.outputFile],
		);
		if (!inputUpdate.ok) return { result: propagatedFailure(inputUpdate, operation.operationId) };
		const result = await validateArtifact(
			project.root,
			artifact.artifactId,
			artifactRef.revision,
			params.artifactType,
			params.targetStatus,
			operation.operationId,
		);
		return result.ok
			? {
					result,
					outputs: [
						{
							kind: "artifact",
							id: result.value.artifact.artifactId,
							revision: result.value.artifact.audit.revision,
						},
					],
					outputFiles: [result.value.artifact.outputFile],
				}
			: { result };
	}

	const prepared = await prepareArtifact(
		project.root,
		{
			action: params.action,
			artifactType: params.artifactType,
			content: params.content ?? null,
			sourceRefs: params.sourceRefs,
			targetStatus: params.targetStatus,
			outputPath: params.outputPath ?? null,
		},
		operation.operationId,
	);
	if (!prepared.ok) return { result: prepared };
	const inputUpdate = await addOperationInputs(
		project.root,
		operation.operationId,
		prepared.value.snapshot.sourceRecords,
		prepared.value.snapshot.sourceFiles,
	);
	if (!inputUpdate.ok) return { result: propagatedFailure(inputUpdate, operation.operationId) };

	let submissionApprovalId: string | null = null;
	if (
		params.targetStatus === "submission_candidate" &&
		prepared.value.validation.status !== "failed" &&
		params.artifactType !== "manuscript"
	) {
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const request = createActionRequest({
			projectId: opened.manifest.projectId,
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionClass: "publish_or_submit",
			actionName: "research.artifact.mark_submission_candidate",
			destination: null,
			paths: [prepared.value.outputFile.path],
			dataClasses: ["research_artifact"],
			estimatedCost: null,
			destructive: false,
			recoverable: true,
			fingerprintParameters: {
				artifactType: params.artifactType,
				inputAggregateHash: prepared.value.inputAggregateHash,
				validationHash: hashCanonicalJson(prepared.value.validation),
			},
			policy: opened.manifest.policy,
		});
		const approval = await approveAction(
			opened.root,
			operation.operationId,
			ctx,
			request,
			"Confirm submission candidate",
			`Mark this evidence-checked ${params.artifactType} as a submission candidate? This does not confirm overall paper quality.${prepared.value.validation.checks
				.filter(({ status }) => status === "warning")
				.map(({ message }) => `\n- ${message}`)
				.join("")}`,
			prepared.value.snapshot.sourceRecords,
			prepared.value.snapshot.sourceFiles,
		);
		if (!approval.ok) return { result: approval };
		submissionApprovalId = approval.value;
	}

	let committed = await commitPreparedArtifact(
		project.root,
		prepared.value,
		operation.operationId,
		ctx.sessionManager.getSessionId(),
		submissionApprovalId,
	);
	if (!committed.ok && committed.errors[0].code === "APPROVAL_REQUIRED") {
		const details = objectValue(committed.errors[0].details, "Artifact file approval");
		const actionClass = details.actionClass;
		if (actionClass !== "project_create" && actionClass !== "project_overwrite") return { result: committed };
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const request = createActionRequest({
			projectId: opened.manifest.projectId,
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionClass,
			actionName: "project.file.write",
			destination: null,
			paths: [prepared.value.outputFile.path],
			dataClasses: ["research_artifact"],
			estimatedCost: null,
			destructive: false,
			recoverable: true,
			fingerprintParameters: { contentHash: prepared.value.outputFile.hash },
			policy: opened.manifest.policy,
		});
		const approval = await approveAction(
			opened.root,
			operation.operationId,
			ctx,
			request,
			"Overwrite research artifact",
			`Write ${prepared.value.outputFile.path}, replacing its current contents?`,
			prepared.value.snapshot.sourceRecords,
			prepared.value.snapshot.sourceFiles,
		);
		if (!approval.ok) return { result: approval };
		committed = await commitPreparedArtifact(
			project.root,
			prepared.value,
			operation.operationId,
			ctx.sessionManager.getSessionId(),
			submissionApprovalId,
		);
	}
	return committed.ok
		? {
				result: committed,
				outputs: [
					{
						kind: "artifact",
						id: committed.value.artifact.artifactId,
						revision: committed.value.artifact.audit.revision,
					},
				],
				outputFiles: [committed.value.artifact.outputFile],
			}
		: { result: committed };
}

export async function knowledgeTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: Static<typeof KnowledgeParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<JsonValue>> {
	if (params.action === "create_profile") {
		const result = await createExportProfile(project.root, {
			name: params.name,
			adapterId: params.adapterId,
			adapterVersion: params.adapterVersion,
			format: params.format,
			destination: params.destination,
			credentialAlias: params.credentialAlias,
			enabled: params.enabled,
			expectedManifestRevision: params.expectedRevision,
			operationId: operation.operationId,
		});
		return result.ok
			? {
					result: jsonResult(result),
					outputs: [
						{
							kind: "adapter_export_profile",
							id: result.value.adapterExportProfileId,
							revision: result.value.audit.revision,
						},
					],
				}
			: { result };
	}

	if (params.action === "export_profile") {
		const profile = await loadExportProfile(project.root, params.profileId);
		const artifactType = profileArtifactType(profile.format);
		if (!profile.enabled || artifactType === null || profile.destination.kind !== "project_file") {
			return {
				result: thrownFailure(
					new TypeError("Profile is not an enabled project-file export"),
					operation.operationId,
				),
			};
		}
		const outcome = await artifactTool(
			project,
			ctx,
			{
				action: "generate_structured",
				artifactType,
				sourceRefs: [
					{ kind: "adapter_export_profile", id: profile.adapterExportProfileId, revision: profile.audit.revision },
					...params.sourceRefs,
				],
				targetStatus: params.targetStatus,
				outputPath: profile.destination.path,
			},
			operation,
		);
		return { ...outcome, result: jsonResult(outcome.result) };
	}

	if (params.action === "zotero_push") {
		const profile = await loadExportProfile(project.root, params.profileId);
		if (profile.format !== "zotero-api") {
			return { result: thrownFailure(new TypeError("Profile is not a Zotero API export"), operation.operationId) };
		}
		const sources: SourceRecord[] = [];
		for (const sourceId of [...new Set(params.sourceIds)]) {
			const source = await sourceRecord(project.root, sourceId, operation.operationId);
			if (!source.ok) return { result: source };
			sources.push(source.value);
		}
		const inputUpdate = await addOperationInputs(
			project.root,
			operation.operationId,
			[
				{ kind: "adapter_export_profile", id: profile.adapterExportProfileId, revision: profile.audit.revision },
				...sources.map((source) => ({
					kind: "source" as const,
					id: source.sourceId,
					revision: source.audit.revision,
				})),
			],
			[],
		);
		if (!inputUpdate.ok) return { result: inputUpdate };
		const selected = await sourcesNeedingExport(project.root, profile.adapterExportProfileId, sources);
		if (selected.pending.length === 0) {
			return {
				result: successResult(
					jsonValue({ profile: profileSummary(profile), createdLinks: [], reusedLinks: selected.reusedLinks }),
					operation.operationId,
				),
			};
		}
		const response = await governedRequest(
			project.root,
			operation.operationId,
			ctx,
			signal,
			createZoteroWriteIntent(profile, selected.pending, operation.operationId),
			defaultHttpOptions(options),
		);
		const reconciled = response.ok
			? (() => {
					try {
						return parseZoteroWriteResponse(
							response.value.body,
							selected.pending,
							response.value.headers["last-modified-version"],
						);
					} catch (error) {
						return selected.pending.map((source) => ({
							source,
							externalItemId: null,
							externalVersion: null,
							error: {
								code: "ZOTERO_RESPONSE_INVALID",
								message: error instanceof Error ? error.message : "Zotero response was invalid",
							},
						}));
					}
				})()
			: selected.pending.map((source) => ({
					source,
					externalItemId: null,
					externalVersion: null,
					error: { code: response.errors[0].code, message: response.errors[0].message },
				}));
		const recorded = await recordZoteroLinks(project.root, profile, reconciled, operation.operationId);
		if (!recorded.ok) return { result: recorded };
		const errors = recorded.value.links.flatMap(({ lastError }) => (lastError === null ? [] : [lastError]));
		const value = jsonValue({
			profile: profileSummary(profile),
			createdLinks: recorded.value.links,
			reusedLinks: selected.reusedLinks,
			retryTask: recorded.value.retryTask,
		});
		return {
			result: researchResult(
				value,
				operation.operationId,
				response.ok ? errors : [...response.errors, ...errors],
				recorded.value.links.some(({ syncStatus }) => syncStatus === "synced"),
			),
			outputs: recorded.value.recordRefs,
		};
	}

	if (params.action === "build_catalog") {
		const catalog = await buildProjectCatalog(
			params.projects.map(({ root, locator }) => ({ root, locator: validateProjectRelativePath(locator) })),
		);
		const content = serializeProjectCatalog(catalog);
		const path = validateProjectRelativePath(
			params.outputPath ?? `artifacts/catalogs/project-catalog-${catalog.catalogHash.value.slice(0, 16)}.json`,
		);
		if (!path.startsWith("artifacts/catalogs/") || !path.endsWith(".json")) {
			return {
				result: thrownFailure(
					new TypeError("Project catalogs must be JSON files inside artifacts/catalogs/"),
					operation.operationId,
				),
			};
		}
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		let stored = await brokerProjectFile(project.root, {
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
			expectedManifestRevision: opened.manifest.revision,
			path,
			content,
			dataClasses: ["public_bibliographic_metadata"],
		});
		if (!stored.ok && stored.errors[0].code === "APPROVAL_REQUIRED") {
			const current = await openProject(project.root);
			if (current.compatibility !== "current") throw new TypeError("Research project schema is read-only");
			const request = createActionRequest({
				projectId: current.manifest.projectId,
				operationId: operation.operationId,
				sessionId: ctx.sessionManager.getSessionId(),
				actionClass: "project_overwrite",
				actionName: "project.file.write",
				destination: null,
				paths: [path],
				dataClasses: ["public_bibliographic_metadata"],
				estimatedCost: null,
				destructive: false,
				recoverable: true,
				fingerprintParameters: { contentHash: hashBytes(content) },
				policy: current.manifest.policy,
			});
			const approval = await approveAction(
				current.root,
				operation.operationId,
				ctx,
				request,
				"Overwrite project catalog",
				`Replace ${path} with the newly generated catalog?`,
				[],
				[],
			);
			if (!approval.ok) return { result: approval };
			const approvedProject = await openProject(project.root);
			if (approvedProject.compatibility !== "current") throw new TypeError("Research project schema is read-only");
			stored = await brokerProjectFile(project.root, {
				operationId: operation.operationId,
				sessionId: ctx.sessionManager.getSessionId(),
				expectedManifestRevision: approvedProject.manifest.revision,
				path,
				content,
				dataClasses: ["public_bibliographic_metadata"],
			});
		}
		if (!stored.ok) return { result: stored };
		const file: FileRef = {
			path,
			hash: hashBytes(content),
			mediaType: "application/json",
			bytes: Buffer.byteLength(content),
		};
		return {
			result: successResult(jsonValue({ catalog, file }), operation.operationId),
			outputFiles: [file],
		};
	}

	const path = validateProjectRelativePath(params.path);
	const catalog = parseProjectCatalog(await readFile(await resolveProjectPath(project.root, path), "utf8"));
	return {
		result: successResult(
			jsonValue({
				path,
				strongIdentifier: params.strongIdentifier,
				matches: queryProjectCatalog(catalog, params.strongIdentifier),
			}),
			operation.operationId,
		),
	};
}

export async function monitorTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: Static<typeof MonitorParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<JsonValue>> {
	if (params.action === "list") {
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const all: MonitorSubscription[] = [];
		for (const id of await listProjectRecordIds(opened.root, opened.manifest, "monitor_subscription")) {
			all.push(await loadMonitorSubscription(opened.root, id));
		}
		const latest = [
			...new Map(
				all
					.sort((left, right) => right.version - left.version)
					.map((subscription) => [subscription.monitorSubscriptionSeriesId, subscription]),
			).values(),
		];
		return { result: successResult(jsonValue({ subscriptions: latest }), operation.operationId) };
	}

	if (params.action === "create") {
		const adapter = sourceAdapter(params.adapterId, options);
		const capabilities = await adapter.capabilities();
		const result = await createMonitorSubscription(project.root, {
			name: params.name,
			adapterId: params.adapterId,
			query: params.query,
			budget: params.budget,
			adapterVersion: capabilities.adapterVersion,
			expectedManifestRevision: params.expectedRevision,
			operationId: operation.operationId,
		});
		return result.ok ? { result: jsonResult(result), outputs: [recordReference(result.value)] } : { result };
	}

	if (params.action === "revise") {
		const subscription = await loadMonitorSubscription(project.root, params.monitorSubscriptionId);
		const result = await reviseMonitorSubscription(project.root, subscription, {
			name: params.name,
			query: params.query,
			budget: params.budget,
			status: params.status,
			expectedManifestRevision: params.expectedRevision,
			operationId: operation.operationId,
		});
		return result.ok ? { result: jsonResult(result), outputs: [recordReference(result.value)] } : { result };
	}

	const subscription = await loadMonitorSubscription(project.root, params.monitorSubscriptionId);
	const inputUpdate = await addOperationInputs(
		project.root,
		operation.operationId,
		[recordReference(subscription)],
		[],
	);
	if (!inputUpdate.ok) return { result: inputUpdate };
	if (!ctx.hasUI) {
		return {
			result: failureResult(
				"PERMISSION_BLOCKED",
				"MONITOR_RUN_CONFIRMATION_REQUIRED",
				"permission",
				"Literature monitoring runs require interactive user confirmation",
				operation.operationId,
			),
		};
	}
	const confirmed = await ctx.ui.confirm(
		"Run literature monitor",
		`Search ${subscription.adapterId} for “${subscription.query.text}” from the recorded cursor?`,
	);
	if (!confirmed) {
		return {
			result: failureResult(
				"PERMISSION_BLOCKED",
				"MONITOR_RUN_CANCELLED",
				"cancelled",
				"Literature monitoring run was cancelled",
				operation.operationId,
			),
		};
	}
	const confirmedAt = new Date().toISOString();
	const adapter = sourceAdapter(subscription.adapterId, options);
	const capabilities = await adapter.capabilities();
	if (capabilities.adapterVersion !== subscription.adapterVersion) {
		return {
			result: failureResult(
				"PERMISSION_BLOCKED",
				"MONITOR_ADAPTER_VERSION_CHANGED",
				"migration",
				"Revise the monitor subscription before running a different adapter version",
				operation.operationId,
			),
		};
	}
	let requestCount = 0;
	const baseHttp = defaultHttpOptions(options);
	const baseTransport = baseHttp.transport ?? fetchHttpTransport;
	const rawResponses: FileRef[] = [];
	const candidates: SourceCandidateInput[] = [];
	const startedAt = new Date().toISOString();
	const run = await adapterOperation(
		project,
		ctx,
		adapter,
		"monitor",
		[recordReference(subscription)],
		signal,
		{
			...baseHttp,
			transport: async (request) => {
				requestCount += 1;
				return baseTransport(request);
			},
		},
		(context) =>
			adapter.search(
				{
					queryText: subscription.query.text,
					filters: subscription.query.filters,
					pageSize: Math.min(subscription.query.maxResults, subscription.adapterId === "crossref" ? 1_000 : 100),
					cursor: subscription.cursor,
					maxResults: subscription.query.maxResults,
					maxCost: subscription.budget.maxCost,
				},
				context,
			),
		(intent) => ({
			...intent,
			maxAttempts: Math.min(intent.maxAttempts, subscription.budget.maxRequests),
			estimatedCost:
				intent.estimatedCost === null
					? null
					: {
							amount:
								intent.costPerRequest.amount * Math.min(intent.maxAttempts, subscription.budget.maxRequests),
							currency: intent.costPerRequest.currency,
						},
		}),
	);
	const errors = [...run.result.errors];
	let cursorAfter = subscription.cursor;
	let cost: Money = { amount: 0, currency: "USD" };
	let committedSourceRefs: RecordRef[] = [];
	let createdSourceIds: string[] = [];
	let reusedSourceIds: string[] = [];
	if (run.result.ok) {
		cursorAfter = run.result.value.nextCursor;
		cost = run.result.value.actualCost;
		rawResponses.push(run.result.value.rawResponse);
		const retrievedAt = new Date().toISOString();
		for (const [index, candidate] of run.result.value.candidates.entries()) {
			candidates.push({
				candidateId: `${subscription.monitorSubscriptionId}:${run.result.value.rawResponse.hash?.value ?? run.operationId}:${index}`,
				adapterId: subscription.adapterId,
				adapterVersion: subscription.adapterVersion,
				retrievedAt,
				rawRecord: run.result.value.rawResponse,
				metadata: metadataObject(candidate),
				sourceIdHint: null,
				documentContentHash: null,
				requiresBibliographicMatch: false,
				queryText: subscription.query.text,
				queryHash: subscription.queryHash,
				rank: index + 1,
				requestOperationId: run.operationId,
				abstractRights: "metadata_only",
				accessPolicy: accessPolicySnapshot(
					subscription.adapterId,
					subscription.adapterVersion,
					retrievedAt,
					"official_api",
				),
			});
		}
		const committed = await commitSourceCandidates(project.root, operation.operationId, candidates);
		if (!committed.ok) errors.push(...committed.errors);
		else {
			committedSourceRefs = committed.value.sourceRefs;
			createdSourceIds = committed.value.createdSourceIds;
			reusedSourceIds = committed.value.reusedSourceIds;
		}
	}
	const beforeBatch = await openProject(project.root);
	if (beforeBatch.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const recorded = await recordMonitorBatch(project.root, subscription, {
		createdSourceIds,
		reusedSourceIds,
		cursorAfter,
		requestCount,
		cost,
		errors,
		confirmedAt,
		startedAt,
		finishedAt: new Date().toISOString(),
		expectedManifestRevision: beforeBatch.manifest.revision,
		operationId: operation.operationId,
	});
	if (!recorded.ok) return { result: recorded };
	return {
		result: researchResult(
			jsonValue(recorded.value),
			operation.operationId,
			errors,
			recorded.value.run.status !== "failed_retryable",
		),
		outputs: [...committedSourceRefs, ...recorded.value.recordRefs],
		outputFiles: rawResponses,
	};
}

export async function executeMonitorCommand(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: { action: "list" } | { action: "run"; monitorSubscriptionId: string },
): Promise<ResearchResult<JsonValue>> {
	return trackedTool(project, ctx, options, "research.monitor", (operation) =>
		monitorTool(project, ctx, options, params, operation, ctx.signal ?? new AbortController().signal),
	);
}
