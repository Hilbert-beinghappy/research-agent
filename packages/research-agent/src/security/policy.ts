// SPDX-License-Identifier: Apache-2.0

import type {
	ActionClass,
	ApprovalRecord,
	HashValue,
	JsonValue,
	Money,
	ResearchPolicyConfig,
} from "../contracts/schemas.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { validatePortablePathSet } from "../kernel/paths.ts";
import { approvalCoversRequest, permanentDenyCoversRequest } from "./approval.ts";

export interface ActionRequest {
	projectId: string;
	operationId: string;
	sessionId: string | null;
	actionClass: ActionClass;
	actionName: string;
	actionFingerprint: string;
	destination: string | null;
	paths: string[];
	dataClasses: string[];
	estimatedCost: Money | null;
	destructive: boolean;
	recoverable: boolean;
	policySnapshotHash: HashValue;
}

export interface CreateActionRequestInput {
	projectId: string;
	operationId: string;
	sessionId: string | null;
	actionClass: ActionClass;
	actionName: string;
	destination: string | null;
	paths: string[];
	dataClasses: string[];
	estimatedCost: Money | null;
	destructive: boolean;
	recoverable: boolean;
	fingerprintParameters: JsonValue;
	policy: ResearchPolicyConfig;
}

export function createActionRequest(input: CreateActionRequestInput): ActionRequest {
	return {
		projectId: input.projectId,
		operationId: input.operationId,
		sessionId: input.sessionId,
		actionClass: input.actionClass,
		actionName: input.actionName,
		actionFingerprint: hashCanonicalJson({
			actionClass: input.actionClass,
			actionName: input.actionName,
			parameters: input.fingerprintParameters,
		}).value,
		destination: input.destination,
		paths: validatePortablePathSet(input.paths),
		dataClasses: [...input.dataClasses],
		estimatedCost: input.estimatedCost,
		destructive: input.destructive,
		recoverable: input.recoverable,
		policySnapshotHash: hashCanonicalJson(input.policy),
	};
}

export type PolicyEvaluation =
	| { decision: "allow"; approvalId: string | null; reason: string }
	| { decision: "ask" | "deny"; approvalId: null; reason: string };

export function evaluateActionPolicy(
	policy: ResearchPolicyConfig,
	request: ActionRequest,
	approvals: readonly ApprovalRecord[],
): PolicyEvaluation {
	const deny = approvals.find((approval) => permanentDenyCoversRequest(approval, request));
	if (deny !== undefined) return { decision: "deny", approvalId: null, reason: `Permanent deny ${deny.approvalId}` };

	const rule = policy.actionRules.find((candidate) => candidate.actionClass === request.actionClass);
	if (rule?.decision === "deny") return { decision: "deny", approvalId: null, reason: "Project policy denies action" };
	if (
		rule !== undefined &&
		request.destination !== null &&
		rule.allowedDestinations.length > 0 &&
		!rule.allowedDestinations.includes(request.destination)
	) {
		return { decision: "deny", approvalId: null, reason: "Destination is outside project policy" };
	}
	if (
		rule?.maxCostPerOperation !== null &&
		rule?.maxCostPerOperation !== undefined &&
		request.estimatedCost !== null &&
		(request.estimatedCost.currency !== rule.maxCostPerOperation.currency ||
			request.estimatedCost.amount > rule.maxCostPerOperation.amount)
	) {
		return { decision: "deny", approvalId: null, reason: "Cost exceeds project action limit" };
	}
	if (
		policy.budgetHardLimit !== null &&
		request.estimatedCost !== null &&
		(request.estimatedCost.currency !== policy.budgetHardLimit.currency ||
			request.estimatedCost.amount > policy.budgetHardLimit.amount)
	) {
		return { decision: "deny", approvalId: null, reason: "Cost exceeds project hard limit" };
	}

	const approval = approvals.find((candidate) => approvalCoversRequest(candidate, request));
	const alwaysConfirm: readonly ActionClass[] = [
		"project_overwrite",
		"destructive_file_action",
		"paid_service_call",
		"external_write",
		"sensitive_egress",
		"dependency_install",
		"commercial_runtime",
		"publish_or_submit",
	];
	if (alwaysConfirm.includes(request.actionClass) || rule?.decision === "ask") {
		return approval === undefined
			? { decision: "ask", approvalId: null, reason: "Explicit approval required" }
			: { decision: "allow", approvalId: approval.approvalId, reason: "Matching approval" };
	}
	if (rule?.decision === "allow") return { decision: "allow", approvalId: null, reason: "Project action rule" };
	if (request.actionClass === "public_network_read") {
		return policy.defaultNetworkDecision === "allow"
			? { decision: "allow", approvalId: null, reason: "Default public network policy" }
			: policy.defaultNetworkDecision === "deny"
				? { decision: "deny", approvalId: null, reason: "Default network policy" }
				: approval === undefined
					? { decision: "ask", approvalId: null, reason: "Network approval required" }
					: { decision: "allow", approvalId: approval.approvalId, reason: "Matching approval" };
	}
	if (request.actionClass === "unknown_script_execution") {
		return policy.unknownThirdPartyCode === "deny"
			? { decision: "deny", approvalId: null, reason: "Unknown third-party code denied" }
			: approval === undefined
				? { decision: "ask", approvalId: null, reason: "Script approval required" }
				: { decision: "allow", approvalId: approval.approvalId, reason: "Matching approval" };
	}
	return { decision: "allow", approvalId: null, reason: "Low-risk local action" };
}
