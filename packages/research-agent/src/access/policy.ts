// SPDX-License-Identifier: Apache-2.0

import type { AccessPath, AccessPolicySnapshot } from "../contracts/schemas.ts";

export type AuthorizedSourceAction = "metadata" | "abstract" | "fulltext" | "export";
export type EntitlementState = "active" | "missing" | "expired" | "revoked";

export interface AuthorizedSourceAccessRequest {
	action: AuthorizedSourceAction;
	entitlementState: EntitlementState;
	requestsUsed: number;
	itemsUsed: number;
	bytesUsed: number;
	requestedItems: number;
	requestedBytes: number;
}

export type AuthorizedSourceAccessDecision =
	| { status: "allowed"; code: "ACCESS_ALLOWED"; accessPath: AccessPath }
	| {
			status: "blocked";
			code: "AUTOMATION_BLOCKED" | "AUTHENTICATION_BLOCKED" | "ENTITLEMENT_BLOCKED" | "DOWNLOAD_LIMIT_BLOCKED";
			retryable: boolean;
			message: string;
	  };

export function evaluateAuthorizedSourceAccess(
	policy: AccessPolicySnapshot,
	request: AuthorizedSourceAccessRequest,
): AuthorizedSourceAccessDecision {
	if (
		[request.requestsUsed, request.itemsUsed, request.bytesUsed, request.requestedItems, request.requestedBytes].some(
			(value) => !Number.isSafeInteger(value) || value < 0,
		)
	) {
		throw new TypeError("Authorized source usage values must be non-negative safe integers");
	}
	if (!policy.automationAllowed) {
		return {
			status: "blocked",
			code: "AUTOMATION_BLOCKED",
			retryable: false,
			message: "The recorded provider policy does not allow automated access",
		};
	}
	if (policy.entitlement.credentialRequired && request.entitlementState !== "active") {
		return {
			status: "blocked",
			code: "AUTHENTICATION_BLOCKED",
			retryable: request.entitlementState === "expired",
			message: `Provider entitlement is ${request.entitlementState}`,
		};
	}
	const entitled =
		request.action === "metadata"
			? policy.entitlement.metadata
			: request.action === "abstract"
				? policy.entitlement.abstract
				: request.action === "fulltext"
					? policy.entitlement.fullText
					: policy.entitlement.export;
	if (!entitled) {
		return {
			status: "blocked",
			code: "ENTITLEMENT_BLOCKED",
			retryable: false,
			message: `Provider entitlement does not allow ${request.action}`,
		};
	}
	const { maxRequests, maxItems, maxBytes } = policy.downloadLimit;
	if (
		(maxRequests !== null && request.requestsUsed + 1 > maxRequests) ||
		(maxItems !== null && request.itemsUsed + request.requestedItems > maxItems) ||
		(maxBytes !== null && request.bytesUsed + request.requestedBytes > maxBytes)
	) {
		return {
			status: "blocked",
			code: "DOWNLOAD_LIMIT_BLOCKED",
			retryable: policy.downloadLimit.period !== "operation",
			message: "The recorded provider download limit would be exceeded",
		};
	}
	return { status: "allowed", code: "ACCESS_ALLOWED", accessPath: policy.accessPath };
}

export function accessPolicySnapshot(
	providerId: string,
	providerVersion: string,
	capturedAt: string,
	accessPath: AccessPath,
): AccessPolicySnapshot {
	return {
		format: "pi-research-access-policy",
		version: 1,
		providerId,
		providerVersion,
		policyVersion: `${providerId}:${providerVersion}:built-in`,
		capturedAt,
		accessPath,
		automationAllowed: true,
		termsReference: null,
		downloadLimit: { maxRequests: null, maxItems: null, maxBytes: null, period: null },
		entitlement: {
			credentialRequired: false,
			metadata: true,
			abstract: true,
			fullText: accessPath === "user_authorized_file",
			export: false,
		},
		redistributionAllowed: false,
	};
}
