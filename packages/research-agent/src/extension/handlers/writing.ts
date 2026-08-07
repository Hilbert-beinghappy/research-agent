// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type {
	ManuscriptRecord,
	OperationRecord,
	RecordRef,
	ReviewFinding,
	RevisionDecision,
	SubmissionGateReport,
} from "../../contracts/schemas.ts";
import { failureResult } from "../../kernel/results.ts";
import { openProject } from "../../project/open.ts";
import type { ProjectRecord } from "../../project/record-index.ts";
import { createActionRequest } from "../../security/policy.ts";
import {
	createDisclosure,
	createManuscriptRevision,
	createSubmissionGateReport,
	diffManuscriptRevisions,
	evaluateSubmissionGate,
	type ManuscriptBundle,
	type ManuscriptRevisionDiff,
	recordReviewFindings,
	recordRevisionDecision,
} from "../../tools/writing.ts";
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
import { ManuscriptParameters, ReviewParameters } from "../tool-schemas.ts";
import { runModelVisibleHandler } from "./runtime.ts";

type ManuscriptToolValue = ManuscriptBundle | ManuscriptRevisionDiff | SubmissionGateReport | ProjectRecord;
type ReviewToolValue = ReviewFinding[] | RevisionDecision;

export function registerWritingHandlers(pi: ExtensionAPI, options: RegisterResearchToolsOptions): void {
	pi.registerTool({
		name: "research_manuscript",
		label: "Build auditable manuscripts",
		description:
			"Create immutable manuscript revisions, confirm AI disclosures, compare revisions, and run the deterministic submission gate.",
		promptSnippet: "Draft by section and map every core ClaimOccurrence to located evidence and verified citations",
		parameters: ManuscriptParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["manuscript", "research_evidence"],
				"Project policy does not allow this model to process manuscript and research evidence",
				async (project) => {
					if (project.manifest.revision !== params.expectedRevision) {
						return failureResult(
							"DATA_CONFLICT",
							"MANUSCRIPT_PROJECT_REVISION_CONFLICT",
							"data_conflict",
							`Expected project revision ${params.expectedRevision}, found ${project.manifest.revision}`,
							null,
						);
					}
					const inputs = await requestedManuscriptInputs(project.root, params);
					return trackedTool(
						project,
						ctx,
						options,
						"research.manuscript",
						(operation) => manuscriptTool(project, ctx, params, operation),
						inputs,
					);
				},
			);
		},
	});

	pi.registerTool({
		name: "research_review",
		label: "Review and revise manuscripts",
		description:
			"Record model rubric findings, deterministic integrity violations, human dispositions, and active revision changes without overwriting drafts.",
		promptSnippet:
			"Treat reviewer roles as rubrics; never let model findings override evidence, citations, or analysis runs",
		parameters: ReviewParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["manuscript", "research_evidence"],
				"Project policy does not allow this model to review manuscript and research evidence",
				async (project) => {
					if (project.manifest.revision !== params.expectedRevision) {
						return failureResult(
							"DATA_CONFLICT",
							"REVIEW_PROJECT_REVISION_CONFLICT",
							"data_conflict",
							`Expected project revision ${params.expectedRevision}, found ${project.manifest.revision}`,
							null,
						);
					}
					const inputs = await requestedReviewInputs(project.root, params);
					return trackedTool(
						project,
						ctx,
						options,
						"research.review",
						(operation) => reviewTool(project, ctx, params, operation),
						inputs,
					);
				},
			);
		},
	});
}

export async function requestedManuscriptInputs(
	projectRoot: string,
	params: Static<typeof ManuscriptParameters>,
): Promise<RecordRef[]> {
	const refs: RecordRef[] = [];
	if (params.action === "create_revision") {
		refs.push(
			...params.bibliography.map(({ sourceId }) => ({ kind: "source" as const, id: sourceId, revision: null })),
		);
		refs.push(...params.methodRecords);
		for (const section of params.sections) {
			refs.push(
				...section.occurrences.map(({ claimId }) => ({ kind: "claim" as const, id: claimId, revision: null })),
			);
			refs.push(
				...section.occurrences.flatMap(({ evidenceIds }) =>
					evidenceIds.map((id) => ({ kind: "evidence" as const, id, revision: null })),
				),
			);
		}
		if (params.supersedesManuscriptId !== null) {
			refs.push({ kind: "manuscript", id: params.supersedesManuscriptId, revision: null });
		}
	}
	if (params.action === "create_disclosure" || params.action === "submission_gate") {
		refs.push({ kind: "manuscript", id: params.manuscriptId, revision: null });
	}
	if (params.action === "diff") {
		refs.push(
			{ kind: "manuscript", id: params.fromManuscriptId, revision: null },
			{ kind: "manuscript", id: params.toManuscriptId, revision: null },
		);
	}
	return resolveRecordInputs(projectRoot, refs);
}

export async function manuscriptTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof ManuscriptParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<ManuscriptToolValue>> {
	let opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
	}
	if (params.action === "create_revision") {
		const authoring: ManuscriptRecord["authoring"] =
			params.authoringOrigin === "model"
				? {
						origin: "model",
						provider: ctx.model?.provider ?? null,
						modelId: ctx.model?.id ?? null,
					}
				: { origin: params.authoringOrigin, provider: null, modelId: null };
		const result = await createManuscriptRevision(opened.root, {
			title: params.title,
			paperType: params.paperType,
			abstract: params.abstract,
			bibliography: params.bibliography,
			methodRecords: params.methodRecords,
			sections: params.sections,
			supersedesManuscriptId: params.supersedesManuscriptId,
			authoring,
			expectedManifestRevision: opened.manifest.revision,
			operationId: operation.operationId,
		});
		return result.ok
			? {
					result,
					outputs: [
						recordReference(result.value.manuscript),
						...result.value.sections.map(recordReference),
						...result.value.occurrences.map(recordReference),
					],
				}
			: { result };
	}
	if (params.action === "diff") {
		return { result: await diffManuscriptRevisions(project.root, params.fromManuscriptId, params.toManuscriptId) };
	}
	if (params.action === "create_disclosure") {
		if (!ctx.hasUI) {
			return {
				result: failureResult(
					"PERMISSION_BLOCKED",
					"DISCLOSURE_CONFIRMATION_REQUIRED",
					"permission",
					"AI disclosure requires interactive user confirmation",
					operation.operationId,
				),
			};
		}
		const confirmed = await ctx.ui.confirm(
			"Confirm AI disclosure",
			`${params.aiUse}\n\nHuman responsibilities:\n${params.humanResponsibilities.map((item) => `- ${item}`).join("\n")}\n\nConfirm this disclosure for manuscript ${params.manuscriptId}?`,
		);
		if (!confirmed) {
			return {
				result: failureResult(
					"PERMISSION_BLOCKED",
					"DISCLOSURE_CONFIRMATION_CANCELLED",
					"cancelled",
					"User cancelled the AI disclosure",
					operation.operationId,
				),
			};
		}
		opened = await openProject(project.root);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const result = await createDisclosure(opened.root, {
			manuscriptId: params.manuscriptId,
			aiUse: params.aiUse,
			modelIds: params.modelIds,
			humanResponsibilities: params.humanResponsibilities,
			limitations: params.limitations,
			unautomatedDecisions: params.unautomatedDecisions,
			expectedManifestRevision: opened.manifest.revision,
			operationId: operation.operationId,
		});
		return result.ok ? { result, outputs: [recordReference(result.value)] } : { result };
	}

	const preview = await evaluateSubmissionGate(project.root, params.manuscriptId, null);
	if (!preview.ok) return { result: preview };
	const gateInputs = [
		...new Map(
			preview.value.checks
				.flatMap(({ recordRefs }) => recordRefs)
				.map((item) => [`${item.kind}:${item.id}:${item.revision}`, item]),
		).values(),
	];
	const addedInputs = await addOperationInputs(project.root, operation.operationId, gateInputs, []);
	if (!addedInputs.ok) return { result: propagatedFailure(addedInputs, operation.operationId) };
	let approvalId: string | null = null;
	if (!preview.value.checks.some(({ status }) => status === "failed")) {
		opened = await openProject(project.root);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const request = createActionRequest({
			projectId: opened.manifest.projectId,
			operationId: operation.operationId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionClass: "publish_or_submit",
			actionName: "research.manuscript.mark_submission_candidate",
			destination: null,
			paths: [],
			dataClasses: ["manuscript", "research_evidence"],
			estimatedCost: null,
			destructive: false,
			recoverable: true,
			fingerprintParameters: {
				manuscriptId: params.manuscriptId,
				checks: preview.value.checks,
			},
			policy: opened.manifest.policy,
		});
		const approval = await approveAction(
			opened.root,
			operation.operationId,
			ctx,
			request,
			"Confirm manuscript submission candidate",
			`Mark manuscript ${params.manuscriptId} as a submission candidate? This records readiness only; it does not submit externally.${preview.value.checks
				.filter(({ code, status }) => status === "warning" && code !== "publish_approval")
				.map(({ message }) => `\n- ${message}`)
				.join("")}`,
			gateInputs,
			[],
		);
		if (!approval.ok) return { result: approval };
		approvalId = approval.value;
	}
	opened = await openProject(project.root);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const result = await createSubmissionGateReport(
		opened.root,
		params.manuscriptId,
		approvalId,
		opened.manifest.revision,
		operation.operationId,
	);
	return result.ok ? { result, outputs: [recordReference(result.value)] } : { result };
}

export async function requestedReviewInputs(
	projectRoot: string,
	params: Static<typeof ReviewParameters>,
): Promise<RecordRef[]> {
	const refs: RecordRef[] = [];
	if (params.action === "record_findings" || params.action === "record_integrity_findings") {
		refs.push({ kind: "manuscript", id: params.manuscriptId, revision: null });
	}
	if (params.action === "decide_finding") {
		refs.push(
			{ kind: "manuscript", id: params.manuscriptId, revision: null },
			{ kind: "review_finding", id: params.reviewFindingId, revision: null },
		);
	}
	if (params.action === "set_active_revision") {
		refs.push({ kind: "manuscript", id: params.toManuscriptId, revision: null });
		if (params.fromManuscriptId !== null) {
			refs.push({ kind: "manuscript", id: params.fromManuscriptId, revision: null });
		}
	}
	return resolveRecordInputs(projectRoot, refs);
}

export async function reviewTool(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof ReviewParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<ReviewToolValue>> {
	let opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
	}
	if (params.action === "record_findings") {
		if (ctx.model === undefined) {
			return {
				result: thrownFailure(new TypeError("Current model identity is unavailable"), operation.operationId),
			};
		}
		const result = await recordReviewFindings(
			opened.root,
			params.manuscriptId,
			params.findings,
			"model",
			{ provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel ?? null },
			opened.manifest.revision,
			operation.operationId,
		);
		return result.ok ? { result, outputs: result.value.map(recordReference) } : { result };
	}
	if (params.action === "record_integrity_findings") {
		const evaluation = await evaluateSubmissionGate(opened.root, params.manuscriptId, null);
		if (!evaluation.ok) return { result: evaluation };
		const relevant = evaluation.value.checks.filter(
			({ code, status }) => status !== "passed" && code !== "publish_approval" && code !== "open_p0_review_findings",
		);
		const inputUpdate = await addOperationInputs(
			opened.root,
			operation.operationId,
			relevant.flatMap(({ recordRefs }) => recordRefs),
			[],
		);
		if (!inputUpdate.ok) return { result: propagatedFailure(inputUpdate, operation.operationId) };
		opened = await openProject(project.root);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const result = await recordReviewFindings(
			opened.root,
			params.manuscriptId,
			relevant.map((check) => ({
				reviewerRole: "integrity" as const,
				findingType: "deterministic_violation" as const,
				severity: check.status === "failed" ? ("P0" as const) : ("P1" as const),
				title: check.code,
				message: check.message,
				sectionId: null,
				claimOccurrenceId: null,
			})),
			"deterministic",
			null,
			opened.manifest.revision,
			operation.operationId,
		);
		return result.ok ? { result, outputs: result.value.map(recordReference) } : { result };
	}
	if (!ctx.hasUI) {
		return {
			result: failureResult(
				"PERMISSION_BLOCKED",
				"REVISION_CONFIRMATION_REQUIRED",
				"permission",
				"Review dispositions and active-revision changes require interactive user confirmation",
				operation.operationId,
			),
		};
	}
	const confirmed = await ctx.ui.confirm(
		params.action === "decide_finding" ? "Record review disposition" : "Change active manuscript revision",
		params.action === "decide_finding"
			? `${params.decision} finding ${params.reviewFindingId}?\n\n${params.rationale}`
			: `${params.decision} manuscript ${params.toManuscriptId}?\n\n${params.rationale}`,
	);
	if (!confirmed) {
		return {
			result: failureResult(
				"PERMISSION_BLOCKED",
				"REVISION_CONFIRMATION_CANCELLED",
				"cancelled",
				"User cancelled the revision decision",
				operation.operationId,
			),
		};
	}
	opened = await openProject(project.root);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const result =
		params.action === "decide_finding"
			? await recordRevisionDecision(opened.root, {
					fromManuscriptId: params.manuscriptId,
					toManuscriptId: params.manuscriptId,
					reviewFindingId: params.reviewFindingId,
					decision: params.decision,
					rationale: params.rationale,
					expectedManifestRevision: opened.manifest.revision,
					operationId: operation.operationId,
				})
			: await recordRevisionDecision(opened.root, {
					fromManuscriptId: params.fromManuscriptId,
					toManuscriptId: params.toManuscriptId,
					reviewFindingId: null,
					decision: params.decision,
					rationale: params.rationale,
					expectedManifestRevision: opened.manifest.revision,
					operationId: operation.operationId,
				});
	return result.ok ? { result, outputs: [recordReference(result.value)] } : { result };
}
