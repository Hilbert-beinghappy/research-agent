// SPDX-License-Identifier: Apache-2.0

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ResearchPolicyConfig } from "../contracts/schemas.ts";
import { MoneySchema } from "../contracts/schemas.ts";

export const ResearchModelCandidateSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		local: Type.Boolean(),
		available: Type.Boolean(),
		capabilities: Type.Array(Type.String({ minLength: 1 })),
		contextWindow: Type.Integer({ minimum: 1 }),
		estimatedCost: MoneySchema,
	},
	{ additionalProperties: false },
);
export type ResearchModelCandidate = Static<typeof ResearchModelCandidateSchema>;

export const ResearchModelRouteRequestSchema = Type.Object(
	{
		dataClasses: Type.Array(Type.String({ minLength: 1 })),
		requiredCapabilities: Type.Array(Type.String({ minLength: 1 })),
		estimatedInputTokens: Type.Integer({ minimum: 0 }),
		maxCost: Type.Union([MoneySchema, Type.Null()]),
	},
	{ additionalProperties: false },
);
export type ResearchModelRouteRequest = Static<typeof ResearchModelRouteRequestSchema>;

export const ResearchModelRouteInputSchema = Type.Object(
	{
		request: ResearchModelRouteRequestSchema,
		candidates: Type.Array(ResearchModelCandidateSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);
export type ResearchModelRouteInput = Static<typeof ResearchModelRouteInputSchema>;
const ResearchModelRouteInputValidator = Compile(ResearchModelRouteInputSchema);

export function parseResearchModelRouteInput(value: unknown): ResearchModelRouteInput {
	if (!ResearchModelRouteInputValidator.Check(value))
		throw new TypeError("Model route input does not satisfy v1 contract");
	return value;
}

export interface ResearchModelRouteEvaluation {
	provider: string;
	model: string;
	eligible: boolean;
	reasons: string[];
}

export type ResearchModelRoute =
	| {
			status: "selected";
			candidate: ResearchModelCandidate;
			evaluations: ResearchModelRouteEvaluation[];
	  }
	| {
			status: "blocked";
			candidate: null;
			evaluations: ResearchModelRouteEvaluation[];
	  };

export function selectResearchModelRoute(
	policy: ResearchPolicyConfig,
	request: ResearchModelRouteRequest,
	candidates: readonly ResearchModelCandidate[],
): ResearchModelRoute {
	const costLimits = [policy.budgetHardLimit, request.maxCost].filter((limit) => limit !== null);
	const evaluations = candidates.map((candidate): ResearchModelRouteEvaluation => {
		const reasons: string[] = [];
		if (!candidate.available) reasons.push("unavailable");
		if (candidate.contextWindow < request.estimatedInputTokens) reasons.push("context_window_too_small");
		if (request.requiredCapabilities.some((capability) => !candidate.capabilities.includes(capability))) {
			reasons.push("capability_missing");
		}
		if (!candidate.local) {
			if (!policy.modelEgressAllowed) reasons.push("model_egress_denied");
			if (policy.allowedModelProviders.length > 0 && !policy.allowedModelProviders.includes(candidate.provider)) {
				reasons.push("provider_denied");
			}
			if (
				policy.allowedDataClassesForModelEgress.length > 0 &&
				request.dataClasses.some((dataClass) => !policy.allowedDataClassesForModelEgress.includes(dataClass))
			) {
				reasons.push("data_class_denied");
			}
		}
		if (
			costLimits.some(
				(limit) =>
					candidate.estimatedCost.currency !== limit.currency || candidate.estimatedCost.amount > limit.amount,
			)
		) {
			reasons.push("cost_limit_exceeded");
		}
		return { provider: candidate.provider, model: candidate.model, eligible: reasons.length === 0, reasons };
	});
	const eligible = candidates
		.filter((_, index) => evaluations[index]?.eligible)
		.sort(
			(left, right) =>
				Number(left.local) * -1 - Number(right.local) * -1 ||
				left.estimatedCost.amount - right.estimatedCost.amount ||
				`${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
		);
	const candidate = eligible[0];
	return candidate === undefined
		? { status: "blocked", candidate: null, evaluations }
		: { status: "selected", candidate, evaluations };
}
