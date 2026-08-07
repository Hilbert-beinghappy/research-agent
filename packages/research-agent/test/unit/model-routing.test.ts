// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ResearchPolicyConfig } from "../../src/contracts/schemas.ts";
import { type ResearchModelRouteRequest, selectResearchModelRoute } from "../../src/routing/models.ts";

const policy: ResearchPolicyConfig = {
	sensitivity: "internal",
	defaultNetworkDecision: "ask",
	modelEgressAllowed: true,
	allowedModelProviders: ["approved-provider"],
	allowedDataClassesForModelEgress: ["bibliographic_metadata"],
	budgetHardLimit: { amount: 0.1, currency: "USD" },
	actionRules: [],
	unknownThirdPartyCode: "deny",
	retainRawProviderPayloads: true,
	rawPayloadRetentionDays: null,
};

const request: ResearchModelRouteRequest = {
	dataClasses: ["bibliographic_metadata"],
	requiredCapabilities: ["structured-output"],
	estimatedInputTokens: 10_000,
	maxCost: { amount: 0.05, currency: "USD" },
};

describe("research model routing", () => {
	it("selects the lowest-cost eligible route deterministically", () => {
		const result = selectResearchModelRoute(policy, request, [
			{
				provider: "approved-provider",
				model: "large",
				local: false,
				available: true,
				capabilities: ["structured-output"],
				contextWindow: 100_000,
				estimatedCost: { amount: 0.04, currency: "USD" },
			},
			{
				provider: "approved-provider",
				model: "small",
				local: false,
				available: true,
				capabilities: ["structured-output"],
				contextWindow: 20_000,
				estimatedCost: { amount: 0.01, currency: "USD" },
			},
		]);

		expect(result).toMatchObject({ status: "selected", candidate: { model: "small" } });
	});

	it("prefers an eligible local route without treating it as data egress", () => {
		const result = selectResearchModelRoute(
			{ ...policy, modelEgressAllowed: false },
			{ ...request, dataClasses: ["restricted_interview"] },
			[
				{
					provider: "local",
					model: "on-device",
					local: true,
					available: true,
					capabilities: ["structured-output"],
					contextWindow: 20_000,
					estimatedCost: { amount: 0, currency: "USD" },
				},
			],
		);

		expect(result).toMatchObject({ status: "selected", candidate: { model: "on-device" } });
	});

	it("returns explicit rejection reasons when no route is eligible", () => {
		const result = selectResearchModelRoute(policy, request, [
			{
				provider: "unapproved-provider",
				model: "expensive",
				local: false,
				available: true,
				capabilities: [],
				contextWindow: 1_000,
				estimatedCost: { amount: 1, currency: "USD" },
			},
		]);

		expect(result).toMatchObject({
			status: "blocked",
			evaluations: [
				{
					eligible: false,
					reasons: expect.arrayContaining([
						"context_window_too_small",
						"capability_missing",
						"provider_denied",
						"cost_limit_exceeded",
					]),
				},
			],
		});
	});

	it("blocks a route when request and project cost currencies cannot both be enforced", () => {
		const result = selectResearchModelRoute(policy, { ...request, maxCost: { amount: 1, currency: "EUR" } }, [
			{
				provider: "approved-provider",
				model: "euro-priced",
				local: false,
				available: true,
				capabilities: ["structured-output"],
				contextWindow: 20_000,
				estimatedCost: { amount: 0.01, currency: "EUR" },
			},
		]);

		expect(result).toMatchObject({
			status: "blocked",
			evaluations: [{ eligible: false, reasons: ["cost_limit_exceeded"] }],
		});
	});
});
