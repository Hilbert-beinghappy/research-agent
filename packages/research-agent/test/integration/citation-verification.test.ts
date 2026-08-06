import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CITATION_VERIFIER_VERSION } from "../../src/citations/verify.ts";
import type {
	FileRef,
	JsonValue,
	OperationRecord,
	OperationStatus,
	ResearchError,
	ResearchResult,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import { validatePersistedRecord } from "../../src/contracts/validators.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../../src/kernel/integrity.ts";
import { resolveProjectPath } from "../../src/kernel/paths.ts";
import { failureResult, successResult } from "../../src/kernel/results.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";
import {
	type CitationAdapterRun,
	type VerifyCitationRequest,
	verifyCitation,
} from "../../src/tools/verify-citations.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-citation-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Citation verification fixture" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function manifestRevision(): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	return opened.manifest.revision;
}

async function rawFile(operationId: string, label: string): Promise<FileRef> {
	const content = `${JSON.stringify({ fixture: label })}\n`;
	const path = `.research/runs/${operationId}/${label}.json`;
	const absolutePath = await resolveProjectPath(projectRoot, path);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content);
	return {
		path,
		hash: hashBytes(content),
		mediaType: "application/json",
		bytes: Buffer.byteLength(content),
	};
}

interface OperationInput {
	operationId: string;
	operationKind: OperationRecord["operationKind"];
	status: OperationStatus;
	name: string;
	implementationVersion: string;
	source: SourceRecord | null;
	adapterId: "crossref" | "openalex" | null;
	rawResponse: FileRef | null;
	error: ResearchError | null;
}

async function persistOperation(input: OperationInput): Promise<OperationRecord> {
	const now = new Date().toISOString();
	const terminal = !["planned", "running", "awaiting_approval"].includes(input.status);
	const operation: OperationRecord = {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId: input.operationId,
		taskId: null,
		operationKind: input.operationKind,
		name: input.name,
		implementationVersion: input.implementationVersion,
		status: input.status,
		session: null,
		actor: {
			type: input.operationKind === "adapter" ? "adapter" : "tool",
			id: input.adapterId ?? "research-citation-verifier",
		},
		modelExecution: null,
		adapterExecution:
			input.adapterId === null
				? null
				: {
						adapterId: input.adapterId,
						adapterVersion: "0.1.0",
						capabilitySnapshotHash: hashCanonicalJson({ adapterId: input.adapterId, fixture: true }),
					},
		inputs:
			input.source === null
				? []
				: [{ kind: "source", id: input.source.sourceId, revision: input.source.audit.revision }],
		inputFiles: [],
		outputs: [],
		outputFiles: [],
		rawRequest: null,
		rawResponse: input.rawResponse,
		approvalIds: [],
		usage: {
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			networkRequests: input.adapterId === null ? 0 : 1,
			cost: { amount: 0, currency: "USD" },
		},
		error: input.error,
		startedAt: input.status === "planned" ? null : now,
		finishedAt: terminal ? now : null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: input.operationId,
			updatedByOperationId: input.operationId,
		},
	};
	const created = await createRecord(projectRoot, operation, {
		expectedManifestRevision: await manifestRevision(),
		operationId: input.operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	return operation;
}

async function createSource(): Promise<SourceRecord> {
	const sourceId = createOpaqueId("source");
	const operationId = createOpaqueId("operation");
	const rawRecord = await rawFile(operationId, "source");
	await persistOperation({
		operationId,
		operationKind: "adapter",
		status: "succeeded",
		name: "local.import",
		implementationVersion: "0.1.0",
		source: null,
		adapterId: "crossref",
		rawResponse: rawRecord,
		error: null,
	});
	const now = new Date().toISOString();
	const source: SourceRecord = {
		kind: "source",
		schemaVersion: "0.1.0",
		sourceId,
		identifiers: [
			{
				scheme: "doi",
				value: "https://doi.org/10.5555/governance.1",
				normalizedValue: "10.5555/governance.1",
				verified: false,
				verificationId: null,
			},
		],
		title: "Governing the Commons",
		titleNormalized: "governing the commons",
		contributors: [{ family: "Ostrom", given: "Elinor", literal: null, orcid: null }],
		issuedDate: "1990",
		containerTitle: "Institutional Studies",
		publisher: "Fixture Press",
		sourceType: "book",
		language: "en",
		abstractText: null,
		abstractRights: "unknown",
		discovery: [
			{
				adapterId: "local",
				adapterVersion: "0.1.0",
				queryText: null,
				queryHash: null,
				discoveredAt: now,
				rank: null,
				rawRecord,
				requestOperationId: operationId,
			},
		],
		dedupKeys: {
			doi: "10.5555/governance.1",
			strongIdentifier: "doi:10.5555/governance.1",
			normalizedTitleYearFirstAuthor: "governing the commons|1990|ostrom",
			contentHash: null,
		},
		duplicateStatus: "canonical",
		canonicalSourceId: null,
		metadataConflicts: [],
		publicationStatus: "unknown",
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const created = await createRecord(projectRoot, source, {
		expectedManifestRevision: await manifestRevision(),
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	return source;
}

function matchingCandidate(overrides: Record<string, JsonValue> = {}): JsonValue {
	return {
		doi: "10.5555/governance.1",
		title: "Governing the Commons",
		authors: [{ family: "Ostrom", given: "Elinor", orcid: null }],
		issuedDate: "1990",
		containerTitle: "Institutional Studies",
		publisher: "Fixture Press",
		type: "book",
		language: "en",
		...overrides,
	};
}

async function providerRun(
	source: SourceRecord,
	adapterId: "crossref" | "openalex",
	check: CitationAdapterRun["check"],
	resultFactory: (operationId: string, rawResponse: FileRef) => ResearchResult<JsonValue>,
): Promise<CitationAdapterRun> {
	const operationId = createOpaqueId("operation");
	const rawResponse = await rawFile(operationId, `${adapterId}-${check}`);
	const result = resultFactory(operationId, rawResponse);
	const status: OperationStatus = result.ok
		? result.status === "PARTIAL_SUCCESS"
			? "partially_succeeded"
			: "succeeded"
		: result.status === "RETRYABLE_FAILURE" || result.status === "EXTERNAL_SERVICE_FAILURE"
			? "failed_retryable"
			: result.status === "PERMISSION_BLOCKED"
				? "blocked"
				: "failed_permanent";
	await persistOperation({
		operationId,
		operationKind: "adapter",
		status,
		name: `${adapterId}.${check}`,
		implementationVersion: "0.1.0",
		source,
		adapterId,
		rawResponse,
		error: result.ok ? null : result.errors[0],
	});
	return { check, operationId, result };
}

async function toolOperation(source: SourceRecord): Promise<string> {
	const operationId = createOpaqueId("operation");
	await persistOperation({
		operationId,
		operationKind: "tool",
		status: "running",
		name: "research.verify_citations",
		implementationVersion: CITATION_VERIFIER_VERSION,
		source,
		adapterId: null,
		rawResponse: null,
		error: null,
	});
	return operationId;
}

async function verify(
	source: SourceRecord,
	providerRuns: CitationAdapterRun[],
	refresh: VerifyCitationRequest["refresh"] = "revalidate",
) {
	const operationId = await toolOperation(source);
	return verifyCitation(projectRoot, {
		sourceId: source.sourceId,
		citationKey: "ostrom1990",
		providerRuns,
		refresh,
		matchThresholds: { title: 0.85, author: 0.8, yearTolerance: 1 },
		operationId,
		expectedManifestRevision: await manifestRevision(),
	});
}

function lookupSuccess(operationId: string, rawResponse: FileRef, candidate: JsonValue = matchingCandidate()) {
	return successResult<JsonValue>({ candidate, rawResponse, actualCost: { amount: 0, currency: "USD" } }, operationId);
}

function statusSuccess(operationId: string, rawResponse: FileRef, publicationStatus: string) {
	return successResult<JsonValue>(
		{
			publicationStatus,
			statusRelations: [],
			complete: true,
			rawResponse,
			actualCost: { amount: 0, currency: "USD" },
		},
		operationId,
	);
}

describe("citation verification", () => {
	it("persists exact bibliographic, existence, status, and raw provenance and reuses a fresh result", async () => {
		const source = await createSource();
		const lookup = await providerRun(source, "crossref", "lookup", (operationId, raw) =>
			lookupSuccess(operationId, raw),
		);
		const status = await providerRun(source, "crossref", "publication_status", (operationId, raw) =>
			statusSuccess(operationId, raw, "normal"),
		);
		const first = await verify(source, [lookup, status], "use-cache");
		expect(first).toMatchObject({
			ok: true,
			value: {
				finalStatus: "verified",
				publicationStatus: "normal",
				verificationSources: [{ adapterId: "crossref" }, { adapterId: "crossref" }],
				fieldChecks: [
					{ field: "identifier", status: "match" },
					{ field: "title", status: "match" },
					{ field: "authors", status: "match" },
					{ field: "year", status: "match" },
					{ field: "container", status: "match" },
				],
			},
		});
		if (!first.ok) throw new Error(first.errors[0].message);
		expect(first.value.identifiers[0]).toMatchObject({
			verified: true,
			verificationId: first.value.verificationId,
		});
		const replayLookup = await providerRun(source, "crossref", "lookup", (operationId, raw) =>
			lookupSuccess(operationId, raw),
		);
		const replayStatus = await providerRun(source, "crossref", "publication_status", (operationId, raw) =>
			statusSuccess(operationId, raw, "normal"),
		);
		const beforeReuse = await manifestRevision();
		const reused = await verify(source, [replayStatus, replayLookup], "use-cache");
		expect(reused).toMatchObject({ ok: true, value: { verificationId: first.value.verificationId } });
		expect(await manifestRevision()).toBe(beforeReuse + 1);
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
		await writeFile(
			await resolveProjectPath(projectRoot, first.value.verificationSources[0].rawRecord.path),
			"tampered after commit\n",
		);
		const tamperedProject = await validateProject(projectRoot);
		expect(tamperedProject.valid).toBe(false);
		expect(tamperedProject.issues).toContainEqual(expect.objectContaining({ code: "INVALID_CITATION_RAW_EVIDENCE" }));
	});

	it("keeps retraction and correction warnings separate from metadata conflicts", async () => {
		const source = await createSource();
		const lookup = await providerRun(source, "crossref", "lookup", (operationId, raw) =>
			lookupSuccess(operationId, raw),
		);
		const retractedStatus = await providerRun(source, "crossref", "publication_status", (operationId, raw) =>
			statusSuccess(operationId, raw, "retracted"),
		);
		const retracted = await verify(source, [lookup, retractedStatus]);
		expect(retracted).toMatchObject({
			ok: true,
			value: { publicationStatus: "retracted", finalStatus: "verified_with_warning" },
		});
		if (!retracted.ok) throw new Error(retracted.errors[0].message);
		const suppressed = validatePersistedRecord({ ...retracted.value, finalStatus: "verified" });
		expect(suppressed).toMatchObject({
			ok: false,
			issues: [{ code: "citation.warning_suppressed" }],
		});

		const correctedStatus = await providerRun(source, "crossref", "publication_status", (operationId, raw) =>
			statusSuccess(operationId, raw, "corrected"),
		);
		await expect(verify(source, [lookup, correctedStatus])).resolves.toMatchObject({
			ok: true,
			value: { publicationStatus: "corrected", finalStatus: "verified_with_warning" },
		});

		const conflictingLookup = await providerRun(source, "crossref", "lookup", (operationId, raw) =>
			lookupSuccess(operationId, raw, matchingCandidate({ title: "A Different Work" })),
		);
		const conflict = await verify(source, [conflictingLookup, correctedStatus]);
		expect(conflict).toMatchObject({ ok: true, value: { finalStatus: "conflict" } });
		if (!conflict.ok) throw new Error(conflict.errors[0].message);
		expect(conflict.value.fieldChecks).toContainEqual(
			expect.objectContaining({ field: "title", status: "conflict" }),
		);

		const identifierConflict = await providerRun(source, "crossref", "lookup", (operationId) =>
			failureResult<JsonValue>(
				"DATA_CONFLICT",
				"CROSSREF_DOI_CONFLICT",
				"data_conflict",
				"Crossref returned a different DOI",
				operationId,
			),
		);
		await expect(verify(source, [identifierConflict])).resolves.toMatchObject({
			ok: true,
			value: { finalStatus: "conflict", fieldChecks: [] },
		});

		const openAlexRetraction = await providerRun(source, "openalex", "lookup", (operationId, raw) =>
			lookupSuccess(
				operationId,
				raw,
				matchingCandidate({
					openalexId: "W1001",
					publicationStatus: "retracted",
				}),
			),
		);
		await expect(verify(source, [openAlexRetraction])).resolves.toMatchObject({
			ok: true,
			value: { publicationStatus: "retracted", finalStatus: "verified_with_warning" },
		});
		const normalStatus = await providerRun(source, "crossref", "publication_status", (operationId, raw) =>
			statusSuccess(operationId, raw, "normal"),
		);
		await expect(verify(source, [openAlexRetraction, normalStatus])).resolves.toMatchObject({
			ok: true,
			value: {
				publicationStatus: "retracted",
				finalStatus: "conflict",
				conflicts: [{ field: "publicationStatus", resolution: "unresolved" }],
			},
		});
	});

	it("distinguishes an authoritative not-found response from a service outage", async () => {
		const source = await createSource();
		const notFound = await providerRun(source, "crossref", "lookup", (operationId) =>
			failureResult<JsonValue>(
				"PERMANENT_FAILURE",
				"HTTP_NOT_FOUND",
				"not_found",
				"Crossref returned 404",
				operationId,
			),
		);
		await expect(verify(source, [notFound])).resolves.toMatchObject({
			ok: true,
			value: {
				finalStatus: "not_found",
				identifiers: [{ verified: false, verificationId: null }],
				verificationSources: [{ operationId: notFound.operationId }],
				fieldChecks: [],
			},
		});

		const unavailable = await providerRun(source, "crossref", "lookup", (operationId) =>
			failureResult<JsonValue>(
				"RETRYABLE_FAILURE",
				"HTTP_RETRYABLE_STATUS",
				"external_service",
				"Crossref returned 503",
				operationId,
			),
		);
		await expect(verify(source, [unavailable])).resolves.toMatchObject({
			ok: true,
			value: {
				finalStatus: "service_unavailable",
				verificationSources: [{ operationId: unavailable.operationId }],
				fieldChecks: [],
			},
		});
	});

	it("rejects provider evidence collected against a stale source revision", async () => {
		const source = await createSource();
		const lookup = await providerRun(source, "crossref", "lookup", (operationId, raw) =>
			lookupSuccess(operationId, raw),
		);
		const updateOperationId = await toolOperation(source);
		const updated = await updateRecord(projectRoot, "source", source.sourceId, {
			expectedManifestRevision: await manifestRevision(),
			expectedRecordRevision: 0,
			operationId: updateOperationId,
			changes: { title: "Governing the Commons, Revised" },
		});
		if (!updated.ok) throw new Error(updated.errors[0].message);
		const current = await readRecord(projectRoot, "source", source.sourceId);
		if (!current.ok || current.value.kind !== "source") throw new Error("expected updated source");
		await expect(verify(current.value, [lookup])).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "CITATION_PROVIDER_OPERATION_INVALID" }],
		});
	});

	it("rejects raw provider evidence that no longer matches its receipt", async () => {
		const source = await createSource();
		const lookup = await providerRun(source, "crossref", "lookup", (operationId, raw) =>
			lookupSuccess(operationId, raw),
		);
		const operation = await readRecord(projectRoot, "operation", lookup.operationId);
		if (!operation.ok || operation.value.kind !== "operation" || operation.value.rawResponse === null) {
			throw new Error("expected provider raw response");
		}
		await writeFile(await resolveProjectPath(projectRoot, operation.value.rawResponse.path), "tampered\n");
		await expect(verify(source, [lookup])).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "CITATION_RAW_EVIDENCE_INVALID", category: "integrity" }],
		});
	});
});
