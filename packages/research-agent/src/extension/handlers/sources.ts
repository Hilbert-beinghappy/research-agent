// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { accessPolicySnapshot } from "../../access/policy.ts";
import { UnpaywallAdapter } from "../../adapters/document/unpaywall.ts";
import { fetchHttpTransport } from "../../adapters/http/transport.ts";
import type { RawImportFile } from "../../adapters/import/local.ts";
import type { CrossrefAdapter } from "../../adapters/source/crossref.ts";
import { CITATION_VERIFIER_VERSION } from "../../citations/verify.ts";
import { canonicalStringify } from "../../contracts/canonical-json.ts";
import {
	type ApprovalRecord,
	type CitationVerification,
	type ClaimRecord,
	type DocumentRecord,
	type EvidenceCard,
	type FileRef,
	type JsonValue,
	type OperationRecord,
	RESEARCH_SCHEMA_VERSION,
	type RecordRef,
	type ResearchError,
	type ResearchResult,
	type SourceRecord,
} from "../../contracts/schemas.ts";
import { locateSourceDocument } from "../../documents/locate.ts";
import { type EvidenceCardDraft, evidenceFingerprint, validateEvidenceCardDraft } from "../../evidence/commit.ts";
import { queryCorpusRecords } from "../../evidence/query.ts";
import { createOpaqueId } from "../../kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../../kernel/integrity.ts";
import { resolveProjectPath } from "../../kernel/paths.ts";
import { failureResult, successResult } from "../../kernel/results.ts";
import { openProject } from "../../project/open.ts";
import { listProjectRecordIds } from "../../project/record-index.ts";
import { createRecord, readRecord } from "../../project/records.ts";
import { brokerProjectFile } from "../../security/broker-files.ts";
import type { HttpBrokerOptions } from "../../security/broker-http.ts";
import { acquireDocument, parseDocument, recordDocumentLocation } from "../../tools/documents.ts";
import {
	type ClaimDraft,
	commitClaim,
	commitEvidenceCard,
	findActiveEvidenceCardByFingerprint,
	linkEvidenceToClaim,
} from "../../tools/evidence.ts";
import { importSourceFiles } from "../../tools/import-sources.ts";
import { commitSourceCandidates, metadataObject, type SourceCandidateInput } from "../../tools/sources.ts";
import { type CitationAdapterRun, verifyCitation } from "../../tools/verify-citations.ts";
import {
	adapterOperation,
	addOperationInputs,
	type CurrentProject,
	childOperation,
	configuredAlias,
	defaultHttpOptions,
	governedRequest,
	linkApprovalToOperation,
	modelSemanticProvenance,
	propagatedFailure,
	type RegisterResearchToolsOptions,
	researchResult,
	type SearchRunSummary,
	type SearchSourcesValue,
	sourceAdapter,
	sourceRecord,
	sourcesByQueryHash,
	type ToolOutcome,
	thrownFailure,
	trackedTool,
	withAdditionalErrors,
	withoutOperation,
} from "../tool-operations.ts";
import {
	CORPUS_QUERY_DATA_CLASSES,
	CommitEvidenceParameters,
	DocumentsParameters,
	ImportSourcesParameters,
	QueryCorpusParameters,
	SearchSourcesParameters,
	VerifyCitationsParameters,
} from "../tool-schemas.ts";
import { runModelVisibleHandler } from "./runtime.ts";

export function registerSourceHandlers(pi: ExtensionAPI, options: RegisterResearchToolsOptions): void {
	pi.registerTool({
		name: "research_search_sources",
		label: "Search research sources",
		description:
			"Execute a frozen Crossref/OpenAlex search plan through governed adapters and commit normalized source records.",
		promptSnippet: "Search academic metadata with a bounded, auditable query plan",
		parameters: SearchSourcesParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["bibliographic_metadata", "research_abstract"],
				"Project policy does not allow this model to search research sources",
				async (project) => {
					const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
					return trackedTool(project, ctx, options, "research.search_sources", (operation) =>
						searchSources(project, ctx, options, params, operation, executionSignal),
					);
				},
			);
		},
	});

	pi.registerTool({
		name: "research_import_sources",
		label: "Import research sources",
		description: "Import local RIS, BibTeX, CSL-JSON, or PDF files through the governed project store.",
		promptSnippet: "Import local bibliography and document inputs without writing canonical JSON directly",
		parameters: ImportSourcesParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["bibliographic_metadata"],
				"Project policy does not allow this model to import research sources",
				(project) =>
					trackedTool(project, ctx, options, "research.import_sources", (operation) =>
						importSources(project, ctx, params, operation),
					),
			);
		},
	});

	pi.registerTool({
		name: "research_documents",
		label: "Manage research documents",
		description: "Locate, acquire, or parse research documents while preserving access and failure states.",
		promptSnippet: "Locate, acquire, and parse full text without bypassing access controls",
		parameters: DocumentsParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["research_document_text"],
				"Project policy does not allow this model to process research documents",
				async (project) => {
					const inputs = await sourceInputs(project.root, params.sourceIds);
					const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
					return trackedTool(
						project,
						ctx,
						options,
						"research.documents",
						(operation) => documents(project, ctx, options, params, operation, executionSignal),
						inputs,
					);
				},
			);
		},
	});

	pi.registerTool({
		name: "research_query_corpus",
		label: "Query research corpus",
		description: "Query canonical records and parsed PDF blocks with bounded deterministic pagination.",
		promptSnippet: "Read bounded, source-located corpus hits",
		parameters: QueryCorpusParameters,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				CORPUS_QUERY_DATA_CLASSES[params.scope],
				"Project policy does not allow this model to query the research corpus",
				async (project) => withoutOperation(await queryCorpusRecords(project.root, params, toolCallId)),
			);
		},
	});

	pi.registerTool({
		name: "research_commit_evidence",
		label: "Commit research evidence",
		description:
			"Validate and commit claim drafts and evidence drafts. Exact excerpts and evidence levels are checked deterministically.",
		promptSnippet: "Commit claims and evidence only after deterministic provenance checks",
		parameters: CommitEvidenceParameters,
		executionMode: "sequential",
		execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["research_evidence", "research_claim"],
				"Project policy does not allow this model to commit research evidence",
				(project) => {
					if (project.manifest.revision !== params.expectedRevision) {
						return Promise.resolve(
							failureResult(
								"DATA_CONFLICT",
								"EVIDENCE_REVISION_CONFLICT",
								"data_conflict",
								`Expected project revision ${params.expectedRevision}, found ${project.manifest.revision}`,
								null,
							),
						);
					}
					return trackedTool(project, ctx, options, "research.commit_evidence", (operation) =>
						commitEvidence(project, ctx, params, operation, toolCallId),
					);
				},
			);
		},
	});

	pi.registerTool({
		name: "research_verify_citations",
		label: "Verify research citations",
		description: "Verify source identifiers and metadata through governed Crossref/OpenAlex lookups.",
		promptSnippet: "Verify citation fields and publication status without treating service failure as success",
		parameters: VerifyCitationsParameters,
		executionMode: "sequential",
		execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runModelVisibleHandler(
				ctx,
				options,
				["bibliographic_metadata"],
				"Project policy does not allow this model to verify research citations",
				async (project) => {
					const inputs = await sourceInputs(project.root, params.sourceIds);
					const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
					return trackedTool(
						project,
						ctx,
						options,
						"research.verify_citations",
						(operation) => verifyCitations(project, ctx, options, params, operation, executionSignal),
						inputs,
						[],
						CITATION_VERIFIER_VERSION,
					);
				},
			);
		},
	});
}
export async function searchSources(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: Static<typeof SearchSourcesParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<SearchSourcesValue>> {
	if (new Set(params.queries.map(({ queryId }) => queryId)).size !== params.queries.length) {
		return { result: thrownFailure(new TypeError("Search query IDs must be unique"), operation.operationId) };
	}
	const baseHttp = defaultHttpOptions(options);
	const baseTransport = baseHttp.transport ?? fetchHttpTransport;
	let requestCount = 0;
	const http: HttpBrokerOptions = {
		...baseHttp,
		transport: async (request) => {
			requestCount += 1;
			return baseTransport(request);
		},
	};
	const errors: ResearchError[] = [];
	const candidates: SourceCandidateInput[] = [];
	const runs: SearchRunSummary[] = [];
	let costUsd = 0;
	let successfulRuns = 0;

	for (const query of params.queries) {
		if (
			query.filters.fromYear !== null &&
			query.filters.toYear !== null &&
			query.filters.fromYear > query.filters.toYear
		) {
			errors.push(
				thrownFailure<never>(
					new TypeError(`Query ${query.queryId} has an inverted year range`),
					operation.operationId,
				).errors[0],
			);
			continue;
		}
		for (const adapterId of [...new Set(query.adapterIds)]) {
			const adapter = sourceAdapter(adapterId, options);
			const capabilities = await adapter.capabilities();
			const queryHash = hashCanonicalJson({
				adapterId,
				adapterVersion: capabilities.adapterVersion,
				query: query.text.normalize("NFKC").replace(/\s+/gu, " ").trim(),
				filters: query.filters,
				maxResults: query.maxResults,
			});
			if (params.refresh === "use-cache") {
				const cached = await sourcesByQueryHash(project.root, adapterId, queryHash.value);
				// ponytail: without a search-log record, only a full requested page proves a reusable cache hit.
				if (cached.length >= query.maxResults) {
					const selected = cached.slice(0, query.maxResults);
					runs.push({
						queryId: query.queryId,
						adapterId,
						status: "cached",
						resultCount: selected.length,
						sourceIds: selected.map(({ source }) => source.sourceId),
						rawResponses: selected.flatMap(({ rawResponses }) => rawResponses),
						operationIds: [],
						requestCount: 0,
						costUsd: 0,
						candidateIds: [],
					});
					successfulRuns += 1;
					continue;
				}
			}

			const startRequests = requestCount;
			const startCost = costUsd;
			const startCandidates = candidates.length;
			const startErrors = errors.length;
			const rawResponses: FileRef[] = [];
			const operationIds: string[] = [];
			let cursor: JsonValue = null;
			let returned = 0;
			let runFailed = false;
			while (returned < query.maxResults) {
				const remainingRequests = params.budget.maxRequests - requestCount;
				if (remainingRequests < 1) break;
				const remainingResults = query.maxResults - returned;
				const pageSize = Math.min(adapterId === "crossref" ? 1_000 : 100, remainingResults);
				const run = await adapterOperation(
					project,
					ctx,
					adapter,
					"search",
					[],
					signal,
					http,
					(context) =>
						adapter.search(
							{
								queryText: query.text,
								filters: query.filters,
								pageSize,
								cursor,
								maxResults: query.maxResults,
								maxCost: { amount: Math.max(0, params.budget.maxUsd - costUsd), currency: "USD" },
							},
							context,
						),
					(intent) => {
						const remaining = params.budget.maxRequests - requestCount;
						if (remaining < 1) return null;
						const maxAttempts = Math.min(intent.maxAttempts, remaining);
						return {
							...intent,
							maxAttempts,
							estimatedCost:
								intent.estimatedCost === null
									? null
									: {
											amount: intent.costPerRequest.amount * maxAttempts,
											currency: intent.costPerRequest.currency,
										},
						};
					},
				);
				operationIds.push(run.operationId);
				if (!run.result.ok) {
					errors.push(...run.result.errors);
					runFailed = true;
					break;
				}
				errors.push(...run.result.errors);
				rawResponses.push(run.result.value.rawResponse);
				costUsd += run.result.value.actualCost.amount;
				const retrievedAt = new Date().toISOString();
				for (const [index, candidate] of run.result.value.candidates.entries()) {
					const candidateId = `${query.queryId}:${adapterId}:${run.result.value.rawResponse.hash?.value ?? run.operationId}:${index}`;
					candidates.push({
						candidateId,
						adapterId,
						adapterVersion: capabilities.adapterVersion,
						retrievedAt,
						rawRecord: run.result.value.rawResponse,
						metadata: metadataObject(candidate),
						sourceIdHint: null,
						documentContentHash: null,
						requiresBibliographicMatch: false,
						queryText: query.text,
						queryHash,
						rank: returned + index + 1,
						requestOperationId: run.operationId,
						abstractRights: "metadata_only",
						accessPolicy: accessPolicySnapshot(
							adapterId,
							capabilities.adapterVersion,
							retrievedAt,
							"official_api",
						),
					});
				}
				returned += run.result.value.candidates.length;
				cursor = run.result.value.nextCursor;
				if (run.result.value.exhausted || cursor === null || run.result.value.candidates.length === 0) break;
			}
			const budgetExhausted = returned < query.maxResults && requestCount >= params.budget.maxRequests;
			if (budgetExhausted) {
				errors.push({
					code: "REQUEST_BUDGET_EXHAUSTED",
					category: "budget",
					message: `Search request budget stopped ${query.queryId}/${adapterId}`,
					retryable: false,
					source: "research-search-sources",
					operationId: operation.operationId,
					taskId: null,
					details: { maxRequests: params.budget.maxRequests, hardStop: params.budget.hardStop },
					occurredAt: new Date().toISOString(),
					causeCode: null,
				});
			}
			const resultCount = candidates.length - startCandidates;
			if (!runFailed || resultCount > 0) successfulRuns += 1;
			runs.push({
				queryId: query.queryId,
				adapterId,
				status: budgetExhausted
					? "budget_exhausted"
					: runFailed
						? "failed"
						: errors.length > startErrors
							? "partially_succeeded"
							: "succeeded",
				resultCount,
				sourceIds: [],
				rawResponses,
				operationIds,
				requestCount: requestCount - startRequests,
				costUsd: costUsd - startCost,
				candidateIds: candidates.slice(startCandidates).map(({ candidateId }) => candidateId),
			});
			if (params.budget.hardStop && budgetExhausted) break;
		}
		if (params.budget.hardStop && requestCount >= params.budget.maxRequests) break;
	}

	const committed = await commitSourceCandidates(project.root, operation.operationId, candidates);
	if (!committed.ok) return { result: committed };
	const sourceByCandidate = new Map(
		committed.value.candidateSources.map(({ candidateId, sourceId }) => [candidateId, sourceId]),
	);
	for (const run of runs) {
		if (run.status !== "cached") {
			run.sourceIds = [
				...new Set(
					run.candidateIds
						.map((candidateId) => sourceByCandidate.get(candidateId))
						.filter((sourceId): sourceId is string => sourceId !== undefined),
				),
			];
		}
	}
	const rawResponses = [
		...new Map(runs.flatMap(({ rawResponses }) => rawResponses).map((file) => [file.path, file])).values(),
	];
	const value: SearchSourcesValue = {
		queryPlanId: params.queryPlanId,
		runs,
		createdSourceIds: committed.value.createdSourceIds,
		reusedSourceIds: committed.value.reusedSourceIds,
		rejected: committed.value.rejected as unknown as JsonValue[],
		possibleDuplicates: [
			...committed.value.possibleDuplicates,
			...committed.value.existingSourceDuplicates,
		] as unknown as JsonValue[],
		rawResponses,
		requestCount,
		cost: { amount: costUsd, currency: "USD" },
	};
	return {
		result: researchResult(value, operation.operationId, errors, successfulRuns > 0),
		outputs: committed.value.sourceRefs,
		outputFiles: rawResponses,
	};
}

async function importRawRecord(
	project: CurrentProject,
	ctx: ExtensionContext,
	operationId: string,
	raw: RawImportFile,
): Promise<ResearchResult<FileRef>> {
	if (raw.storedFile !== null) return successResult(raw.storedFile, operationId);
	if (raw.referencePath === null) {
		return failureResult(
			"PERMANENT_FAILURE",
			"IMPORT_RAW_RECORD_MISSING",
			"integrity",
			"Reference import has no source path",
			operationId,
		);
	}
	const content = `${canonicalStringify({
		version: 1,
		mode: "reference",
		path: raw.referencePath,
		format: raw.format,
		contentHash: raw.contentHash,
		bytes: raw.bytes,
		mediaType: raw.mediaType,
	})}\n`;
	const path = `sources/imports/${raw.contentHash.value}.reference.json`;
	const file: FileRef = {
		path,
		hash: hashBytes(content),
		mediaType: "application/json",
		bytes: Buffer.byteLength(content),
	};
	try {
		const existing = await readFile(await resolveProjectPath(project.root, path));
		if (hashBytes(existing).value !== file.hash?.value) {
			return failureResult(
				"DATA_CONFLICT",
				"IMPORT_REFERENCE_RECEIPT_CONFLICT",
				"integrity",
				"Content-addressed import reference receipt contains different bytes",
				operationId,
				{ path },
			);
		}
		return successResult(file, operationId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return failureResult(
				"PERMANENT_FAILURE",
				"IMPORT_REFERENCE_RECEIPT_READ_FAILED",
				"runtime",
				error instanceof Error ? error.message : "Import reference receipt could not be read",
				operationId,
			);
		}
	}
	const opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"IMPORT_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const stored = await brokerProjectFile(project.root, {
		operationId,
		sessionId: ctx.sessionManager.getSessionId(),
		expectedManifestRevision: opened.manifest.revision,
		path,
		content,
		dataClasses: ["bibliographic_metadata_reference"],
	});
	return stored.ok ? successResult(file, operationId) : propagatedFailure(stored, operationId);
}

interface ImportSourcesValue {
	importedSourceIds: string[];
	reusedSourceIds: string[];
	skippedCandidateIds: string[];
	conflicts: JsonValue[];
	unmatchedDocuments: JsonValue[];
	inputs: JsonValue[];
	portable: boolean;
}

export async function importSources(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof ImportSourcesParameters>,
	operation: OperationRecord,
): Promise<ToolOutcome<ImportSourcesValue>> {
	const opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
	}
	const imported = await importSourceFiles(project.root, {
		inputs: params.inputs,
		operationId: operation.operationId,
		sessionId: ctx.sessionManager.getSessionId(),
		expectedManifestRevision: opened.manifest.revision,
	});
	if (!imported.ok) return { result: imported };
	const rawRecords = new Map<number, FileRef>();
	const outputFiles: FileRef[] = [];
	const errors = [...imported.errors];
	for (const raw of imported.value.rawInputs) {
		const record = await importRawRecord(project, ctx, operation.operationId, raw);
		if (!record.ok) {
			errors.push(...record.errors);
			continue;
		}
		rawRecords.set(raw.inputIndex, record.value);
		outputFiles.push(record.value);
	}
	const retrievedAt = new Date().toISOString();
	const candidates: SourceCandidateInput[] = imported.value.sourceCandidates.flatMap((candidate) => {
		const rawRecord = rawRecords.get(candidate.inputIndex);
		return rawRecord === undefined
			? []
			: [
					{
						candidateId: candidate.candidateKey,
						adapterId: "local-import",
						adapterVersion: RESEARCH_SCHEMA_VERSION,
						retrievedAt,
						rawRecord,
						metadata: candidate.metadata,
						sourceIdHint: candidate.sourceIdHint,
						documentContentHash:
							candidate.format === "pdf"
								? (imported.value.rawInputs.find(({ inputIndex }) => inputIndex === candidate.inputIndex)
										?.contentHash ?? null)
								: null,
						requiresBibliographicMatch: candidate.requiresBibliographicMatch,
						queryText: null,
						queryHash: null,
						rank: candidate.entryIndex === null ? null : candidate.entryIndex + 1,
						requestOperationId: operation.operationId,
						abstractRights: "metadata_only",
						accessPolicy: accessPolicySnapshot(
							"local-import",
							RESEARCH_SCHEMA_VERSION,
							retrievedAt,
							"user_authorized_file",
						),
					},
				];
	});
	const committed = await commitSourceCandidates(project.root, operation.operationId, candidates);
	if (!committed.ok) return { result: committed };
	const value: ImportSourcesValue = {
		importedSourceIds: committed.value.createdSourceIds,
		reusedSourceIds: committed.value.reusedSourceIds,
		skippedCandidateIds: committed.value.rejected.map(({ candidateId }) => candidateId),
		conflicts:
			params.dedupe === "exact-and-review-candidates"
				? ([
						...committed.value.possibleDuplicates,
						...committed.value.existingSourceDuplicates,
					] as unknown as JsonValue[])
				: [],
		unmatchedDocuments: imported.value.documentCandidates.map((candidate) => ({
			candidateKey: candidate.candidateKey,
			sourceCandidateKey: candidate.sourceCandidateKey,
			contentHash: candidate.contentHash,
			portable: candidate.portable,
			reason: "BIBLIOGRAPHIC_MATCH_REQUIRED",
		})),
		inputs: imported.value.rawInputs.map((raw) => ({
			inputIndex: raw.inputIndex,
			format: raw.format,
			mode: raw.mode,
			contentHash: raw.contentHash,
			portable: raw.portable,
		})),
		portable: imported.value.rawInputs.every(({ portable }) => portable),
	};
	return {
		result: researchResult(value, operation.operationId, errors, true),
		outputs: committed.value.sourceRefs,
		outputFiles: [...new Map(outputFiles.map((file) => [file.path, file])).values()],
	};
}

async function documentForSource(
	projectRoot: string,
	sourceId: string,
): Promise<ResearchResult<DocumentRecord> | null> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	for (const documentId of await listProjectRecordIds(opened.root, opened.manifest, "document")) {
		const result = await readRecord(opened.root, "document", documentId);
		if (!result.ok || result.value.kind !== "document") throw new TypeError(`Invalid document record: ${documentId}`);
		if (result.value.sourceId === sourceId) return Promise.resolve(successResult(result.value, null));
	}
	return null;
}

async function locateDocument(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	source: SourceRecord,
	aggregateOperationId: string,
	signal: AbortSignal,
): Promise<ResearchResult<DocumentRecord>> {
	const existing = await documentForSource(project.root, source.sourceId);
	if (existing !== null) return existing;
	const adapter = new UnpaywallAdapter(configuredAlias(options.credentialAliases?.unpaywallEmail, "UNPAYWALL_EMAIL"));
	const located = await adapterOperation(
		project,
		ctx,
		adapter,
		"locate",
		[{ kind: "source", id: source.sourceId, revision: source.audit.revision }],
		signal,
		defaultHttpOptions(options),
		(context) => locateSourceDocument(source, adapter, context),
	);
	if (!located.result.ok) return propagatedFailure(located.result, aggregateOperationId);
	const opened = await openProject(project.root);
	if (opened.compatibility !== "current") {
		return thrownFailure(new TypeError("Research project schema is read-only"), aggregateOperationId);
	}
	const recorded = await recordDocumentLocation(project.root, {
		documentId: createOpaqueId("document"),
		sourceId: source.sourceId,
		operationId: aggregateOperationId,
		expectedManifestRevision: opened.manifest.revision,
		location: located.result.value,
	});
	if (!recorded.ok || located.result.errors.length === 0) return recorded;
	return {
		ok: true,
		status: "PARTIAL_SUCCESS",
		value: recorded.value,
		errors: located.result.errors,
		meta: {
			operationId: aggregateOperationId,
			taskId: null,
			warnings: located.result.errors.map(({ message }) => message),
		},
	};
}

async function acquireLocatedDocument(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	source: SourceRecord,
	document: DocumentRecord,
	policy: Static<typeof DocumentsParameters>["acquisitionPolicy"],
	signal: AbortSignal,
): Promise<ResearchResult<typeof document>> {
	if (document.localFile !== null) return successResult(document, null);
	const adapter = new UnpaywallAdapter(configuredAlias(options.credentialAliases?.unpaywallEmail, "UNPAYWALL_EMAIL"));
	const located = await adapterOperation(
		project,
		ctx,
		adapter,
		"locate",
		[{ kind: "source", id: source.sourceId, revision: source.audit.revision }],
		signal,
		defaultHttpOptions(options),
		(context) => locateSourceDocument(source, adapter, context),
	);
	if (!located.result.ok) return propagatedFailure(located.result, located.operationId);
	const candidate = located.result.value.bestLocation;
	if (candidate === null) {
		return withAdditionalErrors(successResult(document, located.operationId), located.result.errors);
	}
	if (candidate.kind !== "direct_pdf") {
		return withAdditionalErrors(
			policy.allowPublisherLandingPageOnly
				? successResult(document, located.operationId)
				: failureResult(
						"PERMISSION_BLOCKED",
						"DOCUMENT_DIRECT_PDF_REQUIRED",
						"permission",
						"Only a publisher landing page was located",
						located.operationId,
					),
			located.result.errors,
		);
	}
	const acquired = (
		await childOperation(
			project,
			ctx,
			{
				operationKind: "adapter",
				name: "document-http.acquire",
				implementationVersion: options.version,
				inputs: [
					{ kind: "source", id: source.sourceId, revision: source.audit.revision },
					{ kind: "document", id: document.documentId, revision: document.audit.revision },
				],
				inputFiles: [candidate.rawRecord],
				adapter: {
					adapterId: "document-http",
					adapterVersion: options.version,
					capabilitySnapshotHash: hashCanonicalJson({ adapterId: "document-http", version: options.version }),
				},
			},
			async (operation) => {
				const result = await acquireDocument(project.root, {
					documentId: document.documentId,
					operationId: operation.operationId,
					sessionId: ctx.sessionManager.getSessionId(),
					expectedDocumentRevision: document.audit.revision,
					candidate,
					allowOpenAccessDownload: policy.allowOpenAccessDownload,
					maxBytesPerFile: policy.maxBytesPerFile,
					expectedContentHash: null,
					requestHttp: (intent) =>
						governedRequest(
							project.root,
							operation.operationId,
							ctx,
							signal,
							intent,
							defaultHttpOptions(options),
						),
				});
				return {
					result,
					outputs: result.ok
						? [{ kind: "document", id: result.value.documentId, revision: result.value.audit.revision }]
						: [],
					outputFiles: result.ok && result.value.localFile !== null ? [result.value.localFile] : [],
				};
			},
		)
	).result;
	return withAdditionalErrors(acquired, located.result.errors);
}

async function parseLocatedDocument(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	source: SourceRecord,
	document: DocumentRecord,
	maxBytes: number,
): Promise<ResearchResult<typeof document>> {
	if (document.fullTextStatus === "parsed" || document.fullTextStatus === "parsed_with_warnings") {
		return successResult(document, null);
	}
	return (
		await childOperation(
			project,
			ctx,
			{
				operationKind: "tool",
				name: "pdf.parse",
				implementationVersion: options.version,
				inputs: [
					{ kind: "source", id: source.sourceId, revision: source.audit.revision },
					{ kind: "document", id: document.documentId, revision: document.audit.revision },
				],
				inputFiles: document.localFile === null ? [] : [document.localFile],
			},
			async (operation) => {
				const result = await parseDocument(project.root, {
					documentId: document.documentId,
					operationId: operation.operationId,
					sessionId: ctx.sessionManager.getSessionId(),
					expectedDocumentRevision: document.audit.revision,
					options: { maxBytes, maxPages: 2_000 },
				});
				return {
					result,
					outputs: result.ok
						? [{ kind: "document", id: result.value.documentId, revision: result.value.audit.revision }]
						: [],
					outputFiles: result.ok && result.value.parsedOutput !== null ? [result.value.parsedOutput] : [],
				};
			},
		)
	).result;
}

interface DocumentsValue {
	action: Static<typeof DocumentsParameters>["action"];
	documents: JsonValue[];
}

export async function documents(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: Static<typeof DocumentsParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<DocumentsValue>> {
	const errors: ResearchError[] = [];
	const values: JsonValue[] = [];
	const outputs: RecordRef[] = [];
	const outputFiles: FileRef[] = [];
	let succeeded = false;
	for (const sourceId of [...new Set(params.sourceIds)]) {
		const source = await sourceRecord(project.root, sourceId, operation.operationId);
		if (!source.ok) {
			errors.push(...source.errors);
			continue;
		}
		let documentResult = await documentForSource(project.root, sourceId);
		if (params.action === "locate" || documentResult === null) {
			documentResult = await locateDocument(project, ctx, options, source.value, operation.operationId, signal);
		}
		if (documentResult === null || !documentResult.ok) {
			if (documentResult !== null) errors.push(...documentResult.errors);
			continue;
		}
		let document = documentResult.value;
		errors.push(...documentResult.errors);
		if (params.action === "acquire") {
			const acquired = await acquireLocatedDocument(
				project,
				ctx,
				options,
				source.value,
				document,
				params.acquisitionPolicy,
				signal,
			);
			if (!acquired.ok) {
				errors.push(...acquired.errors);
				continue;
			}
			document = acquired.value;
			errors.push(...acquired.errors);
		}
		if (params.action === "parse") {
			const parsed = await parseLocatedDocument(
				project,
				ctx,
				options,
				source.value,
				document,
				params.acquisitionPolicy.maxBytesPerFile,
			);
			if (!parsed.ok) {
				errors.push(...parsed.errors);
				continue;
			}
			document = parsed.value;
			errors.push(...parsed.errors);
		}
		if (params.action === "retry_failed" && document.failure?.retryable === true) {
			const retried =
				document.fullTextStatus === "parse_failed"
					? await parseLocatedDocument(
							project,
							ctx,
							options,
							source.value,
							document,
							params.acquisitionPolicy.maxBytesPerFile,
						)
					: await acquireLocatedDocument(
							project,
							ctx,
							options,
							source.value,
							document,
							params.acquisitionPolicy,
							signal,
						);
			if (!retried.ok) {
				errors.push(...retried.errors);
				continue;
			}
			document = retried.value;
			errors.push(...retried.errors);
		}
		succeeded = true;
		outputs.push({ kind: "document", id: document.documentId, revision: document.audit.revision });
		if (document.localFile !== null) outputFiles.push(document.localFile);
		if (document.parsedOutput !== null) outputFiles.push(document.parsedOutput);
		values.push({
			sourceId,
			documentId: document.documentId,
			fullTextStatus: document.fullTextStatus,
			accessStatus: document.acquisition.accessStatus,
			licenseExpression: document.acquisition.licenseExpression,
			localFile: document.localFile,
			pageCount: document.pageCount,
			failure: document.failure,
		});
	}
	return {
		result: researchResult({ action: params.action, documents: values }, operation.operationId, errors, succeeded),
		outputs,
		outputFiles: [...new Map(outputFiles.map((file) => [file.path, file])).values()],
	};
}

async function approveReviewedClaimLink(
	projectRoot: string,
	ctx: ExtensionContext,
	operationId: string,
	claim: ClaimRecord,
	evidenceFingerprintValue: string,
	existingEvidence: EvidenceCard | null,
): Promise<ResearchResult<string>> {
	const evidenceLabel = existingEvidence?.evidenceId ?? `draft ${evidenceFingerprintValue.slice(0, 12)}`;
	if (!ctx.hasUI) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"CLAIM_LINK_APPROVAL_REQUIRED",
			"permission",
			`Claim ${claim.claimId} was human-reviewed and requires interactive approval before adding evidence`,
			operationId,
			{ claimId: claim.claimId, evidenceFingerprint: evidenceFingerprintValue },
		);
	}
	const approved = await ctx.ui.confirm(
		"Update reviewed research claim",
		`Add evidence ${evidenceLabel} to reviewed claim ${claim.claimId}?`,
	);
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") {
		return failureResult(
			"PERMANENT_FAILURE",
			"APPROVAL_PROJECT_READ_ONLY",
			"migration",
			"Research project schema is read-only",
			operationId,
		);
	}
	const now = new Date().toISOString();
	const approvalId = createOpaqueId("approval");
	const actionFingerprint = hashCanonicalJson({
		action: "research.claim.link_evidence",
		claimId: claim.claimId,
		claimRevision: claim.audit.revision,
		evidenceFingerprint: evidenceFingerprintValue,
	}).value;
	const approval: ApprovalRecord = {
		kind: "approval",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		approvalId,
		taskId: null,
		operationId,
		actionClass: "project_overwrite",
		actionName: "research.claim.link_evidence",
		impactScope: [`claim:${claim.claimId}`],
		estimatedCost: null,
		dataEgress: {
			destination: null,
			dataClasses: [],
			fileRefs: [],
			recordRefs: [
				{ kind: "claim", id: claim.claimId, revision: claim.audit.revision },
				...(existingEvidence === null
					? []
					: [
							{
								kind: "evidence" as const,
								id: existingEvidence.evidenceId,
								revision: existingEvidence.audit.revision,
							},
						]),
			],
		},
		overwriteRisk: { paths: [], destructive: false, recoverable: true },
		requestMessage: `Add evidence to reviewed claim ${claim.claimId}`,
		requestedAt: now,
		policySnapshotHash: hashCanonicalJson(opened.manifest.policy),
		decision: approved ? "approved" : "denied",
		scope: "once",
		scopeTarget: {
			projectId: opened.manifest.projectId,
			sessionId: ctx.sessionManager.getSessionId(),
			actionFingerprint,
			destinationPattern: null,
			pathPatterns: [],
			maxApprovedCost: null,
		},
		decidedAt: now,
		decidedBy: "user",
		expiresAt: null,
		note: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const created = await createRecord(projectRoot, approval, {
		expectedManifestRevision: opened.manifest.revision,
		operationId,
	});
	if (!created.ok) return propagatedFailure(created, operationId);
	const linked = await linkApprovalToOperation(projectRoot, operationId, approvalId);
	if (!linked.ok) return propagatedFailure(linked, operationId);
	return approved
		? successResult(approvalId, operationId)
		: failureResult(
				"PERMISSION_BLOCKED",
				"CLAIM_LINK_UPDATE_DENIED",
				"permission",
				`User denied adding evidence to reviewed claim ${claim.claimId}`,
				operationId,
				{ approvalId, claimId: claim.claimId, evidenceFingerprint: evidenceFingerprintValue },
			);
}

interface CommitEvidenceValue {
	claimIds: string[];
	evidenceIds: string[];
	rejected: JsonValue[];
	supportStatuses: JsonValue[];
	evidenceLevels: JsonValue[];
}

export async function commitEvidence(
	project: CurrentProject,
	ctx: ExtensionContext,
	params: Static<typeof CommitEvidenceParameters>,
	operation: OperationRecord,
	toolCallId: string,
): Promise<ToolOutcome<CommitEvidenceValue>> {
	const provenance = modelSemanticProvenance(ctx, toolCallId, params, operation.operationId);
	if (!provenance.ok) return { result: provenance };
	const errors: ResearchError[] = [];
	const rejected: JsonValue[] = [];
	const claimIds: string[] = [];
	const evidenceIds: string[] = [];
	const supportStatuses = new Map<string, ClaimRecord["supportStatus"]>();
	const evidenceLevels: JsonValue[] = [];
	const outputs: RecordRef[] = [];

	for (const [index, draft] of params.claims.entries()) {
		const evidenceRefs: RecordRef[] = [];
		for (const evidenceId of [
			...draft.evidenceLinks.map(({ evidenceId }) => evidenceId),
			...draft.conflictEvidenceIds,
		]) {
			const evidence = await readRecord(project.root, "evidence", evidenceId);
			if (evidence.ok && evidence.value.kind === "evidence") {
				evidenceRefs.push({ kind: "evidence", id: evidenceId, revision: evidence.value.audit.revision });
			}
		}
		const inputUpdate = await addOperationInputs(project.root, operation.operationId, evidenceRefs, []);
		if (!inputUpdate.ok) return { result: inputUpdate };
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const committed = await commitClaim(project.root, {
			operationId: operation.operationId,
			expectedManifestRevision: opened.manifest.revision,
			draft: draft as ClaimDraft,
			semanticProvenance: provenance.value,
		});
		if (!committed.ok) {
			errors.push(...committed.errors);
			rejected.push({ kind: "claim", index, errors: committed.errors });
			continue;
		}
		claimIds.push(committed.value.claimId);
		supportStatuses.set(committed.value.claimId, committed.value.supportStatus);
		outputs.push({ kind: "claim", id: committed.value.claimId, revision: committed.value.audit.revision });
	}

	for (const [index, draft] of params.evidenceCards.entries()) {
		const source = await readRecord(project.root, "source", draft.sourceId);
		if (!source.ok || source.value.kind !== "source") {
			const failure = source.ok
				? failureResult(
						"PERMANENT_FAILURE",
						"EVIDENCE_SOURCE_INVALID",
						"integrity",
						`Record ${draft.sourceId} is not a source`,
						operation.operationId,
					)
				: source;
			errors.push(...failure.errors);
			rejected.push({ kind: "evidence", index, errors: failure.errors });
			continue;
		}
		const inputs: RecordRef[] = [
			{ kind: "source", id: source.value.sourceId, revision: source.value.audit.revision },
		];
		const inputFiles: FileRef[] = [];
		const linkedClaims = new Map<string, ClaimRecord>();
		if (draft.documentId !== null) {
			const document = await readRecord(project.root, "document", draft.documentId);
			if (!document.ok || document.value.kind !== "document") {
				const failure = document.ok
					? failureResult(
							"PERMANENT_FAILURE",
							"EVIDENCE_DOCUMENT_INVALID",
							"integrity",
							`Record ${draft.documentId} is not a document`,
							operation.operationId,
						)
					: document;
				errors.push(...failure.errors);
				rejected.push({ kind: "evidence", index, errors: failure.errors });
				continue;
			}
			inputs.push({ kind: "document", id: document.value.documentId, revision: document.value.audit.revision });
			if (document.value.localFile !== null) inputFiles.push(document.value.localFile);
			if (document.value.parsedOutput !== null) inputFiles.push(document.value.parsedOutput);
		}
		for (const { claimId } of draft.claimLinks) {
			const claim = await readRecord(project.root, "claim", claimId);
			if (claim.ok && claim.value.kind === "claim") {
				linkedClaims.set(claimId, claim.value);
				inputs.push({ kind: "claim", id: claimId, revision: claim.value.audit.revision });
			}
		}
		const inputUpdate = await addOperationInputs(project.root, operation.operationId, inputs, inputFiles);
		if (!inputUpdate.ok) return { result: inputUpdate };
		const evidenceDraft: EvidenceCardDraft = draft;
		const validated = await validateEvidenceCardDraft(
			project.root,
			evidenceDraft,
			operation.operationId,
			provenance.value,
		);
		if (!validated.ok) {
			errors.push(...validated.errors);
			rejected.push({ kind: "evidence", index, errors: validated.errors });
			continue;
		}
		const fingerprint = evidenceFingerprint(validated.value.card).value;
		const existing = await findActiveEvidenceCardByFingerprint(project.root, fingerprint, operation.operationId);
		if (!existing.ok) return { result: existing };
		const approvedReviewedClaims = new Set<string>();
		let approvalBlocked = false;
		for (const link of draft.claimLinks) {
			const claim = linkedClaims.get(link.claimId);
			if (claim === undefined || claim.humanConfirmation.status === "not_reviewed") continue;
			const existingEvidenceId = existing.value?.evidenceId;
			const storedLink =
				existingEvidenceId === undefined
					? undefined
					: claim.evidenceLinks.find(({ evidenceId }) => evidenceId === existingEvidenceId);
			const alreadyLinked =
				storedLink?.relation === link.relation &&
				storedLink.assessment === link.rationale &&
				(link.relation !== "refutes" || claim.conflictEvidenceIds.includes(existingEvidenceId ?? ""));
			if (alreadyLinked) continue;
			const approval = await approveReviewedClaimLink(
				project.root,
				ctx,
				operation.operationId,
				claim,
				fingerprint,
				existing.value,
			);
			if (!approval.ok) {
				errors.push(...approval.errors);
				rejected.push({
					kind: "evidence",
					index,
					claimId: link.claimId,
					errors: approval.errors,
				});
				approvalBlocked = true;
				break;
			}
			approvedReviewedClaims.add(link.claimId);
		}
		if (approvalBlocked) continue;
		const beforeCommit = await openProject(project.root);
		if (beforeCommit.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const committed = await commitEvidenceCard(project.root, {
			operationId: operation.operationId,
			expectedManifestRevision: beforeCommit.manifest.revision,
			validationMode: params.validationMode,
			draft: evidenceDraft,
			semanticProvenance: provenance.value,
		});
		if (!committed.ok) {
			errors.push(...committed.errors);
			rejected.push({ kind: "evidence", index, errors: committed.errors });
			continue;
		}
		evidenceIds.push(committed.value.evidenceId);
		evidenceLevels.push({ evidenceId: committed.value.evidenceId, evidenceLevel: committed.value.evidenceLevel });
		outputs.push({ kind: "evidence", id: committed.value.evidenceId, revision: committed.value.audit.revision });
		for (const link of committed.value.claimLinks) {
			const linked = await linkEvidenceToClaim(
				project.root,
				operation.operationId,
				link.claimId,
				committed.value,
				link.relation,
				link.rationale,
				approvedReviewedClaims.has(link.claimId),
				provenance.value,
			);
			if (!linked.ok) {
				errors.push(...linked.errors);
				rejected.push({
					kind: "claim_link",
					claimId: link.claimId,
					evidenceId: committed.value.evidenceId,
					errors: linked.errors,
				});
				continue;
			}
			supportStatuses.set(linked.value.claimId, linked.value.supportStatus);
			outputs.push({ kind: "claim", id: linked.value.claimId, revision: linked.value.audit.revision });
		}
	}

	const value: CommitEvidenceValue = {
		claimIds: [...new Set(claimIds)],
		evidenceIds: [...new Set(evidenceIds)],
		rejected,
		supportStatuses: [...supportStatuses].map(([claimId, supportStatus]) => ({ claimId, supportStatus })),
		evidenceLevels,
	};
	return {
		result: researchResult(value, operation.operationId, errors, outputs.length > 0),
		outputs: [...new Map(outputs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()],
	};
}

async function cachedCitation(
	project: CurrentProject,
	source: SourceRecord,
	providers: readonly ("crossref" | "openalex")[],
): Promise<CitationVerification | null> {
	const expectedProviders = [...new Set(providers)].sort().join(",");
	for (const verificationId of await listProjectRecordIds(project.root, project.manifest, "citation_verification")) {
		const result = await readRecord(project.root, "citation_verification", verificationId);
		if (!result.ok || result.value.kind !== "citation_verification") {
			throw new TypeError(`Invalid citation verification record: ${verificationId}`);
		}
		const verification = result.value;
		if (
			verification.sourceId !== source.sourceId ||
			verification.expiresAt === null ||
			Date.parse(verification.expiresAt) <= Date.now() ||
			verification.finalStatus === "service_unavailable" ||
			verification.finalStatus === "incomplete" ||
			[...new Set(verification.verificationSources.map(({ adapterId }) => adapterId))].sort().join(",") !==
				expectedProviders
		) {
			continue;
		}
		const creator = await readRecord(project.root, "operation", verification.audit.createdByOperationId);
		if (
			creator.ok &&
			creator.value.kind === "operation" &&
			creator.value.implementationVersion === CITATION_VERIFIER_VERSION &&
			creator.value.inputs.some(
				(input) =>
					input.kind === "source" && input.id === source.sourceId && input.revision === source.audit.revision,
			)
		) {
			return verification;
		}
	}
	return null;
}

interface VerifyCitationsValue {
	verifications: JsonValue[];
	cachedVerificationIds: string[];
}

export async function verifyCitations(
	project: CurrentProject,
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	params: Static<typeof VerifyCitationsParameters>,
	operation: OperationRecord,
	signal: AbortSignal,
): Promise<ToolOutcome<VerifyCitationsValue>> {
	const errors: ResearchError[] = [];
	const verifications: JsonValue[] = [];
	const cachedVerificationIds: string[] = [];
	const outputs: RecordRef[] = [];
	for (const sourceId of [...new Set(params.sourceIds)]) {
		const source = await sourceRecord(project.root, sourceId, operation.operationId);
		if (!source.ok) {
			errors.push(...source.errors);
			continue;
		}
		if (params.refresh === "use-cache") {
			const cached = await cachedCitation(project, source.value, params.providers);
			if (cached !== null) {
				cachedVerificationIds.push(cached.verificationId);
				outputs.push({
					kind: "citation_verification",
					id: cached.verificationId,
					revision: cached.audit.revision,
				});
				verifications.push({
					sourceId,
					verificationId: cached.verificationId,
					finalStatus: cached.finalStatus,
					publicationStatus: cached.publicationStatus,
					cached: true,
				});
				continue;
			}
		}
		const providerRuns: CitationAdapterRun[] = [];
		for (const provider of [...new Set(params.providers)]) {
			const adapter = sourceAdapter(provider, options);
			const identifier =
				provider === "crossref"
					? source.value.identifiers.find(({ scheme }) => scheme === "doi")
					: (source.value.identifiers.find(({ scheme }) => scheme === "doi") ??
						source.value.identifiers.find(({ scheme }) => scheme === "openalex"));
			const lookup = await adapterOperation<JsonValue>(
				project,
				ctx,
				adapter,
				"lookup",
				[{ kind: "source", id: sourceId, revision: source.value.audit.revision }],
				signal,
				defaultHttpOptions(options),
				(context) =>
					identifier === undefined
						? Promise.resolve(
								failureResult<JsonValue>(
									"PERMANENT_FAILURE",
									"CITATION_IDENTIFIER_REQUIRED",
									"validation",
									`${provider} cannot verify this source without a supported identifier`,
									context.operationId,
								),
							)
						: adapter.lookup(identifier, context),
			);
			providerRuns.push({ check: "lookup", operationId: lookup.operationId, result: lookup.result });
			errors.push(...lookup.result.errors);
			if (provider === "crossref") {
				const status = await adapterOperation<JsonValue>(
					project,
					ctx,
					adapter,
					"publication-status",
					[{ kind: "source", id: sourceId, revision: source.value.audit.revision }],
					signal,
					defaultHttpOptions(options),
					(context) =>
						identifier === undefined
							? Promise.resolve(
									failureResult<JsonValue>(
										"PERMANENT_FAILURE",
										"CITATION_IDENTIFIER_REQUIRED",
										"validation",
										"Crossref publication status requires a DOI",
										context.operationId,
									),
								)
							: (adapter as CrossrefAdapter).statusRelations(identifier, context),
				);
				providerRuns.push({
					check: "publication_status",
					operationId: status.operationId,
					result: status.result,
				});
				errors.push(...status.result.errors);
			}
		}
		const opened = await openProject(project.root);
		if (opened.compatibility !== "current") {
			return { result: thrownFailure(new TypeError("Research project schema is read-only"), operation.operationId) };
		}
		const verified = await verifyCitation(project.root, {
			sourceId,
			citationKey: null,
			providerRuns,
			refresh: params.refresh,
			matchThresholds: params.matchThresholds,
			operationId: operation.operationId,
			expectedManifestRevision: opened.manifest.revision,
		});
		if (!verified.ok) {
			errors.push(...verified.errors);
			continue;
		}
		outputs.push({
			kind: "citation_verification",
			id: verified.value.verificationId,
			revision: verified.value.audit.revision,
		});
		verifications.push({
			sourceId,
			verificationId: verified.value.verificationId,
			finalStatus: verified.value.finalStatus,
			publicationStatus: verified.value.publicationStatus,
			fieldChecks: verified.value.fieldChecks,
			conflicts: verified.value.conflicts,
			cached: false,
		});
	}
	return {
		result: researchResult(
			{ verifications, cachedVerificationIds },
			operation.operationId,
			errors,
			verifications.length > 0,
		),
		outputs,
	};
}

export async function sourceInputs(projectRoot: string, sourceIds: readonly string[]): Promise<RecordRef[]> {
	const inputs: RecordRef[] = [];
	for (const sourceId of [...new Set(sourceIds)]) {
		const result = await readRecord(projectRoot, "source", sourceId);
		if (result.ok && result.value.kind === "source") {
			inputs.push({ kind: "source", id: sourceId, revision: result.value.audit.revision });
		}
	}
	return inputs;
}
