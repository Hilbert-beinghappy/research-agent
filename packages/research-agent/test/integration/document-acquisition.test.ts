import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecordedHttpTransport, type HttpTransport } from "../../src/adapters/http/transport.ts";
import type {
	DocumentRecord,
	FileRef,
	HashValue,
	OperationRecord,
	ResearchProjectManifest,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import { fetchDocumentOriginal } from "../../src/documents/fetch.ts";
import {
	type DocumentLocationCandidate,
	type DocumentLocationResult,
	normalizeUnpaywallLocations,
} from "../../src/documents/locate.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson, hashFile } from "../../src/kernel/integrity.ts";
import { operationTransitionPatch } from "../../src/kernel/operations.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";
import { requestGovernedHttp } from "../../src/security/broker-http.ts";
import { acquireDocument, recordDocumentLocation } from "../../src/tools/documents.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "fixtures", "documents");
const timestamp = "2026-08-06T00:00:00.000Z";
const rawHash = { algorithm: "sha256", value: "a".repeat(64) } as const;

let temporaryDirectory: string;
let projectRoot: string;
let sourceId: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-document-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Document acquisition" });
	const operationId = await createRunningOperation("document.fixture.setup");
	sourceId = createOpaqueId("source");
	const manifest = await currentManifest();
	const created = await createRecord(projectRoot, sourceRecord(sourceId, operationId), {
		expectedManifestRevision: manifest.revision,
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function currentManifest(): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	return opened.manifest;
}

function operationRecord(operationId: string, name: string): OperationRecord {
	const now = new Date().toISOString();
	return {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId,
		taskId: null,
		operationKind: "tool",
		name,
		implementationVersion: "0.1.0",
		status: "planned",
		session: null,
		actor: { type: "tool", id: "research.documents" },
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
			cost: { amount: 0, currency: "USD" },
		},
		error: null,
		startedAt: null,
		finishedAt: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

async function createRunningOperation(name: string): Promise<string> {
	const operationId = createOpaqueId("operation");
	let manifest = await currentManifest();
	const created = await createRecord(projectRoot, operationRecord(operationId, name), {
		expectedManifestRevision: manifest.revision,
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	manifest = await currentManifest();
	const record = await readRecord(projectRoot, "operation", operationId);
	if (!record.ok || record.value.kind !== "operation") throw new Error("expected operation");
	const updated = await updateRecord(projectRoot, "operation", operationId, {
		expectedManifestRevision: manifest.revision,
		expectedRecordRevision: record.value.audit.revision,
		operationId,
		changes: operationTransitionPatch(record.value, "running"),
	});
	if (!updated.ok) throw new Error(updated.errors[0].message);
	return operationId;
}

function sourceRecord(id: string, operationId: string): SourceRecord {
	return {
		kind: "source",
		schemaVersion: "0.1.0",
		sourceId: id,
		identifiers: [
			{
				scheme: "doi",
				value: "10.5555/document.1",
				normalizedValue: "10.5555/document.1",
				verified: false,
				verificationId: null,
			},
		],
		title: "Synthetic document acquisition",
		titleNormalized: "synthetic document acquisition",
		contributors: [{ family: "Li", given: "Ming", literal: null, orcid: null }],
		issuedDate: "2024",
		containerTitle: "Synthetic Governance",
		publisher: null,
		sourceType: "journal-article",
		language: "en",
		abstractText: null,
		abstractRights: "metadata_only",
		discovery: [
			{
				adapterId: "fixture",
				adapterVersion: "0.1.0",
				queryText: null,
				queryHash: null,
				discoveredAt: timestamp,
				rank: null,
				rawRecord: rawFile(".research/runs/fixture/source.json"),
				requestOperationId: operationId,
			},
		],
		dedupKeys: {
			doi: "10.5555/document.1",
			strongIdentifier: "doi:10.5555/document.1",
			normalizedTitleYearFirstAuthor: "synthetic document acquisition|2024|li",
			contentHash: null,
		},
		duplicateStatus: "canonical",
		canonicalSourceId: null,
		metadataConflicts: [],
		publicationStatus: "unknown",
		audit: {
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

function rawFile(path: string): FileRef {
	return { path, hash: rawHash, mediaType: "application/json", bytes: 1 };
}

function candidate(url: string, overrides: Partial<DocumentLocationCandidate> = {}): DocumentLocationCandidate {
	return {
		sourceId,
		adapterId: "unpaywall",
		url,
		kind: "direct_pdf",
		accessStatus: "open_access",
		hostType: "repository",
		version: "acceptedVersion",
		licenseExpression: null,
		licenseStatus: "unknown",
		isBest: true,
		rawRecord: rawFile(".research/runs/fixture/unpaywall.json"),
		...overrides,
	};
}

function locationResult(value: DocumentLocationCandidate): DocumentLocationResult {
	return {
		sourceId,
		adapterId: "unpaywall",
		accessStatus: value.accessStatus,
		fullTextStatus:
			value.accessStatus === "paywalled"
				? "paywall_blocked"
				: value.accessStatus === "authentication_required"
					? "authentication_blocked"
					: "located",
		locations: [value],
		bestLocation: value,
		rawResponse: value.rawRecord,
	};
}

async function createLocatedDocument(value: DocumentLocationCandidate): Promise<DocumentRecord> {
	const operationId = await createRunningOperation("document.fixture.locate");
	const documentId = createOpaqueId("document");
	const result = await recordDocumentLocation(projectRoot, {
		documentId,
		sourceId,
		operationId,
		expectedManifestRevision: (await currentManifest()).revision,
		location: locationResult(value),
	});
	if (!result.ok) throw new Error(result.errors[0].message);
	return result.value;
}

async function acquire(
	document: DocumentRecord,
	value: DocumentLocationCandidate,
	transport: HttpTransport,
	maxBytesPerFile = 1_024 * 1_024,
	expectedContentHash: HashValue | null = null,
) {
	const operationId = await createRunningOperation("document.fixture.acquire");
	const manifest = await currentManifest();
	const context = {
		operationId,
		sessionId: "session-fixture",
		policySnapshotHash: hashCanonicalJson(manifest.policy),
		signal: new AbortController().signal,
	};
	return acquireDocument(projectRoot, {
		documentId: document.documentId,
		operationId,
		sessionId: context.sessionId,
		expectedDocumentRevision: document.audit.revision,
		candidate: value,
		allowOpenAccessDownload: true,
		maxBytesPerFile,
		expectedContentHash,
		requestHttp: (request) => requestGovernedHttp(projectRoot, context, request, { transport, wait: async () => {} }),
	});
}

describe("document acquisition", () => {
	it("keeps access, location kind, and unknown license separate", () => {
		const rawResponse = rawFile(".research/runs/fixture/unpaywall.json");
		const located = normalizeUnpaywallLocations(sourceId, {
			doi: "10.5555/document.1",
			isOpenAccess: true,
			oaStatus: "green",
			accessStatus: "open_access",
			locations: [
				{
					url: "https://repository.example.test/landing",
					landingPageUrl: "https://repository.example.test/landing",
					pdfUrl: "https://repository.example.test/document.pdf",
					hostType: "repository",
					version: "acceptedVersion",
					isBest: true,
					license: null,
					licenseStatus: "unknown",
					oaDate: null,
					repositoryInstitution: null,
					evidence: null,
				},
			],
			bestLocation: null,
			rawResponse,
			actualCost: { amount: 0, currency: "USD" },
		});
		expect(located).toMatchObject({
			accessStatus: "open_access",
			fullTextStatus: "located",
			bestLocation: { kind: "direct_pdf", licenseStatus: "unknown", isBest: true },
		});
		expect(located.locations.map(({ kind }) => kind)).toEqual(["direct_pdf", "landing_page"]);

		const paywalled = normalizeUnpaywallLocations(sourceId, {
			doi: "10.5555/document.1",
			isOpenAccess: false,
			oaStatus: "closed",
			accessStatus: "paywalled",
			locations: [],
			bestLocation: null,
			rawResponse,
			actualCost: { amount: 0, currency: "USD" },
		});
		expect(paywalled).toMatchObject({
			accessStatus: "paywalled",
			fullTextStatus: "paywall_blocked",
			bestLocation: null,
		});
	});

	it("stores a verified PDF once under its hash and marks the original read-only", async () => {
		const pdf = await readFile(join(fixtureDirectory, "tiny.pdf"));
		const value = candidate("https://repository.example.test/document.pdf");
		const document = await createLocatedDocument(value);
		const transport = createRecordedHttpTransport([
			{
				request: { method: "GET", url: value.url, body: null },
				response: {
					status: 200,
					headers: {
						"content-type": "application/pdf",
						etag: '"fixture-etag"',
						"last-modified": "Wed, 06 Aug 2026 00:00:00 GMT",
					},
					body: pdf.toString("base64"),
					bodyBytes: pdf.byteLength,
				},
			},
		]);
		const result = await acquire(document, value, transport, 1_024, hashBytes(pdf));
		expect(result).toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				fullTextStatus: "acquired_unparsed",
				immutableOriginal: true,
				textLayer: "unknown",
				acquisition: {
					accessStatus: "open_access",
					licenseExpression: null,
					origin: value.url,
				},
			},
		});
		if (!result.ok || result.value.localFile === null) throw new Error("expected stored document");
		const path = join(projectRoot, ...result.value.localFile.path.split("/"));
		expect(await readFile(path)).toEqual(pdf);
		expect((await hashFile(path)).value).toBe(hashBytes(pdf).value);
		expect((await stat(path)).mode & 0o222).toBe(0);
		expect(result.value.localFile.path).toBe(`sources/originals/${hashBytes(pdf).value}.pdf`);
	});

	it("records HTML, oversize, redirect, and hash failures without saving an original", async () => {
		const html = await readFile(join(fixtureDirectory, "not-pdf.html"));
		const pdf = await readFile(join(fixtureDirectory, "tiny.pdf"));
		const cases = [
			{
				name: "html",
				response: { status: 200, headers: { "content-type": "text/html" }, body: html.toString("base64") },
				maxBytes: 1_024,
				expectedHash: null,
				code: "DOCUMENT_MEDIA_TYPE_INVALID",
				status: "unavailable",
				accessStatus: "open_access",
			},
			{
				name: "oversize",
				response: { status: 200, headers: { "content-type": "application/pdf" }, body: pdf.toString("base64") },
				maxBytes: 16,
				expectedHash: null,
				code: "DOCUMENT_TOO_LARGE",
				status: "unavailable",
				accessStatus: "open_access",
			},
			{
				name: "redirect",
				response: {
					status: 302,
					headers: { location: "https://cdn.example.test/document.pdf?token=redirect-secret" },
					body: "",
				},
				maxBytes: 1_024,
				expectedHash: null,
				code: "DOCUMENT_REDIRECT_BLOCKED",
				status: "located",
				accessStatus: "blocked_by_policy",
			},
			{
				name: "hash",
				response: { status: 200, headers: { "content-type": "application/pdf" }, body: pdf.toString("base64") },
				maxBytes: 1_024,
				expectedHash: hashBytes("different"),
				code: "DOCUMENT_HASH_MISMATCH",
				status: "unavailable",
				accessStatus: "open_access",
			},
		] as const;

		for (const testCase of cases) {
			const value = candidate(`https://repository.example.test/${testCase.name}.pdf`);
			const document = await createLocatedDocument(value);
			const result = await acquire(
				document,
				value,
				createRecordedHttpTransport([
					{ request: { method: "GET", url: value.url, body: null }, response: testCase.response },
				]),
				testCase.maxBytes,
				testCase.expectedHash,
			);
			expect(result, testCase.name).toMatchObject({
				ok: true,
				status: "PARTIAL_SUCCESS",
				value: {
					fullTextStatus: testCase.status,
					localFile: null,
					immutableOriginal: false,
					acquisition: { accessStatus: testCase.accessStatus },
					failure: { code: testCase.code },
				},
				errors: [{ code: testCase.code }],
			});
			if (testCase.name === "redirect") expect(JSON.stringify(result)).not.toContain("redirect-secret");
		}
	});

	it("blocks paywall, authentication, license, policy, and landing-page acquisition before HTTP", async () => {
		const cases = [
			["paywalled", "direct_pdf", "DOCUMENT_PAYWALLED"],
			["authentication_required", "direct_pdf", "DOCUMENT_AUTHENTICATION_REQUIRED"],
			["license_restricted", "direct_pdf", "DOCUMENT_LICENSE_RESTRICTED"],
			["blocked_by_policy", "direct_pdf", "DOCUMENT_BLOCKED_BY_POLICY"],
			["open_access", "landing_page", "DOCUMENT_DIRECT_PDF_REQUIRED"],
		] as const;
		for (const [accessStatus, kind, code] of cases) {
			let requests = 0;
			const result = await fetchDocumentOriginal({
				projectRoot,
				operationId: createOpaqueId("operation"),
				sessionId: null,
				candidate: candidate("https://repository.example.test/document", { accessStatus, kind }),
				allowOpenAccessDownload: true,
				maxBytesPerFile: 1_024,
				expectedContentHash: null,
				requestHttp: async () => {
					requests += 1;
					throw new Error("blocked acquisition reached HTTP");
				},
			});
			expect(result).toMatchObject({ ok: false, status: "PERMISSION_BLOCKED", errors: [{ code }] });
			expect(requests).toBe(0);
		}
	});
});
