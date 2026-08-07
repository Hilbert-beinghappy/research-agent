import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import {
	JsonResearchResultSchema,
	PersistedRecordSchema,
	ProjectBackupManifestSchema,
	ProjectCatalogSchema,
	RESEARCH_SCHEMA_VERSION,
	type ResearchResult,
} from "../../src/contracts/schemas.ts";
import { validateJsonResearchResult, validatePersistedRecord } from "../../src/contracts/validators.ts";

const timestamp = "2026-08-06T00:00:00.000Z";
const hash = { algorithm: "sha256", value: "a".repeat(64) } as const;
const money = { amount: 0, currency: "USD" };
const file = (path: string, mediaType = "application/json") => ({ path, hash, mediaType, bytes: 1 });
const audit = {
	createdAt: timestamp,
	updatedAt: timestamp,
	revision: 0,
	createdByOperationId: "op_1",
	updatedByOperationId: "op_1",
};
const error = {
	code: "TEST_FAILURE",
	category: "runtime",
	message: "test failure",
	retryable: false,
	source: "contracts.test",
	operationId: "op_1",
	taskId: "task_1",
	details: null,
	occurredAt: timestamp,
	causeCode: null,
};

const manifest = {
	kind: "research_project_manifest",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	projectId: "project_1",
	title: "Algorithmic transparency in public administration",
	domain: {
		id: "public-administration",
		label: "Public Administration",
		templatePackage: null,
		templateVersion: null,
	},
	researchQuestions: [
		{
			id: "rq_1",
			text: "How does transparency affect trust?",
			status: "draft",
			rationale: null,
			confirmedAt: null,
			confirmedBy: null,
		},
	],
	currentStage: "topic_exploration",
	projectStatus: "active",
	policy: {
		sensitivity: "public",
		defaultNetworkDecision: "allow",
		modelEgressAllowed: true,
		allowedModelProviders: [],
		allowedDataClassesForModelEgress: [],
		budgetHardLimit: null,
		actionRules: [],
		unknownThirdPartyCode: "deny",
		retainRawProviderPayloads: true,
		rawPayloadRetentionDays: null,
	},
	directories: {
		sources: ".research/records/sources",
		documents: ".research/records/documents",
		parsed: ".research/parsed",
		evidence: ".research/records/evidence",
		claims: ".research/records/claims",
		verifications: ".research/records/verifications",
		tasks: ".research/records/tasks",
		runs: ".research/records/runs",
		artifacts: ".research/records/artifacts",
		approvals: ".research/records/approvals",
		migrations: ".research/migrations",
		transactions: ".research/transactions",
	},
	recordSets: [],
	activeTaskIds: [],
	lastCommittedOperationId: null,
	lastSessionLink: null,
	createdAt: timestamp,
	updatedAt: timestamp,
	revision: 0,
};

const source = {
	kind: "source",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	sourceId: "src_1",
	identifiers: [
		{ scheme: "doi", value: "10.1/example", normalizedValue: "10.1/example", verified: false, verificationId: null },
	],
	title: "Public algorithms",
	titleNormalized: "public algorithms",
	contributors: [{ family: "Li", given: "Ming", literal: null, orcid: null }],
	issuedDate: null,
	containerTitle: null,
	publisher: null,
	sourceType: "journal-article",
	language: "en",
	abstractText: null,
	abstractRights: "metadata_only",
	discovery: [
		{
			adapterId: "crossref",
			adapterVersion: "1.0.0",
			queryText: "public algorithms",
			queryHash: hash,
			discoveredAt: timestamp,
			rank: 1,
			rawRecord: file(".research/raw/crossref/1.json"),
			requestOperationId: "op_1",
		},
	],
	dedupKeys: {
		doi: "10.1/example",
		strongIdentifier: "doi:10.1/example",
		normalizedTitleYearFirstAuthor: null,
		contentHash: null,
	},
	duplicateStatus: "canonical",
	canonicalSourceId: null,
	metadataConflicts: [],
	publicationStatus: "normal",
	audit,
};

const document = {
	kind: "document",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	documentId: "doc_1",
	sourceId: "src_1",
	acquisition: {
		method: "local_import",
		adapterId: null,
		origin: null,
		accessStatus: "unknown",
		licenseExpression: null,
		termsReference: null,
		acquiredAt: null,
		approvalId: null,
	},
	localFile: null,
	originalFileName: null,
	immutableOriginal: false,
	fullTextStatus: "not_requested",
	textLayer: "unknown",
	parser: null,
	parsedOutput: null,
	pageCount: null,
	parsedAt: null,
	warnings: [],
	failure: null,
	audit,
};

const evidence = {
	kind: "evidence",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	evidenceId: "ev_1",
	sourceId: "src_1",
	documentId: null,
	evidenceLevel: "abstract",
	locator: null,
	excerpt: null,
	excerptExactMatch: null,
	paraphrase: "The abstract reports a relationship.",
	evidenceStatement: "Abstract-level evidence only.",
	claimLinks: [],
	extraction: {
		method: "human_entered",
		operationId: "op_1",
		modelProvider: null,
		modelId: null,
		promptHash: null,
	},
	confidence: { level: "medium", basis: "abstract available", limitations: ["full text unavailable"] },
	rights: { excerptAllowed: null, maxStoredWords: null, publicExportAllowed: null },
	humanStatus: "not_reviewed",
	validity: "active",
	supersedesEvidenceId: null,
	audit,
};

const claim = {
	kind: "claim",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	claimId: "clm_1",
	text: "Transparency may affect trust.",
	claimType: "theoretical",
	scope: "literature review",
	evidenceLinks: [],
	supportStatus: "unassessed",
	conflictEvidenceIds: [],
	humanConfirmation: { status: "not_reviewed", decidedAt: null, note: null },
	publishability: "blocked",
	audit,
};

const citation = {
	kind: "citation_verification",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	verificationId: "ver_1",
	sourceId: "src_1",
	citationKey: null,
	identifiers: [],
	verificationSources: [],
	fieldChecks: [],
	publicationStatus: "unknown",
	conflicts: [],
	finalStatus: "incomplete",
	verifiedAt: timestamp,
	expiresAt: null,
	audit,
};

const task = {
	kind: "task",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	taskId: "task_1",
	taskType: "literature_search",
	title: "Search literature",
	inputs: [],
	inputFiles: [],
	expectedOutputs: ["source records"],
	outputs: [],
	outputFiles: [],
	dependencyTaskIds: [],
	status: "planned",
	attemptCount: 0,
	maxAttempts: 3,
	idempotencyKey: "search:1",
	operationIds: [],
	errors: [],
	resumeCursor: null,
	budget: { estimated: null, actual: money },
	createdAt: timestamp,
	startedAt: null,
	finishedAt: null,
	updatedAt: timestamp,
	revision: 0,
};

const operation = {
	kind: "operation",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	operationId: "op_1",
	taskId: "task_1",
	operationKind: "tool",
	name: "research_init",
	implementationVersion: "0.1.0",
	status: "planned",
	session: null,
	actor: { type: "tool", id: "research_init" },
	modelExecution: null,
	adapterExecution: null,
	inputs: [],
	inputFiles: [],
	outputs: [],
	outputFiles: [],
	rawRequest: null,
	rawResponse: null,
	approvalIds: [],
	usage: {
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
		networkRequests: 0,
		cost: money,
	},
	error: null,
	startedAt: null,
	finishedAt: null,
	audit,
};

const analysis = {
	kind: "analysis_run",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	analysisRunId: "run_1",
	analysisSpecificationId: "spec_1",
	taskId: "task_1",
	runtime: {
		kind: "python",
		adapterId: "python-local",
		adapterVersion: "0.1.0",
		executable: "python",
		runtimeVersion: "3.12",
		platform: "darwin-arm64",
	},
	script: file("scripts/analysis.py", "text/x-python"),
	environment: { lockFile: null, packageSnapshot: null, containerImage: null, environmentHash: hash },
	inputs: [],
	inputRecordRefs: [],
	parameters: null,
	randomSeed: null,
	commandArguments: [],
	workingDirectory: ".research/runs/run_1",
	inputIntegrity: [],
	outputs: [],
	logs: [],
	status: "planned",
	exitCode: null,
	deterministicClaim: "not_claimed",
	startedAt: null,
	finishedAt: null,
	failure: null,
	audit,
};

const artifact = {
	kind: "artifact",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	artifactId: "art_1",
	artifactKind: "markdown",
	title: "Literature review",
	sourceRecords: [],
	sourceFiles: [],
	outputFile: file("artifacts/review.md", "text/markdown"),
	generator: { id: "markdown", version: "0.1.0", operationId: "op_1", templateId: null, templateVersion: null },
	inputAggregateHash: hash,
	validation: { status: "not_checked", checks: [] },
	publishability: "blocked",
	supersedesArtifactId: null,
	audit,
};

const approval = {
	kind: "approval",
	schemaVersion: RESEARCH_SCHEMA_VERSION,
	approvalId: "approval_1",
	taskId: "task_1",
	operationId: "op_1",
	actionClass: "public_network_read",
	actionName: "crossref.search",
	impactScope: ["api.crossref.org"],
	estimatedCost: null,
	dataEgress: { destination: "api.crossref.org", dataClasses: ["query"], fileRefs: [], recordRefs: [] },
	overwriteRisk: { paths: [], destructive: false, recoverable: true },
	requestMessage: "Allow Crossref search?",
	requestedAt: timestamp,
	policySnapshotHash: hash,
	decision: "approved",
	scope: "once",
	scopeTarget: {
		projectId: "project_1",
		sessionId: null,
		actionFingerprint: "crossref.search:1",
		destinationPattern: "api.crossref.org",
		pathPatterns: [],
		maxApprovedCost: null,
	},
	decidedAt: timestamp,
	decidedBy: "user",
	expiresAt: null,
	note: null,
	audit,
};

const validRecords = [
	manifest,
	source,
	document,
	evidence,
	claim,
	citation,
	task,
	operation,
	analysis,
	artifact,
	approval,
];

function expectIssue(value: unknown, code: string): void {
	const result = validatePersistedRecord(value);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.issues.map((entry) => entry.code)).toContain(code);
}

describe("v1.1 persisted contracts", () => {
	it.each(validRecords.map((record) => [record.kind, record]))("validates %s", (_kind, record) => {
		expect(validatePersistedRecord(record)).toMatchObject({ ok: true, value: record, issues: [] });
	});

	it("preserves unknown fields but rejects missing fields, undefined values, and unknown status", () => {
		const futureSource = structuredClone(source) as typeof source & { futureField: { value: string } };
		futureSource.futureField = { value: "keep" };
		const futureResult = validatePersistedRecord(futureSource);
		expect(futureResult).toMatchObject({ ok: true });
		if (futureResult.ok) expect((futureResult.value as typeof futureSource).futureField).toEqual({ value: "keep" });

		const missing = structuredClone(source) as Record<string, unknown>;
		delete missing.title;
		expect(validatePersistedRecord(missing)).toMatchObject({ ok: false });
		expect(validatePersistedRecord({ ...structuredClone(source), title: null })).toMatchObject({ ok: false });

		const undefinedValue = structuredClone(source) as Record<string, unknown>;
		undefinedValue.abstractText = undefined;
		expectIssue(undefinedValue, "json.non_canonical_value");

		const unknownStatus = structuredClone(source) as Record<string, unknown>;
		unknownStatus.publicationStatus = "trusted";
		expect(validatePersistedRecord(unknownStatus)).toMatchObject({ ok: false });

		const retiredQuestion = {
			...structuredClone(manifest),
			researchQuestions: [
				{
					...manifest.researchQuestions[0],
					status: "retired",
					confirmedAt: timestamp,
					confirmedBy: "user",
				},
			],
		};
		expect(validatePersistedRecord(retiredQuestion)).toMatchObject({ ok: true });

		const failedIdentifierCheck = {
			...structuredClone(source),
			identifiers: [{ ...source.identifiers[0], verified: false, verificationId: "ver_failed" }],
		};
		expect(validatePersistedRecord(failedIdentifierCheck)).toMatchObject({ ok: true });

		const absoluteRawRecord = structuredClone(source);
		absoluteRawRecord.discovery[0].rawRecord.path = "/tmp/crossref.json";
		expect(validatePersistedRecord(absoluteRawRecord)).toMatchObject({ ok: false });
	});

	it.each([
		[
			"manifest duplicate record sets",
			() => ({
				...structuredClone(manifest),
				recordSets: [
					{ kind: "source", storage: "json", path: "a", count: 0, contentHash: null },
					{ kind: "source", storage: "json", path: "b", count: 0, contentHash: null },
				],
			}),
			"manifest.duplicate_record_set",
		],
		[
			"source alias without canonical ID",
			() => ({ ...structuredClone(source), duplicateStatus: "merged_alias", canonicalSourceId: null }),
			"source.alias_without_canonical",
		],
		[
			"parsed document without outputs",
			() => ({ ...structuredClone(document), fullTextStatus: "parsed", textLayer: "present" }),
			"document.parsed_output_incomplete",
		],
		[
			"located evidence without locator",
			() => ({ ...structuredClone(evidence), evidenceLevel: "fulltext_located" }),
			"evidence.locator_missing",
		],
		[
			"unlocated full text without document",
			() => ({ ...structuredClone(evidence), evidenceLevel: "fulltext_unlocated" }),
			"evidence.unlocated_document_missing",
		],
		[
			"stored excerpt without exact verification",
			() => ({ ...structuredClone(evidence), excerpt: "unverified excerpt", excerptExactMatch: false }),
			"evidence.stored_excerpt_unverified",
		],
		[
			"supported claim without evidence",
			() => ({ ...structuredClone(claim), supportStatus: "supported" }),
			"claim.support_without_evidence",
		],
		[
			"verified citation without source",
			() => ({ ...structuredClone(citation), finalStatus: "verified" }),
			"citation.verified_without_source",
		],
		["task over attempt limit", () => ({ ...structuredClone(task), attemptCount: 4 }), "task.attempt_limit_exceeded"],
		[
			"successful operation without output revision",
			() => ({
				...structuredClone(operation),
				status: "succeeded",
				startedAt: timestamp,
				finishedAt: timestamp,
				outputs: [{ kind: "source", id: "src_1", revision: null }],
			}),
			"operation.output_integrity_missing",
		],
		[
			"successful analysis with nonzero exit",
			() => ({
				...structuredClone(analysis),
				status: "succeeded",
				exitCode: 1,
				startedAt: timestamp,
				finishedAt: timestamp,
			}),
			"analysis.success_metadata_invalid",
		],
		[
			"submission artifact without passed checks",
			() => ({ ...structuredClone(artifact), publishability: "submission_candidate" }),
			"artifact.submission_gate_failed",
		],
		[
			"once approval without operation",
			() => ({ ...structuredClone(approval), operationId: null }),
			"approval.once_without_operation",
		],
	] as const)("rejects %s", (_name, createInvalid, code) => {
		expectIssue(createInvalid(), code);
	});

	it("validates unified result status semantics", () => {
		const meta = { operationId: "op_1", taskId: "task_1", warnings: [] };
		const success: ResearchResult<{ count: number }> = {
			ok: true,
			status: "SUCCESS",
			value: { count: 1 },
			errors: [],
			meta,
		};
		expect(validateJsonResearchResult(success).ok).toBe(true);
		expect(
			validateJsonResearchResult({ ok: true, status: "PARTIAL_SUCCESS", value: [], errors: [error], meta }).ok,
		).toBe(true);
		expect(validateJsonResearchResult({ ok: true, status: "PARTIAL_SUCCESS", value: [], errors: [], meta }).ok).toBe(
			false,
		);
		expect(
			validateJsonResearchResult({ ok: false, status: "PERMANENT_FAILURE", value: null, errors: [], meta }).ok,
		).toBe(false);
		expect(
			validateJsonResearchResult({ ok: false, status: "PERMANENT_FAILURE", value: {}, errors: [error], meta }).ok,
		).toBe(false);
	});

	it("serializes canonical JSON and rejects non-JSON values", () => {
		expect(canonicalStringify({ z: 1, a: { d: 2, c: [3, 2, 1] }, negativeZero: -0 })).toBe(
			'{"a":{"c":[3,2,1],"d":2},"negativeZero":0,"z":1}',
		);
		expect(() => canonicalStringify({ value: Number.NaN })).toThrow("non-finite");
		expect(() => canonicalStringify({ value: undefined })).toThrow("non-JSON");
		expect(() => canonicalStringify({ [Symbol("hidden")]: true })).toThrow("symbol key");
	});

	it("keeps committed JSON schemas generated from TypeBox", async () => {
		const schemaDir = fileURLToPath(new URL("../../schemas/v1.1/", import.meta.url));
		const persisted = JSON.parse(await readFile(`${schemaDir}persisted-record.schema.json`, "utf8"));
		const result = JSON.parse(await readFile(`${schemaDir}research-result.schema.json`, "utf8"));
		const catalog = JSON.parse(await readFile(`${schemaDir}project-catalog.schema.json`, "utf8"));
		const backup = JSON.parse(await readFile(`${schemaDir}project-backup.schema.json`, "utf8"));
		const jsonSchema = "https://json-schema.org/draft/2020-12/schema";

		expect(persisted).toEqual(
			JSON.parse(
				JSON.stringify({
					$schema: jsonSchema,
					title: "Pi Research Agent persisted record v1.1",
					...PersistedRecordSchema,
				}),
			),
		);
		expect(result).toEqual(
			JSON.parse(
				JSON.stringify({
					$schema: jsonSchema,
					title: "Pi Research Agent result v1.1",
					...JsonResearchResultSchema,
				}),
			),
		);
		expect(catalog).toEqual(
			JSON.parse(
				JSON.stringify({
					$schema: jsonSchema,
					title: "Pi Research Agent project catalog v1.1",
					...ProjectCatalogSchema,
				}),
			),
		);
		expect(backup).toEqual(
			JSON.parse(
				JSON.stringify({
					$schema: jsonSchema,
					title: "Pi Research Agent project backup v1.1",
					...ProjectBackupManifestSchema,
				}),
			),
		);

		const legacyDir = fileURLToPath(new URL("../../schemas/v0.1/", import.meta.url));
		await expect(readFile(`${legacyDir}persisted-record.schema.json`, "utf8")).resolves.toContain(
			'"title": "Pi Research Agent persisted record v0.1"',
		);
		for (const version of ["0.2", "0.3", "0.4", "0.5", "1.0"]) {
			const previousDir = fileURLToPath(new URL(`../../schemas/v${version}/`, import.meta.url));
			await expect(readFile(`${previousDir}persisted-record.schema.json`, "utf8")).resolves.toContain(
				`"title": "Pi Research Agent persisted record v${version}"`,
			);
		}
	});
});
