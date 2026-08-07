// SPDX-License-Identifier: Apache-2.0

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import {
	type AnalysisExecutionValue,
	detectAnalysisRuntime,
	executeAnalysis,
	type RuntimeDetection,
} from "../../analysis/runtime.ts";
import type {
	CodebookVersion,
	CodingDecision,
	FileRef,
	ModelSuggestion,
	OperationRecord,
	QualitativeMaterial,
	QualitativeSegment,
	RecordRef,
	ThemeSynthesis,
} from "../../contracts/schemas.ts";
import { createOpaqueId } from "../../kernel/identity.ts";
import { failureResult, successResult } from "../../kernel/results.ts";
import { openProject } from "../../project/open.ts";
import { listProjectRecordIds, projectRecordId } from "../../project/record-index.ts";
import { readRecord } from "../../project/records.ts";
import { createActionRequest } from "../../security/policy.ts";
import {
	type CreateAnalysisSpecificationValue,
	createAnalysisSpecification,
	decideAnalysisSpecification,
	type ImportDatasetValue,
	importCsvDataset,
} from "../../tools/analysis.ts";
import {
	commitDesignDraft,
	type DesignDraft,
	type DesignRecord,
	type DesignRecordKind,
	decideDesignRecord,
	markDesignAwaitingConfirmation,
} from "../../tools/design.ts";
import {
	createCodebookVersion,
	createThemeSynthesis,
	decideQualitativeSynthesis,
	importQualitativeMaterial,
	type QualitativeAudit,
	recordCodingDecision,
	recordModelSuggestion,
	renderQualitativeAudit,
	segmentQualitativeMaterial,
} from "../../tools/qualitative.ts";
import {
	addOperationInputs,
	approveAction,
	type CurrentProject,
	propagatedFailure,
	type RegisterResearchToolsOptions,
	recordReference,
	resolveRecordInputs,
	type ToolOutcome,
	thrownFailure,
	trackedTool,
} from "../tool-operations.ts";
import { AnalysisParameters, DesignParameters, QualitativeParameters } from "../tool-schemas.ts";
import { runModelVisibleHandler } from "./runtime.ts";

export function registerMethodHandlers(pi: ExtensionAPI, options: RegisterResearchToolsOptions): void {
	pi.registerTool({
		name: "research_design",
		label: "Build research design",
		description:
			"Create versioned research questions, concepts, theory relations, design decisions, and protocols, then request explicit user confirmation.",
		promptSnippet: "Turn canonical evidence and gaps into a user-confirmed research design",
		parameters: DesignParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["research_design", "research_evidence"],
				"Project policy does not allow this model to build a research design",
				async (project) => {
					if (project.manifest.revision !== params.expectedRevision) {
						return failureResult(
							"DATA_CONFLICT",
							"DESIGN_PROJECT_REVISION_CONFLICT",
							"data_conflict",
							`Expected project revision ${params.expectedRevision}, found ${project.manifest.revision}`,
							null,
						);
					}
					const inputs = await resolveRecordInputs(project.root, requestedDesignInputs(params));
					return trackedTool(
						project,
						ctx,
						options,
						"research.design",
						(operation) => designTool(project, ctx, params, operation),
						inputs,
					);
				},
			);
		},
	});

	pi.registerTool({
		name: "research_analysis",
		label: "Run reproducible research analysis",
		description:
			"Import CSV data, record and confirm an analysis specification, detect Python/R/Stata, and execute a traceable local run without installing dependencies.",
		promptSnippet:
			"Use confirmed scripts and immutable data copies; never infer successful convergence from process exit alone",
		parameters: AnalysisParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["research_analysis"],
				"Project policy does not allow this model to run research analysis",
				async (project) => {
					if ("expectedRevision" in params && project.manifest.revision !== params.expectedRevision) {
						return failureResult(
							"DATA_CONFLICT",
							"ANALYSIS_PROJECT_REVISION_CONFLICT",
							"data_conflict",
							`Expected project revision ${params.expectedRevision}, found ${project.manifest.revision}`,
							null,
						);
					}
					const inputs = await requestedAnalysisInputs(project.root, params);
					const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
					return trackedTool(
						project,
						ctx,
						options,
						"research.analysis",
						(operation) => analysisTool(project, ctx, params, operation, executionSignal),
						inputs.records,
						inputs.files,
					);
				},
			);
		},
	});

	pi.registerTool({
		name: "research_qualitative",
		label: "Audit qualitative research",
		description:
			"Import and segment text, version codebooks, separate model suggestions from human coding decisions, synthesize themes, and render an audit trail.",
		promptSnippet:
			"Treat coding as a human decision and preserve suggestions, edits, rejected codes, and negative cases",
		parameters: QualitativeParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dataClasses =
				params.action === "segment_material" ||
				params.action === "record_model_suggestion" ||
				params.action === "audit"
					? ["qualitative_material"]
					: [];
			return runModelVisibleHandler(
				ctx,
				options,
				dataClasses,
				"Project policy does not allow this model to process qualitative material",
				async (project) => {
					if (project.manifest.revision !== params.expectedRevision) {
						return failureResult(
							"DATA_CONFLICT",
							"QUALITATIVE_PROJECT_REVISION_CONFLICT",
							"data_conflict",
							`Expected project revision ${params.expectedRevision}, found ${project.manifest.revision}`,
							null,
						);
					}
					const inputs = await requestedQualitativeInputs(project.root, params);
					return trackedTool(
						project,
						ctx,
						options,
						"research.qualitative",
						(operation) => qualitativeTool(project, ctx, params, operation),
						inputs,
						await inputFilesForRecords(project.root, inputs),
					);
				},
			);
		},
	});
}

function designDraft(params: Static<typeof DesignParameters>): DesignDraft {
	switch (params.action) {
		case "create_question":
			return {
				kind: "research_question_version",
				value: {
					questionSeriesId: params.questionSeriesId,
					version: params.version,
					text: params.text,
					questionType: params.questionType,
					rationale: params.rationale,
					scope: params.scope,
					boundaryConditions: params.boundaryConditions,
					basis: params.basis,
					supersedesResearchQuestionVersionId: params.supersedesResearchQuestionVersionId,
				},
			};
		case "create_concept":
			return {
				kind: "concept",
				value: {
					name: params.name,
					definition: params.definition,
					role: params.role,
					aliases: params.aliases,
					measurementNotes: params.measurementNotes,
					boundaryConditions: params.boundaryConditions,
					basis: params.basis,
					supersedesConceptId: params.supersedesConceptId,
				},
			};
		case "create_relation":
			return {
				kind: "theory_relation",
				value: {
					fromConceptId: params.fromConceptId,
					toConceptId: params.toConceptId,
					relationType: params.relationType,
					direction: params.direction,
					statement: params.statement,
					hypothesesOrPropositions: params.hypothesesOrPropositions,
					boundaryConditions: params.boundaryConditions,
					alternativeExplanations: params.alternativeExplanations,
					basis: params.basis,
					supersedesTheoryRelationId: params.supersedesTheoryRelationId,
				},
			};
		case "create_decision":
			return {
				kind: "design_decision",
				value: {
					decisionType: params.decisionType,
					question: params.question,
					options: params.options,
					selectedOptionId: params.selectedOptionId,
					rationale: params.rationale,
					alternativesConsidered: params.alternativesConsidered,
					limitations: params.limitations,
					basis: params.basis,
					critical: params.critical,
					supersedesDesignDecisionId: params.supersedesDesignDecisionId,
				},
			};
		case "create_protocol":
			return {
				kind: "protocol",
				value: {
					title: params.title,
					researchQuestionVersionId: params.researchQuestionVersionId,
					designType: params.designType,
					claimMode: params.claimMode,
					method: params.method,
					population: params.population,
					unitOfAnalysis: params.unitOfAnalysis,
					timeframe: params.timeframe,
					samplingPlan: params.samplingPlan,
					measurementPlan: params.measurementPlan,
					dataCollectionPlan: params.dataCollectionPlan,
					analysisPlan: params.analysisPlan,
					identificationStrategy: params.identificationStrategy,
					identificationAssumptions: params.identificationAssumptions,
					preanalysisPlan: params.preanalysisPlan,
					interviewPlan: params.interviewPlan,
					caseSelectionPlan: params.caseSelectionPlan,
					inclusionCriteria: params.inclusionCriteria,
					exclusionCriteria: params.exclusionCriteria,
					alternativeExplanations: params.alternativeExplanations,
					boundaryConditions: params.boundaryConditions,
					feasibilityLimits: params.feasibilityLimits,
					ethicsChecklist: params.ethicsChecklist,
					decisionIds: params.decisionIds,
					conceptIds: params.conceptIds,
					theoryRelationIds: params.theoryRelationIds,
					basis: params.basis,
					supersedesProtocolId: params.supersedesProtocolId,
				},
			};
		case "confirm":
			throw new TypeError("Confirmation is not a design draft");
	}
}

export function requestedDesignInputs(params: Static<typeof DesignParameters>): RecordRef[] {
	if (params.action === "confirm") {
		return [{ kind: params.recordKind, id: params.recordId, revision: params.expectedRecordRevision }];
	}
	const refs: RecordRef[] = [...params.basis.provenance];
	if (params.action === "create_question" && params.supersedesResearchQuestionVersionId !== null) {
		refs.push({
			kind: "research_question_version",
			id: params.supersedesResearchQuestionVersionId,
			revision: null,
		});
	}
	if (params.action === "create_concept" && params.supersedesConceptId !== null) {
		refs.push({ kind: "concept", id: params.supersedesConceptId, revision: null });
	}
	if (params.action === "create_relation") {
		refs.push(
			{ kind: "concept", id: params.fromConceptId, revision: null },
			{ kind: "concept", id: params.toConceptId, revision: null },
		);
		if (params.supersedesTheoryRelationId !== null) {
			refs.push({ kind: "theory_relation", id: params.supersedesTheoryRelationId, revision: null });
		}
	}
	if (params.action === "create_decision" && params.supersedesDesignDecisionId !== null) {
		refs.push({ kind: "design_decision", id: params.supersedesDesignDecisionId, revision: null });
	}
	if (params.action === "create_protocol") {
		refs.push({ kind: "research_question_version", id: params.researchQuestionVersionId, revision: null });
		refs.push(...params.decisionIds.map((id) => ({ kind: "design_decision" as const, id, revision: null })));
		refs.push(...params.conceptIds.map((id) => ({ kind: "concept" as const, id, revision: null })));
		refs.push(...params.theoryRelationIds.map((id) => ({ kind: "theory_relation" as const, id, revision: null })));
		if (params.supersedesProtocolId !== null) {
			refs.push({ kind: "protocol", id: params.supersedesProtocolId, revision: null });
		}
	}
	return refs;
}

function designRecordLabel(record: DesignRecord): string {
	switch (record.kind) {
		case "research_question_version":
			return record.text;
		case "concept":
			return `${record.name}: ${record.definition}`;
		case "theory_relation":
			return record.statement;
		case "design_decision":
			return record.question;
		case "protocol":
			return record.title;
	}
}

export async function designTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof DesignParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<DesignRecord>> {
	if (params.action !== "confirm") {
		const result = await commitDesignDraft(project.root, operation.operationId, designDraft(params));
		return result.ok
			? {
					result,
					outputs: [
						{ kind: result.value.kind, id: projectRecordId(result.value), revision: result.value.audit.revision },
					],
				}
			: { result };
	}
	const awaiting = await markDesignAwaitingConfirmation(
		project.root,
		params.recordKind as DesignRecordKind,
		params.recordId,
		params.expectedRecordRevision,
		operation.operationId,
	);
	if (!awaiting.ok) return { result: awaiting };
	if (!ctx.hasUI) {
		return {
			result: failureResult(
				"PERMISSION_BLOCKED",
				"DESIGN_USER_CONFIRMATION_REQUIRED",
				"permission",
				`${params.recordKind} ${params.recordId} is awaiting user confirmation`,
				operation.operationId,
			),
		};
	}
	const confirmed = await ctx.ui.confirm(
		"Confirm research design record",
		`${designRecordLabel(awaiting.value)}\n\nChoose Yes to confirm. Choose No to preserve this version as rejected.`,
	);
	const decided = await decideDesignRecord(
		project.root,
		params.recordKind as DesignRecordKind,
		params.recordId,
		awaiting.value.audit.revision,
		confirmed ? "confirmed" : "rejected",
		params.note ?? null,
		operation.operationId,
	);
	return decided.ok
		? {
				result: decided,
				outputs: [
					{
						kind: decided.value.kind,
						id: projectRecordId(decided.value),
						revision: decided.value.audit.revision,
					},
				],
			}
		: { result: decided };
}

type AnalysisToolValue =
	| ImportDatasetValue
	| CreateAnalysisSpecificationValue
	| RuntimeDetection
	| AnalysisExecutionValue
	| RecordRef;

type QualitativeToolValue =
	| QualitativeMaterial
	| QualitativeSegment[]
	| CodebookVersion
	| ModelSuggestion
	| CodingDecision
	| ThemeSynthesis
	| QualitativeAudit
	| RecordRef;

export async function inputFilesForRecords(projectRoot: string, refs: readonly RecordRef[]): Promise<FileRef[]> {
	const files: FileRef[] = [];
	for (const ref of refs) {
		const result = await readRecord(projectRoot, ref.kind, ref.id);
		if (!result.ok) throw new TypeError(result.errors[0].message);
		if (result.value.kind === "dataset" || result.value.kind === "qualitative_material") {
			files.push(result.value.sourceFile);
		}
		if (result.value.kind === "analysis_specification") {
			files.push(result.value.script, ...result.value.inputFiles);
			if (result.value.environmentFile !== null) files.push(result.value.environmentFile);
		}
	}
	return [...new Map(files.map((file) => [file.path, file])).values()];
}

export async function requestedAnalysisInputs(
	projectRoot: string,
	params: Static<typeof AnalysisParameters>,
): Promise<{ records: RecordRef[]; files: FileRef[] }> {
	const refs: RecordRef[] = [];
	if (params.action === "create_specification") {
		refs.push(...params.datasetIds.map((id) => ({ kind: "dataset" as const, id, revision: null })));
	}
	if (params.action === "decide_specification" || params.action === "run") {
		const specification = await readRecord(projectRoot, "analysis_specification", params.analysisSpecificationId);
		if (!specification.ok) throw new TypeError(specification.errors[0].message);
		if (specification.value.kind !== "analysis_specification")
			throw new TypeError("Analysis specification is invalid");
		refs.push(recordReference(specification.value));
		if (params.action === "run") {
			refs.push(
				...specification.value.inputDatasetIds.map((id) => ({ kind: "dataset" as const, id, revision: null })),
			);
		}
	}
	const records = await resolveRecordInputs(projectRoot, refs);
	return { records, files: await inputFilesForRecords(projectRoot, records) };
}

export async function analysisTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof AnalysisParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<AnalysisToolValue>> {
	if (params.action === "detect_runtime") {
		return {
			result: successResult(
				await detectAnalysisRuntime(params.runtime, params.executable ?? undefined),
				operation.operationId,
			),
		};
	}
	let opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
	}
	if (params.action === "import_dataset") {
		const result = await importCsvDataset(opened.root, {
			path: params.path,
			title: params.title,
			sensitivity: params.sensitivity,
			expectedManifestRevision: opened.manifest.revision,
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		return result.ok
			? {
					result,
					outputs: [recordReference(result.value.dataset), ...result.value.variables.map(recordReference)],
					outputFiles: [result.value.dataset.sourceFile],
				}
			: { result };
	}
	if (params.action === "create_specification") {
		const result = await createAnalysisSpecification(opened.root, {
			title: params.title,
			protocolId: params.protocolId,
			datasetIds: params.datasetIds,
			runtime: params.runtime,
			scriptPath: params.scriptPath,
			environmentPath: params.environmentPath,
			parameters: params.parameters,
			randomSeed: params.randomSeed,
			commandArguments: params.commandArguments,
			expectedOutputs: params.expectedOutputs,
			timeoutSeconds: params.timeoutSeconds,
			claimMode: params.claimMode,
			expectedManifestRevision: opened.manifest.revision,
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		if (!result.ok) return { result };
		const addedInputs = await addOperationInputs(opened.root, operation.operationId, result.value.inputs, [
			result.value.specification.script,
			...result.value.specification.inputFiles,
			...(result.value.specification.environmentFile === null ? [] : [result.value.specification.environmentFile]),
		]);
		return addedInputs.ok
			? { result, outputs: [recordReference(result.value.specification)] }
			: { result: propagatedFailure(addedInputs, operation.operationId) };
	}
	if (params.action === "decide_specification") {
		if (!ctx.hasUI) {
			return {
				result: failureResult(
					"PERMISSION_BLOCKED",
					"ANALYSIS_SPECIFICATION_CONFIRMATION_REQUIRED",
					"permission",
					"Analysis specification decision requires interactive user confirmation",
					operation.operationId,
				),
			};
		}
		const accepted = await ctx.ui.confirm(
			"Decide analysis specification",
			`${params.decision === "confirmed" ? "Confirm" : "Reject"} analysis specification ${params.analysisSpecificationId}?`,
		);
		if (!accepted) {
			return {
				result: failureResult(
					"PERMISSION_BLOCKED",
					"ANALYSIS_SPECIFICATION_DECISION_CANCELLED",
					"cancelled",
					"User cancelled the analysis specification decision",
					operation.operationId,
				),
			};
		}
		opened = await openProject(project.root);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const result = await decideAnalysisSpecification(
			opened.root,
			params.analysisSpecificationId,
			opened.manifest.revision,
			params.expectedRecordRevision,
			params.decision,
			params.note ?? null,
			operation.operationId,
		);
		return result.ok ? { result, outputs: [result.value] } : { result };
	}
	const specification = await readRecord(opened.root, "analysis_specification", params.analysisSpecificationId);
	if (!specification.ok) return { result: propagatedFailure(specification, operation.operationId) };
	if (specification.value.kind !== "analysis_specification") {
		return { result: thrownFailure(new TypeError("Analysis specification is invalid"), operation.operationId) };
	}
	const detected = await detectAnalysisRuntime(specification.value.runtime, params.executable ?? undefined);
	if (!detected.available || detected.executable === null) {
		return {
			result: failureResult(
				"PERMANENT_FAILURE",
				"ANALYSIS_RUNTIME_UNAVAILABLE",
				"runtime",
				detected.reason ?? "Analysis runtime is unavailable",
				operation.operationId,
			),
		};
	}
	const analysisRunId = createOpaqueId("analysis_run");
	const taskId = createOpaqueId("task");
	const runPath = `.research/runs/${analysisRunId}`;
	const scriptCopy = `${runPath}/${basename(specification.value.script.path)}`;
	const command =
		specification.value.runtime === "stata"
			? [detected.executable, "-b", "do", scriptCopy, ...specification.value.commandArguments]
			: [detected.executable, scriptCopy, ...specification.value.commandArguments];
	opened = await openProject(project.root);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const request = createActionRequest({
		projectId: opened.manifest.projectId,
		operationId: operation.operationId,
		sessionId: ctx.sessionManager.getSessionId(),
		actionClass: specification.value.runtime === "stata" ? "commercial_runtime" : "unknown_script_execution",
		actionName: "research.analysis.execute",
		destination: null,
		paths: [specification.value.script.path, ...specification.value.inputFiles.map(({ path }) => path), runPath],
		dataClasses: ["research_dataset", "analysis_script"],
		estimatedCost: null,
		destructive: false,
		recoverable: true,
		fingerprintParameters: {
			analysisSpecificationId: specification.value.analysisSpecificationId,
			specificationRevision: specification.value.audit.revision,
			runtime: specification.value.runtime,
			command,
			inputs: specification.value.inputFiles.map(({ hash }) => hash),
			isolationFallback: "approved-host-user-execution",
		},
		policy: opened.manifest.policy,
	});
	const approval = await approveAction(
		opened.root,
		operation.operationId,
		ctx,
		request,
		"Run local research analysis",
		`Command: ${command.join(" ")}\nWorking directory: isolated temporary directory\nNetwork: denied when strong isolation is available\nFallback: host-user execution may access local files and network if platform isolation is unavailable\nInputs:\n${specification.value.inputFiles.map(({ path }) => `- ${path}`).join("\n")}`,
		operation.inputs,
		operation.inputFiles,
	);
	if (!approval.ok) return { result: approval };
	const execution = await executeAnalysis(opened.root, specification.value, operation.operationId, {
		allowHostExecution: true,
		executable: detected.executable,
		signal,
		analysisRunId,
		taskId,
	});
	return {
		result: execution.result,
		outputs:
			execution.task === null || execution.run === null
				? []
				: [recordReference(execution.task), recordReference(execution.run)],
		outputFiles:
			execution.task === null || execution.run === null ? [] : [...execution.run.outputs, ...execution.run.logs],
	};
}

export async function requestedQualitativeInputs(
	projectRoot: string,
	params: Static<typeof QualitativeParameters>,
): Promise<RecordRef[]> {
	const refs: RecordRef[] = [];
	if (params.action === "segment_material") {
		refs.push({ kind: "qualitative_material", id: params.qualitativeMaterialId, revision: null });
	}
	if (params.action === "create_codebook" && params.supersedesCodebookVersionId !== null) {
		refs.push({ kind: "codebook_version", id: params.supersedesCodebookVersionId, revision: null });
	}
	if (params.action === "decide_synthesis") refs.push({ kind: params.kind, id: params.id, revision: null });
	if (params.action === "record_model_suggestion") {
		refs.push(
			{ kind: "qualitative_segment", id: params.qualitativeSegmentId, revision: null },
			{ kind: "codebook_version", id: params.codebookVersionId, revision: null },
		);
	}
	if (params.action === "record_coding_decision") {
		refs.push(
			{ kind: "qualitative_segment", id: params.qualitativeSegmentId, revision: null },
			{ kind: "codebook_version", id: params.codebookVersionId, revision: null },
		);
		if (params.modelSuggestionId !== null)
			refs.push({ kind: "model_suggestion", id: params.modelSuggestionId, revision: null });
		if (params.supersedesCodingDecisionId !== null)
			refs.push({ kind: "coding_decision", id: params.supersedesCodingDecisionId, revision: null });
	}
	if (params.action === "create_theme_synthesis") {
		refs.push({ kind: "codebook_version", id: params.codebookVersionId, revision: null });
		refs.push(...params.codingDecisionIds.map((id) => ({ kind: "coding_decision" as const, id, revision: null })));
		if (params.supersedesThemeSynthesisId !== null)
			refs.push({ kind: "theme_synthesis", id: params.supersedesThemeSynthesisId, revision: null });
	}
	if (params.action === "audit") {
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		for (const kind of [
			"qualitative_material",
			"qualitative_segment",
			"codebook_version",
			"model_suggestion",
			"coding_decision",
			"theme_synthesis",
		] as const) {
			for (const id of await listProjectRecordIds(opened.root, opened.manifest, kind)) {
				refs.push({ kind, id, revision: null });
			}
		}
	}
	return resolveRecordInputs(projectRoot, refs);
}

export async function qualitativeTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof QualitativeParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<QualitativeToolValue>> {
	let opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
	}
	if (params.action === "import_material") {
		const result = await importQualitativeMaterial(opened.root, {
			path: params.path,
			title: params.title,
			sensitivity: params.sensitivity,
			deidentified: params.deidentified,
			expectedManifestRevision: opened.manifest.revision,
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		return result.ok
			? { result, outputs: [recordReference(result.value)], outputFiles: [result.value.sourceFile] }
			: { result };
	}
	if (params.action === "segment_material") {
		const result = await segmentQualitativeMaterial(
			opened.root,
			params.qualitativeMaterialId,
			opened.manifest.revision,
			operation.operationId,
		);
		return result.ok ? { result, outputs: result.value.map((segment) => recordReference(segment)) } : { result };
	}
	if (params.action === "create_codebook") {
		const result = await createCodebookVersion(
			opened.root,
			params.title,
			params.codes,
			params.supersedesCodebookVersionId,
			opened.manifest.revision,
			operation.operationId,
		);
		return result.ok ? { result, outputs: [recordReference(result.value)] } : { result };
	}
	if (params.action === "decide_synthesis") {
		if (!ctx.hasUI) {
			return {
				result: failureResult(
					"PERMISSION_BLOCKED",
					"QUALITATIVE_CONFIRMATION_REQUIRED",
					"permission",
					"Codebook and theme decisions require interactive user confirmation",
					operation.operationId,
				),
			};
		}
		const accepted = await ctx.ui.confirm(
			"Decide qualitative synthesis",
			`${params.decision === "confirmed" ? "Confirm" : "Reject"} ${params.kind} ${params.id}?`,
		);
		if (!accepted) {
			return {
				result: failureResult(
					"PERMISSION_BLOCKED",
					"QUALITATIVE_DECISION_CANCELLED",
					"cancelled",
					"User cancelled the qualitative synthesis decision",
					operation.operationId,
				),
			};
		}
		opened = await openProject(project.root);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const result = await decideQualitativeSynthesis(
			opened.root,
			params.kind,
			params.id,
			opened.manifest.revision,
			params.expectedRecordRevision,
			params.decision,
			params.note ?? null,
			operation.operationId,
		);
		return result.ok ? { result, outputs: [result.value] } : { result };
	}
	if (params.action === "record_model_suggestion") {
		if (ctx.model === undefined) {
			return {
				result: failureResult(
					"PERMANENT_FAILURE",
					"MODEL_PROVENANCE_UNAVAILABLE",
					"integrity",
					"Current model identity is unavailable",
					operation.operationId,
				),
			};
		}
		const result = await recordModelSuggestion(
			opened.root,
			params.qualitativeSegmentId,
			params.codebookVersionId,
			params.suggestedCodeIds,
			params.rationale,
			{ provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel ?? null },
			opened.manifest.revision,
			operation.operationId,
		);
		return result.ok ? { result, outputs: [recordReference(result.value)] } : { result };
	}
	if (params.action === "record_coding_decision") {
		if (!ctx.hasUI) {
			return {
				result: failureResult(
					"PERMISSION_BLOCKED",
					"HUMAN_CODING_DECISION_REQUIRED",
					"permission",
					"Coding decisions require interactive human confirmation",
					operation.operationId,
				),
			};
		}
		const accepted = await ctx.ui.confirm(
			"Record human coding decision",
			`Segment: ${params.qualitativeSegmentId}\nDecision: ${params.decision}\nCodes: ${params.assignedCodeIds.join(", ") || "none"}\n\nRecord this as the user's decision?`,
		);
		if (!accepted) {
			return {
				result: failureResult(
					"PERMISSION_BLOCKED",
					"HUMAN_CODING_DECISION_CANCELLED",
					"cancelled",
					"User cancelled the coding decision",
					operation.operationId,
				),
			};
		}
		opened = await openProject(project.root);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const result = await recordCodingDecision(
			opened.root,
			params.qualitativeSegmentId,
			params.codebookVersionId,
			params.modelSuggestionId,
			params.decision,
			params.assignedCodeIds,
			params.note ?? null,
			params.supersedesCodingDecisionId,
			opened.manifest.revision,
			operation.operationId,
		);
		return result.ok ? { result, outputs: [recordReference(result.value)] } : { result };
	}
	if (params.action === "create_theme_synthesis") {
		const result = await createThemeSynthesis(
			opened.root,
			params.codebookVersionId,
			params.title,
			params.themes,
			params.codingDecisionIds,
			params.supersedesThemeSynthesisId,
			opened.manifest.revision,
			operation.operationId,
		);
		return result.ok ? { result, outputs: [recordReference(result.value)] } : { result };
	}
	const result = await renderQualitativeAudit(opened.root);
	return { result };
}
