// SPDX-License-Identifier: Apache-2.0

import type { ZoteroWriteResult } from "../adapters/export/zotero.ts";
import type { ResearchArtifactType } from "../artifacts/render.ts";
import type {
	AdapterExportFormat,
	AdapterExportProfile,
	ExternalItemLink,
	JsonValue,
	RecordRef,
	ResearchError,
	ResearchResult,
	ResearchTask,
	SourceRecord,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { createRecord, createRecords, readRecord } from "../project/records.ts";

export interface CreateExportProfileInput {
	name: string;
	adapterId: string;
	adapterVersion: string;
	format: AdapterExportFormat;
	destination: AdapterExportProfile["destination"];
	credentialAlias: string | null;
	enabled: boolean;
	expectedManifestRevision: number;
	operationId: string;
}

function audit(operationId: string, at: string) {
	return {
		createdAt: at,
		updatedAt: at,
		revision: 0,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

export async function createExportProfile(
	projectRoot: string,
	input: CreateExportProfileInput,
): Promise<ResearchResult<AdapterExportProfile>> {
	const at = new Date().toISOString();
	const profile: AdapterExportProfile = {
		kind: "adapter_export_profile",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		adapterExportProfileId: createOpaqueId("adapter_export_profile"),
		name: input.name,
		adapterId: input.adapterId,
		adapterVersion: input.adapterVersion,
		format: input.format,
		destination: input.destination,
		credentialAlias: input.credentialAlias,
		enabled: input.enabled,
		createdAt: at,
		audit: audit(input.operationId, at),
	};
	const created = await createRecord(projectRoot, profile, {
		expectedManifestRevision: input.expectedManifestRevision,
		operationId: input.operationId,
	});
	return created.ok ? successResult(profile, input.operationId) : propagatedFailure(created, input.operationId);
}

export async function loadExportProfile(projectRoot: string, profileId: string): Promise<AdapterExportProfile> {
	const result = await readRecord(projectRoot, "adapter_export_profile", profileId);
	if (!result.ok || result.value.kind !== "adapter_export_profile") {
		throw new TypeError(`Invalid export profile: ${profileId}`);
	}
	return result.value;
}

async function externalLinks(projectRoot: string): Promise<ExternalItemLink[]> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const links: ExternalItemLink[] = [];
	for (const id of await listProjectRecordIds(opened.root, opened.manifest, "external_item_link")) {
		const result = await readRecord(opened.root, "external_item_link", id);
		if (!result.ok || result.value.kind !== "external_item_link") throw new TypeError(`Invalid external link: ${id}`);
		links.push(result.value);
	}
	return links;
}

export async function sourcesNeedingExport(
	projectRoot: string,
	profileId: string,
	sources: readonly SourceRecord[],
): Promise<{ pending: SourceRecord[]; reusedLinks: ExternalItemLink[] }> {
	const links = await externalLinks(projectRoot);
	const reusedLinks: ExternalItemLink[] = [];
	const pending = sources.filter((source) => {
		const contentHash = hashCanonicalJson(source).value;
		const existing = links.find(
			(link) =>
				link.adapterExportProfileId === profileId &&
				link.recordRef.kind === "source" &&
				link.recordRef.id === source.sourceId &&
				link.contentHash.value === contentHash &&
				link.syncStatus === "synced",
		);
		if (existing !== undefined) reusedLinks.push(existing);
		return existing === undefined;
	});
	return { pending, reusedLinks };
}

function writeError(result: ZoteroWriteResult, operationId: string, taskId: string | null): ResearchError {
	return {
		code: result.error?.code ?? "ZOTERO_WRITE_RESULT_INCOMPLETE",
		category: "external_service",
		message: result.error?.message ?? "Zotero did not confirm the external item",
		retryable: true,
		source: "zotero-api",
		operationId,
		taskId,
		details: { sourceId: result.source.sourceId },
		occurredAt: new Date().toISOString(),
		causeCode: null,
	};
}

export interface RecordZoteroLinksValue {
	links: ExternalItemLink[];
	retryTask: ResearchTask | null;
	recordRefs: RecordRef[];
}

export async function recordZoteroLinks(
	projectRoot: string,
	profile: AdapterExportProfile,
	results: readonly ZoteroWriteResult[],
	operationId: string,
): Promise<ResearchResult<RecordZoteroLinksValue>> {
	try {
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const failed = results.filter(({ error }) => error !== null);
		const retryTaskId = failed.length === 0 ? null : createOpaqueId("task");
		const at = new Date().toISOString();
		const links: ExternalItemLink[] = results.map((result) => ({
			kind: "external_item_link",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			externalItemLinkId: createOpaqueId("external_item_link"),
			adapterExportProfileId: profile.adapterExportProfileId,
			recordRef: { kind: "source", id: result.source.sourceId, revision: result.source.audit.revision },
			externalItemId: result.externalItemId,
			externalVersion: result.externalVersion,
			contentHash: hashCanonicalJson(result.source),
			syncStatus: result.error === null ? "synced" : "failed",
			lastError: result.error === null ? null : writeError(result, operationId, retryTaskId),
			attemptedAt: at,
			audit: audit(operationId, at),
		}));
		const retryTask: ResearchTask | null =
			retryTaskId === null
				? null
				: {
						kind: "task",
						schemaVersion: RESEARCH_SCHEMA_VERSION,
						taskId: retryTaskId,
						taskType: "zotero_export_retry",
						title: `Retry ${failed.length} Zotero export failure(s)`,
						inputs: failed.map(({ source }) => ({
							kind: "source",
							id: source.sourceId,
							revision: source.audit.revision,
						})),
						inputFiles: [],
						expectedOutputs: ["synced external item links"],
						outputs: [],
						outputFiles: [],
						dependencyTaskIds: [],
						status: "failed_retryable",
						attemptCount: 1,
						maxAttempts: 3,
						idempotencyKey: `zotero:${profile.adapterExportProfileId}:${
							hashCanonicalJson(failed.map(({ source }) => source.sourceId)).value
						}`,
						operationIds: [operationId],
						errors: failed.map((result) => writeError(result, operationId, retryTaskId)),
						resumeCursor: null,
						budget: { estimated: null, actual: { amount: 0, currency: "USD" } },
						createdAt: at,
						startedAt: at,
						finishedAt: at,
						updatedAt: at,
						revision: 0,
					};
		const records = retryTask === null ? links : [...links, retryTask];
		if (records.length === 0) return successResult({ links, retryTask, recordRefs: [] }, operationId);
		const created = await createRecords(projectRoot, records, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		if (!created.ok) return propagatedFailure(created, operationId);
		return successResult({ links, retryTask, recordRefs: created.value }, operationId);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"EXTERNAL_LINK_COMMIT_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Zotero reconciliation could not be recorded",
			operationId,
		);
	}
}

export function profileArtifactType(format: AdapterExportFormat): ResearchArtifactType | null {
	return format === "zotero-api" ? null : format;
}

export function profileSummary(profile: AdapterExportProfile): JsonValue {
	return {
		profileId: profile.adapterExportProfileId,
		name: profile.name,
		format: profile.format,
		destination: profile.destination,
		enabled: profile.enabled,
	};
}
