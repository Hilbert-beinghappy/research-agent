// SPDX-License-Identifier: Apache-2.0

import type { ApprovalRecord, Money, ResearchProjectManifest } from "../contracts/schemas.ts";
import { validateProjectRelativePath } from "../kernel/paths.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { readRecord } from "../project/records.ts";
import type { ActionRequest } from "./policy.ts";

function pathMatches(pattern: string, path: string): boolean {
	if (pattern.endsWith("/**")) {
		const directory = validateProjectRelativePath(pattern.slice(0, -3));
		return path === directory || path.startsWith(`${directory}/`);
	}
	return path === validateProjectRelativePath(pattern);
}

function costWithin(requested: Money | null, approved: Money | null): boolean {
	if (requested === null) return true;
	return approved !== null && requested.currency === approved.currency && requested.amount <= approved.amount;
}

function coversRequest(approval: ApprovalRecord, request: ActionRequest): boolean {
	if (
		approval.actionClass !== request.actionClass ||
		approval.actionName !== request.actionName ||
		approval.scopeTarget.projectId !== request.projectId ||
		approval.scopeTarget.actionFingerprint !== request.actionFingerprint ||
		approval.policySnapshotHash.value !== request.policySnapshotHash.value
	) {
		return false;
	}
	if (approval.expiresAt !== null) {
		const expiresAt = Date.parse(approval.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
	}
	if (approval.scopeTarget.destinationPattern !== request.destination) return false;
	if (approval.dataEgress.destination !== request.destination) return false;
	if (!request.dataClasses.every((dataClass) => approval.dataEgress.dataClasses.includes(dataClass))) return false;
	if (request.destructive && !approval.overwriteRisk.destructive) return false;
	if (!request.recoverable && approval.overwriteRisk.recoverable) return false;
	const pathPatterns = approval.scope === "once" ? approval.overwriteRisk.paths : approval.scopeTarget.pathPatterns;
	if (!request.paths.every((path) => pathPatterns.some((pattern) => pathMatches(pattern, path)))) return false;
	return costWithin(request.estimatedCost, approval.scopeTarget.maxApprovedCost ?? approval.estimatedCost);
}

export function approvalCoversRequest(approval: ApprovalRecord, request: ActionRequest): boolean {
	if (approval.decision !== "approved" || approval.scope === "permanent_deny") return false;
	if (!coversRequest(approval, request)) return false;
	switch (approval.scope) {
		case "once":
			return approval.operationId === request.operationId;
		case "session":
			return request.sessionId !== null && approval.scopeTarget.sessionId === request.sessionId;
		case "project":
			return true;
	}
}

export function permanentDenyCoversRequest(approval: ApprovalRecord, request: ActionRequest): boolean {
	return (
		approval.decision === "denied" &&
		approval.scope === "permanent_deny" &&
		approval.actionClass === request.actionClass &&
		approval.actionName === request.actionName &&
		approval.scopeTarget.projectId === request.projectId &&
		approval.scopeTarget.actionFingerprint === request.actionFingerprint &&
		approval.policySnapshotHash.value === request.policySnapshotHash.value &&
		approval.scopeTarget.destinationPattern === request.destination &&
		request.paths.every((path) => approval.scopeTarget.pathPatterns.some((pattern) => pathMatches(pattern, path)))
	);
}

export async function readApprovalRecords(
	projectRoot: string,
	manifest: ResearchProjectManifest,
): Promise<ApprovalRecord[]> {
	const approvals: ApprovalRecord[] = [];
	for (const approvalId of await listProjectRecordIds(projectRoot, manifest, "approval")) {
		const result = await readRecord(projectRoot, "approval", approvalId);
		if (!result.ok || result.value.kind !== "approval") throw new TypeError(`Invalid approval record: ${approvalId}`);
		approvals.push(result.value);
	}
	return approvals;
}
