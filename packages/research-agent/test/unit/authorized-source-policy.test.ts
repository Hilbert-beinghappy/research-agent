// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { accessPolicySnapshot, evaluateAuthorizedSourceAccess } from "../../src/access/policy.ts";
import type { AccessPolicySnapshot } from "../../src/contracts/schemas.ts";

const policy: AccessPolicySnapshot = {
	format: "pi-research-access-policy",
	version: 1,
	providerId: "licensed-provider",
	providerVersion: "1.0.0",
	policyVersion: "terms-2026-08",
	capturedAt: "2026-08-07T00:00:00.000Z",
	accessPath: "official_api",
	automationAllowed: true,
	termsReference: "https://provider.example/terms",
	downloadLimit: { maxRequests: 10, maxItems: 100, maxBytes: 1_000, period: "day" },
	entitlement: { credentialRequired: true, metadata: true, abstract: true, fullText: false, export: false },
	redistributionAllowed: false,
};

const request = {
	action: "metadata" as const,
	entitlementState: "active" as const,
	requestsUsed: 0,
	itemsUsed: 0,
	bytesUsed: 0,
	requestedItems: 1,
	requestedBytes: 100,
};

describe("authorized source policy", () => {
	it("allows only actions present in an active entitlement", () => {
		expect(evaluateAuthorizedSourceAccess(policy, request)).toEqual({
			status: "allowed",
			code: "ACCESS_ALLOWED",
			accessPath: "official_api",
		});
		expect(evaluateAuthorizedSourceAccess(policy, { ...request, action: "abstract" })).toMatchObject({
			status: "allowed",
		});
		expect(evaluateAuthorizedSourceAccess(policy, { ...request, action: "fulltext" })).toMatchObject({
			status: "blocked",
			code: "ENTITLEMENT_BLOCKED",
		});
	});

	it.each(["missing", "expired", "revoked"] as const)("blocks %s credentials", (entitlementState) => {
		expect(evaluateAuthorizedSourceAccess(policy, { ...request, entitlementState })).toMatchObject({
			status: "blocked",
			code: "AUTHENTICATION_BLOCKED",
			retryable: entitlementState === "expired",
		});
	});

	it("blocks automation and each recorded download limit", () => {
		expect(evaluateAuthorizedSourceAccess({ ...policy, automationAllowed: false }, request)).toMatchObject({
			code: "AUTOMATION_BLOCKED",
		});
		for (const usage of [{ requestsUsed: 10 }, { itemsUsed: 100 }, { bytesUsed: 1_000 }]) {
			expect(evaluateAuthorizedSourceAccess(policy, { ...request, ...usage })).toMatchObject({
				status: "blocked",
				code: "DOWNLOAD_LIMIT_BLOCKED",
			});
		}
	});

	it("keeps built-in snapshots free of credentials and distinguishes metadata from full text", () => {
		const snapshot = accessPolicySnapshot("openalex", "1.1.0", "2026-08-07T00:00:00.000Z", "official_api");
		expect(snapshot.entitlement).toMatchObject({ metadata: true, fullText: false });
		expect(JSON.stringify(snapshot)).not.toMatch(/password|secret|token|apiKey/iu);
	});

	it("rejects negative usage instead of letting it bypass a limit", () => {
		expect(() => evaluateAuthorizedSourceAccess(policy, { ...request, requestsUsed: -1 })).toThrow(
			"non-negative safe integers",
		);
	});
});
