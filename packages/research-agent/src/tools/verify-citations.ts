// SPDX-License-Identifier: Apache-2.0

import { stat } from "node:fs/promises";
import {
	buildCitationVerification,
	CITATION_VERIFIER_VERSION,
	type CitationCheckEvidence,
	type CitationCheckKind,
	type CitationMatchThresholds,
	citationVerificationFingerprint,
} from "../citations/verify.ts";
import type {
	CitationVerification,
	JsonValue,
	OperationRecord,
	ResearchResult,
	SourceRecord,
} from "../contracts/schemas.ts";
import { hashFile } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { createRecord, readRecord } from "../project/records.ts";

export interface CitationAdapterRun {
	check: CitationCheckKind;
	operationId: string;
	result: ResearchResult<JsonValue>;
}

export interface VerifyCitationRequest {
	sourceId: string;
	citationKey: string | null;
	providerRuns: CitationAdapterRun[];
	refresh: "use-cache" | "revalidate";
	matchThresholds: CitationMatchThresholds;
	operationId: string;
	expectedManifestRevision: number;
}

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

function hasSourceSnapshot(operation: OperationRecord, source: SourceRecord): boolean {
	return operation.inputs.some(
		(input) => input.kind === "source" && input.id === source.sourceId && input.revision === source.audit.revision,
	);
}

async function readToolOperation(
	projectRoot: string,
	operationId: string,
	source: SourceRecord,
): Promise<ResearchResult<OperationRecord>> {
	const result = await readRecord(projectRoot, "operation", operationId);
	if (!result.ok) return propagatedFailure(result, operationId);
	if (
		result.value.kind !== "operation" ||
		result.value.status !== "running" ||
		result.value.operationKind !== "tool" ||
		result.value.implementationVersion !== CITATION_VERIFIER_VERSION ||
		!hasSourceSnapshot(result.value, source)
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"CITATION_OPERATION_INVALID",
			"validation",
			"Citation verification requires a running current-version tool Operation with the current source snapshot",
			operationId,
		);
	}
	return successResult(result.value, operationId);
}

async function readProviderCheck(
	projectRoot: string,
	source: SourceRecord,
	run: CitationAdapterRun,
	commitOperationId: string,
): Promise<ResearchResult<CitationCheckEvidence>> {
	const result = await readRecord(projectRoot, "operation", run.operationId);
	if (!result.ok) return propagatedFailure(result, commitOperationId);
	if (result.value.kind !== "operation") {
		return failureResult(
			"PERMANENT_FAILURE",
			"CITATION_PROVIDER_OPERATION_INVALID",
			"integrity",
			`Record ${run.operationId} is not an Operation`,
			commitOperationId,
		);
	}
	const operation = result.value;
	const adapterId = operation.adapterExecution?.adapterId;
	const expectedStatus = run.result.ok
		? run.result.status === "PARTIAL_SUCCESS"
			? "partially_succeeded"
			: "succeeded"
		: run.result.status === "RETRYABLE_FAILURE" || run.result.status === "EXTERNAL_SERVICE_FAILURE"
			? "failed_retryable"
			: run.result.status === "PERMISSION_BLOCKED"
				? "blocked"
				: "failed_permanent";
	if (
		operation.operationKind !== "adapter" ||
		operation.adapterExecution === null ||
		(adapterId !== "crossref" && adapterId !== "openalex") ||
		operation.finishedAt === null ||
		!hasSourceSnapshot(operation, source) ||
		run.result.meta.operationId !== run.operationId ||
		operation.status !== expectedStatus ||
		(!run.result.ok && operation.error?.code !== run.result.errors[0].code) ||
		(run.result.ok && operation.rawResponse === null)
	) {
		return failureResult(
			"PERMANENT_FAILURE",
			"CITATION_PROVIDER_OPERATION_INVALID",
			"validation",
			`Citation provider Operation ${run.operationId} is incomplete or does not reference the current source`,
			commitOperationId,
		);
	}
	if (run.result.ok) {
		const value = run.result.value;
		const raw = value !== null && typeof value === "object" && !Array.isArray(value) ? value.rawResponse : null;
		if (
			raw === null ||
			typeof raw !== "object" ||
			Array.isArray(raw) ||
			raw.path !== operation.rawResponse?.path ||
			(raw.hash === null || typeof raw.hash !== "object" || Array.isArray(raw.hash) ? null : raw.hash.value) !==
				operation.rawResponse.hash?.value ||
			raw.mediaType !== operation.rawResponse.mediaType ||
			raw.bytes !== operation.rawResponse.bytes
		) {
			return failureResult(
				"PERMANENT_FAILURE",
				"CITATION_PROVIDER_RESULT_MISMATCH",
				"integrity",
				"Citation provider result does not reference its Operation raw response",
				commitOperationId,
			);
		}
	}
	if (run.check === "publication_status" && adapterId !== "crossref") {
		return failureResult(
			"PERMANENT_FAILURE",
			"CITATION_CHECK_UNSUPPORTED",
			"validation",
			"Only Crossref has a separate publication-status check in v0.1",
			commitOperationId,
		);
	}
	if (operation.rawResponse !== null) {
		try {
			if (
				operation.rawResponse.hash === null ||
				operation.rawResponse.mediaType === null ||
				operation.rawResponse.bytes === null
			) {
				throw new TypeError("raw response FileRef is incomplete");
			}
			const rawPath = await resolveProjectPath(projectRoot, operation.rawResponse.path);
			const rawStat = await stat(rawPath);
			const rawHash = await hashFile(rawPath);
			if (rawStat.size !== operation.rawResponse.bytes || rawHash.value !== operation.rawResponse.hash.value) {
				throw new TypeError("raw response bytes do not match the Operation receipt");
			}
		} catch (error) {
			return failureResult(
				"PERMANENT_FAILURE",
				"CITATION_RAW_EVIDENCE_INVALID",
				"integrity",
				error instanceof Error ? error.message : "Citation raw evidence is invalid",
				commitOperationId,
			);
		}
	}
	return successResult(
		{
			adapterId,
			adapterVersion: operation.adapterExecution.adapterVersion,
			operationId: operation.operationId,
			checkedAt: operation.finishedAt,
			check: run.check,
			rawRecord: operation.rawResponse,
			result: run.result,
		},
		commitOperationId,
	);
}

async function reusableVerification(
	projectRoot: string,
	manifest: Awaited<ReturnType<typeof openProject>> & { compatibility: "current" },
	source: SourceRecord,
	candidate: CitationVerification,
	now: string,
): Promise<CitationVerification | null> {
	if (candidate.finalStatus === "service_unavailable" || candidate.finalStatus === "incomplete") {
		return null;
	}
	const candidateFingerprint = citationVerificationFingerprint(candidate).value;
	// ponytail: O(n) citation scan; add a derived fingerprint index only after project benchmarks require it.
	for (const verificationId of await listProjectRecordIds(projectRoot, manifest.manifest, "citation_verification")) {
		const existing = await readRecord(projectRoot, "citation_verification", verificationId);
		if (!existing.ok) throw new Error(existing.errors[0].message);
		if (
			existing.value.kind !== "citation_verification" ||
			existing.value.expiresAt === null ||
			Date.parse(existing.value.expiresAt) <= Date.parse(now) ||
			citationVerificationFingerprint(existing.value).value !== candidateFingerprint
		) {
			continue;
		}
		const creator = await readRecord(projectRoot, "operation", existing.value.audit.createdByOperationId);
		if (
			creator.ok &&
			creator.value.kind === "operation" &&
			creator.value.implementationVersion === CITATION_VERIFIER_VERSION &&
			hasSourceSnapshot(creator.value, source)
		) {
			return existing.value;
		}
	}
	return null;
}

export async function verifyCitation(
	projectRoot: string,
	request: VerifyCitationRequest,
): Promise<ResearchResult<CitationVerification>> {
	try {
		const opened = await openProject(projectRoot, request.expectedManifestRevision);
		if (opened.compatibility !== "current") {
			return failureResult(
				"PERMANENT_FAILURE",
				"CITATION_PROJECT_READ_ONLY",
				"migration",
				"Research project schema is read-only",
				request.operationId,
			);
		}
		const sourceResult = await readRecord(opened.root, "source", request.sourceId);
		if (!sourceResult.ok) return propagatedFailure(sourceResult, request.operationId);
		if (sourceResult.value.kind !== "source") {
			return failureResult(
				"PERMANENT_FAILURE",
				"CITATION_SOURCE_INVALID",
				"integrity",
				`Record ${request.sourceId} is not a Source`,
				request.operationId,
			);
		}
		const source = sourceResult.value;
		const operation = await readToolOperation(opened.root, request.operationId, source);
		if (!operation.ok) return operation;
		if (request.providerRuns.length === 0) {
			return failureResult(
				"PERMANENT_FAILURE",
				"CITATION_PROVIDER_RUNS_REQUIRED",
				"validation",
				"Citation verification requires at least one provider run",
				request.operationId,
			);
		}
		const checks: CitationCheckEvidence[] = [];
		for (const run of request.providerRuns) {
			const check = await readProviderCheck(opened.root, source, run, request.operationId);
			if (!check.ok) return check;
			checks.push(check.value);
		}
		const now = new Date().toISOString();
		const citation = buildCitationVerification({
			source,
			citationKey: request.citationKey,
			checks,
			matchThresholds: request.matchThresholds,
			operationId: request.operationId,
			verifiedAt: now,
		});
		if (request.refresh === "use-cache") {
			const existing = await reusableVerification(opened.root, opened, source, citation, now);
			if (existing !== null) return successResult(existing, request.operationId);
		}
		const created = await createRecord(opened.root, citation, {
			expectedManifestRevision: request.expectedManifestRevision,
			operationId: request.operationId,
		});
		if (!created.ok) return propagatedFailure(created, request.operationId);
		const stored = await readRecord(opened.root, "citation_verification", citation.verificationId);
		if (!stored.ok) return propagatedFailure(stored, request.operationId);
		return stored.value.kind === "citation_verification"
			? successResult(stored.value, request.operationId)
			: failureResult(
					"PERMANENT_FAILURE",
					"CITATION_READBACK_INVALID",
					"integrity",
					"Committed citation verification could not be read back",
					request.operationId,
				);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Citation verification failed";
		return failureResult(
			message.startsWith("DATA_CONFLICT:") ? "DATA_CONFLICT" : "PERMANENT_FAILURE",
			message.startsWith("DATA_CONFLICT:") ? "CITATION_REVISION_CONFLICT" : "CITATION_VERIFICATION_FAILED",
			message.startsWith("DATA_CONFLICT:") ? "data_conflict" : "validation",
			message,
			request.operationId,
		);
	}
}
