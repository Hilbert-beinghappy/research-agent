// SPDX-License-Identifier: Apache-2.0

import type { HashValue, ResearchResult } from "../contracts/schemas.ts";
import { hashBytes, hashFile } from "../kernel/integrity.ts";
import { withPersistedRunningOperation } from "../kernel/operations.ts";
import { resolveProjectPath, validateProjectRelativePath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { updateRecord } from "../project/records.ts";
import { commitProjectTransaction } from "../project/transactions.ts";
import { readApprovalRecords } from "./approval.ts";
import { createActionRequest, evaluateActionPolicy } from "./policy.ts";

export interface BrokerFileInput {
	operationId: string;
	sessionId: string | null;
	expectedManifestRevision: number;
	path: string;
	content: string | Uint8Array | null;
	dataClasses: string[];
}

export interface BrokerFileReceipt {
	path: string;
	hash: HashValue | null;
	deleted: boolean;
	approvalId: string | null;
}

export function isProtectedProjectPath(path: string): boolean {
	const protectedPaths = [
		"research-project.json",
		".research/records",
		".research/runs",
		".research/transactions",
		".research/locks",
		".research/migrations",
	];
	return protectedPaths.some((protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`));
}

async function currentHash(path: string): Promise<HashValue | null> {
	try {
		return await hashFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function brokerProjectFile(
	projectRoot: string,
	input: BrokerFileInput,
): Promise<ResearchResult<BrokerFileReceipt>> {
	try {
		const path = validateProjectRelativePath(input.path);
		if (isProtectedProjectPath(path)) {
			return failureResult(
				"PERMISSION_BLOCKED",
				"PROTECTED_PROJECT_PATH",
				"permission",
				"Protected project state must use its dedicated repository or transaction API",
				input.operationId,
				{ path },
			);
		}
		const opened = await openProject(projectRoot, input.expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Project schema is read-only");
		const target = await resolveProjectPath(opened.root, path);
		const oldHash = await currentHash(target);
		const newHash = input.content === null ? null : hashBytes(input.content);
		if (newHash !== null && oldHash?.value === newHash.value) {
			return successResult({ path, hash: newHash, deleted: false, approvalId: null }, input.operationId);
		}
		if (input.content === null && oldHash === null) {
			return failureResult(
				"PERMANENT_FAILURE",
				"PROJECT_FILE_NOT_FOUND",
				"not_found",
				`Cannot delete missing project file: ${path}`,
				input.operationId,
			);
		}
		const actionClass =
			input.content === null ? "destructive_file_action" : oldHash === null ? "project_create" : "project_overwrite";
		const actionName = input.content === null ? "project.file.delete" : "project.file.write";
		const request = createActionRequest({
			projectId: opened.manifest.projectId,
			operationId: input.operationId,
			sessionId: input.sessionId,
			actionClass,
			actionName,
			destination: null,
			paths: [path],
			dataClasses: input.dataClasses,
			estimatedCost: null,
			destructive: input.content === null,
			recoverable: true,
			fingerprintParameters: {
				contentHash: newHash,
			},
			policy: opened.manifest.policy,
		});
		const evaluation = evaluateActionPolicy(
			opened.manifest.policy,
			request,
			await readApprovalRecords(opened.root, opened.manifest),
		);
		if (evaluation.decision !== "allow") {
			return failureResult(
				"PERMISSION_BLOCKED",
				evaluation.decision === "deny" ? "ACTION_DENIED" : "APPROVAL_REQUIRED",
				"permission",
				evaluation.reason,
				input.operationId,
				{ actionClass, path },
			);
		}

		await withPersistedRunningOperation(opened.root, input.operationId, async (operation) => {
			let manifest = opened.manifest;
			if (evaluation.approvalId !== null && !operation.approvalIds.includes(evaluation.approvalId)) {
				const update = await updateRecord(opened.root, "operation", input.operationId, {
					expectedManifestRevision: manifest.revision,
					expectedRecordRevision: operation.audit.revision,
					operationId: input.operationId,
					changes: { approvalIds: [...operation.approvalIds, evaluation.approvalId] },
				});
				if (!update.ok) {
					const message = update.errors[0].message;
					throw new Error(update.status === "DATA_CONFLICT" ? `DATA_CONFLICT: ${message}` : message);
				}
				const reopened = await openProject(opened.root, manifest.revision + 1);
				if (reopened.compatibility !== "current") throw new TypeError("Project schema changed during file action");
				manifest = reopened.manifest;
			}
			await commitProjectTransaction(opened.root, {
				expectedRevision: manifest.revision,
				writes: [{ path, content: input.content, expectedHash: oldHash }],
				manifest: {
					...manifest,
					lastCommittedOperationId: input.operationId,
					updatedAt: new Date().toISOString(),
					revision: manifest.revision + 1,
				},
			});
		});
		return successResult(
			{
				path,
				hash: newHash,
				deleted: input.content === null,
				approvalId: evaluation.approvalId,
			},
			input.operationId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("DATA_CONFLICT:") || message.startsWith("Transaction target hash mismatch")) {
			return failureResult("DATA_CONFLICT", "PROJECT_FILE_CONFLICT", "data_conflict", message, input.operationId);
		}
		if (message.includes("not persisted as running")) {
			return failureResult("PERMISSION_BLOCKED", "OPERATION_NOT_RUNNING", "permission", message, input.operationId);
		}
		return failureResult("PERMANENT_FAILURE", "PROJECT_FILE_BROKER_FAILED", "runtime", message, input.operationId);
	}
}
