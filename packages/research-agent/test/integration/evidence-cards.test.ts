import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import type {
	ClaimRecord,
	DocumentRecord,
	FileRef,
	OperationRecord,
	RecordRef,
	ResearchProjectManifest,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import type { ParsedPdfDocument } from "../../src/documents/pdf-parser.ts";
import type { EvidenceCardDraft } from "../../src/evidence/commit.ts";
import { invalidateStaleEvidenceForDocument } from "../../src/evidence/commit.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../../src/kernel/integrity.ts";
import { operationTransitionPatch } from "../../src/kernel/operations.ts";
import { resolveProjectPath } from "../../src/kernel/paths.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";
import { brokerProjectFile } from "../../src/security/broker-files.ts";
import { commitEvidenceCard, invalidateEvidenceCard, queryCorpus } from "../../src/tools/evidence.ts";

const timestamp = "2026-08-06T00:00:00.000Z";
const fullText = "Transparency improves public trust when procedures are understandable.";

let temporaryDirectory: string;
let projectRoot: string;

interface FixtureProject {
	source: SourceRecord;
	document: DocumentRecord;
	claim: ClaimRecord;
	parsed: ParsedPdfDocument;
}

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-evidence-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Evidence cards" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function manifest(): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	return opened.manifest;
}

function operationRecord(
	operationId: string,
	name: string,
	inputs: RecordRef[] = [],
	inputFiles: FileRef[] = [],
): OperationRecord {
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
		actor: { type: "tool", id: "research.evidence" },
		modelExecution: null,
		adapterExecution: null,
		inputs,
		inputFiles,
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
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

async function createRunningOperation(
	name: string,
	inputs: RecordRef[] = [],
	inputFiles: FileRef[] = [],
): Promise<string> {
	const operationId = createOpaqueId("operation");
	const created = await createRecord(projectRoot, operationRecord(operationId, name, inputs, inputFiles), {
		expectedManifestRevision: (await manifest()).revision,
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	const record = await readRecord(projectRoot, "operation", operationId);
	if (!record.ok || record.value.kind !== "operation") throw new Error("expected operation");
	const updated = await updateRecord(projectRoot, "operation", operationId, {
		expectedManifestRevision: (await manifest()).revision,
		expectedRecordRevision: record.value.audit.revision,
		operationId,
		changes: operationTransitionPatch(record.value, "running"),
	});
	if (!updated.ok) throw new Error(updated.errors[0].message);
	return operationId;
}

function audit(operationId: string) {
	return {
		createdAt: timestamp,
		updatedAt: timestamp,
		revision: 0,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

function parsedDocument(documentId: string, original: FileRef, parserVersion = "fixture-1"): ParsedPdfDocument {
	if (original.hash === null) throw new Error("expected original hash");
	const parser = {
		id: "pdfjs-dist" as const,
		version: parserVersion,
		optionsHash: hashCanonicalJson({ fixture: parserVersion }),
	};
	const anchorHash = hashCanonicalJson({
		pageNumber: 1,
		sectionPath: ["Findings"],
		sourceContentHash: original.hash,
		text: fullText,
	});
	return {
		formatVersion: "0.1.0",
		documentId,
		sourceContentHash: original.hash,
		parser,
		textLayer: "present",
		pageCount: 1,
		text: fullText,
		textHash: hashBytes(fullText),
		pages: [
			{
				pageNumber: 1,
				text: fullText,
				charStart: 0,
				charEnd: fullText.length,
				textHash: hashBytes(fullText),
				blocks: [
					{
						blockId: "p1-b1",
						pageNumber: 1,
						sectionPath: ["Findings"],
						text: fullText,
						charStart: 0,
						charEnd: fullText.length,
						anchorHash,
					},
				],
			},
		],
		warnings: [],
	};
}

async function storeProjectFile(operationId: string, path: string, content: string | Uint8Array, mediaType: string) {
	const result = await brokerProjectFile(projectRoot, {
		operationId,
		sessionId: null,
		expectedManifestRevision: (await manifest()).revision,
		path,
		content,
		dataClasses: [mediaType === "application/pdf" ? "user_provided_document" : "research_document_text"],
	});
	if (!result.ok) throw new Error(result.errors[0].message);
	return {
		path: result.value.path,
		hash: result.value.hash,
		mediaType,
		bytes: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength,
	};
}

async function createFixtureProject(): Promise<FixtureProject> {
	const setupOperationId = await createRunningOperation("evidence.fixture.setup");
	const originalBytes = new TextEncoder().encode("synthetic immutable PDF bytes");
	const originalHash = hashBytes(originalBytes);
	const original = await storeProjectFile(
		setupOperationId,
		`sources/originals/${originalHash.value}.pdf`,
		originalBytes,
		"application/pdf",
	);
	const sourceId = createOpaqueId("source");
	const source: SourceRecord = {
		kind: "source",
		schemaVersion: "0.1.0",
		sourceId,
		identifiers: [],
		title: "Transparency and public trust",
		titleNormalized: "transparency and public trust",
		contributors: [],
		issuedDate: "2026",
		containerTitle: null,
		publisher: null,
		sourceType: "article",
		language: "en",
		abstractText: "The abstract reports that transparency is associated with public trust.",
		abstractRights: "display_allowed",
		discovery: [],
		dedupKeys: {
			doi: null,
			strongIdentifier: null,
			normalizedTitleYearFirstAuthor: null,
			contentHash: originalHash.value,
		},
		duplicateStatus: "canonical",
		canonicalSourceId: null,
		metadataConflicts: [],
		publicationStatus: "normal",
		audit: audit(setupOperationId),
	};
	const createdSource = await createRecord(projectRoot, source, {
		expectedManifestRevision: (await manifest()).revision,
		operationId: setupOperationId,
	});
	if (!createdSource.ok) throw new Error(createdSource.errors[0].message);

	const documentId = createOpaqueId("document");
	const parsed = parsedDocument(documentId, original);
	const parsedContent = `${canonicalStringify(parsed)}\n`;
	const parsedHash = hashBytes(parsedContent);
	const parsedOutput = await storeProjectFile(
		setupOperationId,
		`sources/parsed/${parsedHash.value}.json`,
		parsedContent,
		"application/json",
	);
	const document: DocumentRecord = {
		kind: "document",
		schemaVersion: "0.1.0",
		documentId,
		sourceId,
		acquisition: {
			method: "local_import",
			adapterId: "fixture",
			origin: "fixture.pdf",
			accessStatus: "user_provided",
			licenseExpression: null,
			termsReference: null,
			acquiredAt: timestamp,
			approvalId: null,
		},
		localFile: original,
		originalFileName: "fixture.pdf",
		immutableOriginal: true,
		fullTextStatus: "parsed",
		textLayer: "present",
		parser: parsed.parser,
		parsedOutput,
		pageCount: 1,
		parsedAt: timestamp,
		warnings: [],
		failure: null,
		audit: audit(setupOperationId),
	};
	const createdDocument = await createRecord(projectRoot, document, {
		expectedManifestRevision: (await manifest()).revision,
		operationId: setupOperationId,
	});
	if (!createdDocument.ok) throw new Error(createdDocument.errors[0].message);

	const claimId = createOpaqueId("claim");
	const claim: ClaimRecord = {
		kind: "claim",
		schemaVersion: "0.1.0",
		claimId,
		text: "Transparency supports public trust.",
		claimType: "empirical_association",
		scope: "management literature",
		evidenceLinks: [],
		supportStatus: "unassessed",
		conflictEvidenceIds: [],
		humanConfirmation: { status: "not_reviewed", decidedAt: null, note: null },
		publishability: "blocked",
		audit: audit(setupOperationId),
	};
	const createdClaim = await createRecord(projectRoot, claim, {
		expectedManifestRevision: (await manifest()).revision,
		operationId: setupOperationId,
	});
	if (!createdClaim.ok) throw new Error(createdClaim.errors[0].message);
	return { source, document, claim, parsed };
}

async function extractionOperation(fixture: FixtureProject, name: string): Promise<string> {
	if (fixture.document.parsedOutput === null) throw new Error("expected parsed output");
	return createRunningOperation(
		name,
		[
			{ kind: "source", id: fixture.source.sourceId, revision: fixture.source.audit.revision },
			{ kind: "document", id: fixture.document.documentId, revision: fixture.document.audit.revision },
		],
		[fixture.document.parsedOutput],
	);
}

function locatedDraft(fixture: FixtureProject, operationId: string): EvidenceCardDraft {
	const block = fixture.parsed.pages[0]?.blocks[0];
	if (block === undefined) throw new Error("expected parsed block");
	return {
		sourceId: fixture.source.sourceId,
		documentId: fixture.document.documentId,
		evidenceLevel: "fulltext_located",
		locator: {
			locatorType: "paragraph",
			pageStart: 1,
			pageEnd: 1,
			sectionPath: ["Findings"],
			label: block.blockId,
			charStart: block.charStart,
			charEnd: block.charEnd,
			anchorHash: block.anchorHash,
		},
		excerpt: fullText,
		excerptExactMatch: true,
		paraphrase: "Transparent procedures are associated with public trust.",
		evidenceStatement: "The full text reports a positive association between transparency and public trust.",
		claimLinks: [
			{
				claimId: fixture.claim.claimId,
				relation: "supports",
				rationale: "The located finding directly reports the association in the claim.",
			},
		],
		extraction: {
			method: "deterministic",
			operationId,
			modelProvider: null,
			modelId: null,
			promptHash: null,
		},
		confidence: { level: "high", basis: "Exact parser match", limitations: [] },
		rights: { excerptAllowed: true, maxStoredWords: 20, publicExportAllowed: false },
		humanStatus: "not_reviewed",
		supersedesEvidenceId: null,
	};
}

describe("corpus query and evidence cards", () => {
	it("keeps metadata, abstract, and located full text distinct with corpus-bound pagination", async () => {
		const fixture = await createFixtureProject();
		const queryOperationId = await createRunningOperation("corpus.query");
		const result = await queryCorpus(projectRoot, {
			operationId: queryOperationId,
			query: "transparency",
			scope: "all",
			filters: {},
			limit: 100,
			maxCharsPerHit: 200,
			cursor: null,
		});
		expect(result).toMatchObject({ ok: true, status: "SUCCESS" });
		if (!result.ok) throw new Error(result.errors[0].message);
		expect(result.value.hits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					hitKind: "source_metadata",
					evidenceLevel: "metadata",
					documentId: null,
					locator: null,
				}),
				expect.objectContaining({
					hitKind: "source_abstract",
					evidenceLevel: "abstract",
					documentId: null,
					locator: null,
				}),
				expect.objectContaining({
					hitKind: "document_block",
					evidenceLevel: "fulltext_located",
					documentId: fixture.document.documentId,
					locator: expect.objectContaining({
						pageStart: 1,
						label: "p1-b1",
						anchorHash: fixture.parsed.pages[0]?.blocks[0]?.anchorHash,
					}),
				}),
			]),
		);

		const firstPage = await queryCorpus(projectRoot, {
			operationId: queryOperationId,
			query: "transparency",
			scope: "sources",
			filters: {},
			limit: 1,
			maxCharsPerHit: 200,
			cursor: null,
		});
		if (!firstPage.ok || firstPage.value.nextCursor === null) throw new Error("expected query cursor");
		const revisionOperationId = await createRunningOperation("project.revision.change");
		await expect(
			queryCorpus(projectRoot, {
				operationId: queryOperationId,
				query: "transparency",
				scope: "sources",
				filters: {},
				limit: 1,
				maxCharsPerHit: 200,
				cursor: firstPage.value.nextCursor,
			}),
		).resolves.toMatchObject({ ok: true, value: { hits: [expect.any(Object)] } });
		const currentSource = await readRecord(projectRoot, "source", fixture.source.sourceId);
		if (!currentSource.ok || currentSource.value.kind !== "source") throw new Error("expected source");
		const sourceUpdate = await updateRecord(projectRoot, "source", fixture.source.sourceId, {
			expectedManifestRevision: (await manifest()).revision,
			expectedRecordRevision: currentSource.value.audit.revision,
			operationId: revisionOperationId,
			changes: { title: `${currentSource.value.title} revised` },
		});
		if (!sourceUpdate.ok) throw new Error(sourceUpdate.errors[0].message);
		await expect(
			queryCorpus(projectRoot, {
				operationId: queryOperationId,
				query: "transparency",
				scope: "sources",
				filters: {},
				limit: 1,
				maxCharsPerHit: 200,
				cursor: firstPage.value.nextCursor,
			}),
		).resolves.toMatchObject({ ok: false, status: "DATA_CONFLICT", errors: [{ code: "CORPUS_CURSOR_STALE" }] });
	});

	it("commits exact located evidence and rejects abstract promotion or mismatched excerpts", async () => {
		const fixture = await createFixtureProject();
		const operationId = await extractionOperation(fixture, "evidence.commit");
		const committed = await commitEvidenceCard(projectRoot, {
			operationId,
			expectedManifestRevision: (await manifest()).revision,
			validationMode: "strict",
			draft: locatedDraft(fixture, operationId),
		});
		expect(committed).toMatchObject({
			ok: true,
			value: {
				evidenceLevel: "fulltext_located",
				excerptExactMatch: true,
				validity: "active",
				claimLinks: [{ claimId: fixture.claim.claimId, relation: "supports" }],
			},
		});
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true });

		const mismatchOperationId = await extractionOperation(fixture, "evidence.mismatch");
		await expect(
			commitEvidenceCard(projectRoot, {
				operationId: mismatchOperationId,
				expectedManifestRevision: (await manifest()).revision,
				validationMode: "strict",
				draft: { ...locatedDraft(fixture, mismatchOperationId), excerpt: "The abstract reports transparency." },
			}),
		).resolves.toMatchObject({
			ok: false,
			status: "DATA_CONFLICT",
			errors: [{ code: "EVIDENCE_EXCERPT_MISMATCH" }],
		});
		const locator = locatedDraft(fixture, mismatchOperationId).locator;
		if (locator === null) throw new Error("expected locator");
		await expect(
			commitEvidenceCard(projectRoot, {
				operationId: mismatchOperationId,
				expectedManifestRevision: (await manifest()).revision,
				validationMode: "strict",
				draft: {
					...locatedDraft(fixture, mismatchOperationId),
					locator: { ...locator, locatorType: "page_range", pageEnd: 2 },
				},
			}),
		).resolves.toMatchObject({ ok: false, errors: [{ code: "EVIDENCE_LOCATOR_INVALID" }] });

		const promotionOperationId = await createRunningOperation(
			"evidence.abstract-promotion",
			[{ kind: "source", id: fixture.source.sourceId, revision: fixture.source.audit.revision }],
			[],
		);
		await expect(
			commitEvidenceCard(projectRoot, {
				operationId: promotionOperationId,
				expectedManifestRevision: (await manifest()).revision,
				validationMode: "strict",
				draft: {
					...locatedDraft(fixture, promotionOperationId),
					documentId: null,
					locator: null,
					excerpt: fixture.source.abstractText,
				},
			}),
		).resolves.toMatchObject({ ok: false, errors: [{ code: "EVIDENCE_DOCUMENT_REQUIRED" }] });
	});

	it("commits abstract evidence only at the abstract level", async () => {
		const fixture = await createFixtureProject();
		const operationId = await createRunningOperation(
			"evidence.abstract",
			[{ kind: "source", id: fixture.source.sourceId, revision: fixture.source.audit.revision }],
			[],
		);
		const draft: EvidenceCardDraft = {
			...locatedDraft(fixture, operationId),
			documentId: null,
			evidenceLevel: "abstract",
			locator: null,
			excerpt: "transparency is associated with public trust",
			excerptExactMatch: true,
			paraphrase: "The abstract reports an association.",
			evidenceStatement: "The abstract reports an association between transparency and public trust.",
			confidence: { level: "medium", basis: "Abstract only", limitations: ["Full text not used"] },
			rights: { excerptAllowed: true, maxStoredWords: 10, publicExportAllowed: false },
		};
		await expect(
			commitEvidenceCard(projectRoot, {
				operationId,
				expectedManifestRevision: (await manifest()).revision,
				validationMode: "strict",
				draft,
			}),
		).resolves.toMatchObject({
			ok: true,
			value: { evidenceLevel: "abstract", documentId: null, locator: null, excerptExactMatch: true },
		});
	});

	it("supersedes atomically, invalidates explicitly, and invalidates stale parser snapshots", async () => {
		const fixture = await createFixtureProject();
		const firstOperationId = await extractionOperation(fixture, "evidence.first");
		const first = await commitEvidenceCard(projectRoot, {
			operationId: firstOperationId,
			expectedManifestRevision: (await manifest()).revision,
			validationMode: "strict",
			draft: locatedDraft(fixture, firstOperationId),
		});
		if (!first.ok) throw new Error(first.errors[0].message);

		const secondOperationId = await extractionOperation(fixture, "evidence.supersede");
		const revisionBefore = (await manifest()).revision;
		const second = await commitEvidenceCard(projectRoot, {
			operationId: secondOperationId,
			expectedManifestRevision: revisionBefore,
			validationMode: "strict",
			draft: {
				...locatedDraft(fixture, secondOperationId),
				paraphrase: "Transparent, understandable procedures are associated with public trust.",
				evidenceStatement: "The located finding qualifies how transparency is associated with public trust.",
				supersedesEvidenceId: first.value.evidenceId,
			},
		});
		if (!second.ok) throw new Error(second.errors[0].message);
		expect((await manifest()).revision).toBe(revisionBefore + 1);
		await expect(readRecord(projectRoot, "evidence", first.value.evidenceId)).resolves.toMatchObject({
			ok: true,
			value: { validity: "superseded", audit: { revision: 1, updatedByOperationId: secondOperationId } },
		});
		expect(second.value).toMatchObject({ validity: "active", supersedesEvidenceId: first.value.evidenceId });

		const invalidateOperationId = await createRunningOperation("evidence.invalidate");
		await expect(
			invalidateEvidenceCard(projectRoot, {
				operationId: invalidateOperationId,
				expectedManifestRevision: (await manifest()).revision,
				evidenceId: second.value.evidenceId,
				expectedEvidenceRevision: second.value.audit.revision,
			}),
		).resolves.toMatchObject({ ok: true, value: { validity: "invalidated" } });
		const reviewedOperationId = await extractionOperation(fixture, "evidence.reviewed");
		const reviewed = await commitEvidenceCard(projectRoot, {
			operationId: reviewedOperationId,
			expectedManifestRevision: (await manifest()).revision,
			validationMode: "strict",
			draft: {
				...locatedDraft(fixture, reviewedOperationId),
				evidenceStatement: "A human-reviewed evidence statement.",
				claimLinks: [],
				humanStatus: "accepted",
			},
		});
		if (!reviewed.ok) throw new Error(reviewed.errors[0].message);
		const protectedInvalidationOperationId = await createRunningOperation("evidence.invalidate.reviewed");
		await expect(
			invalidateEvidenceCard(projectRoot, {
				operationId: protectedInvalidationOperationId,
				expectedManifestRevision: (await manifest()).revision,
				evidenceId: reviewed.value.evidenceId,
				expectedEvidenceRevision: reviewed.value.audit.revision,
			}),
		).resolves.toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "EVIDENCE_HUMAN_REVIEW_PROTECTED" }],
		});

		const thirdOperationId = await extractionOperation(fixture, "evidence.stale");
		const third = await commitEvidenceCard(projectRoot, {
			operationId: thirdOperationId,
			expectedManifestRevision: (await manifest()).revision,
			validationMode: "strict",
			draft: { ...locatedDraft(fixture, thirdOperationId), claimLinks: [] },
		});
		if (!third.ok) throw new Error(third.errors[0].message);
		const reparseOperationId = await createRunningOperation("document.reparse");
		if (fixture.document.localFile === null) throw new Error("expected local file");
		const nextParsed = parsedDocument(fixture.document.documentId, fixture.document.localFile, "fixture-2");
		const nextContent = `${canonicalStringify(nextParsed)}\n`;
		const nextHash = hashBytes(nextContent);
		const nextOutput = await storeProjectFile(
			reparseOperationId,
			`sources/parsed/${nextHash.value}.json`,
			nextContent,
			"application/json",
		);
		const documentUpdate = await updateRecord(projectRoot, "document", fixture.document.documentId, {
			expectedManifestRevision: (await manifest()).revision,
			expectedRecordRevision: fixture.document.audit.revision,
			operationId: reparseOperationId,
			changes: {
				parser: {
					id: nextParsed.parser.id,
					version: nextParsed.parser.version,
					optionsHash: {
						algorithm: nextParsed.parser.optionsHash.algorithm,
						value: nextParsed.parser.optionsHash.value,
					},
				},
				parsedOutput: {
					path: nextOutput.path,
					hash:
						nextOutput.hash === null
							? null
							: { algorithm: nextOutput.hash.algorithm, value: nextOutput.hash.value },
					mediaType: nextOutput.mediaType,
					bytes: nextOutput.bytes,
				},
			},
		});
		if (!documentUpdate.ok) throw new Error(documentUpdate.errors[0].message);
		const currentDocument = await readRecord(projectRoot, "document", fixture.document.documentId);
		if (!currentDocument.ok || currentDocument.value.kind !== "document") throw new Error("expected document");
		await expect(
			invalidateStaleEvidenceForDocument(projectRoot, currentDocument.value, reparseOperationId),
		).resolves.toMatchObject({ ok: true, value: 2 });
		await expect(readRecord(projectRoot, "evidence", third.value.evidenceId)).resolves.toMatchObject({
			ok: true,
			value: { validity: "invalidated" },
		});
		await expect(readRecord(projectRoot, "evidence", reviewed.value.evidenceId)).resolves.toMatchObject({
			ok: true,
			value: { validity: "invalidated" },
		});
	});

	it("stops returning full-text hits when the parsed artifact hash no longer matches", async () => {
		const fixture = await createFixtureProject();
		const extractionOperationId = await extractionOperation(fixture, "evidence.before-tamper");
		const committed = await commitEvidenceCard(projectRoot, {
			operationId: extractionOperationId,
			expectedManifestRevision: (await manifest()).revision,
			validationMode: "strict",
			draft: locatedDraft(fixture, extractionOperationId),
		});
		if (!committed.ok) throw new Error(committed.errors[0].message);
		if (fixture.document.parsedOutput === null) throw new Error("expected parsed output");
		const path = await resolveProjectPath(projectRoot, fixture.document.parsedOutput.path);
		const content = await readFile(path);
		await chmod(path, 0o644);
		await writeFile(path, Buffer.concat([content, Buffer.from(" ")]));
		const operationId = await createRunningOperation("corpus.query.tampered");
		await expect(
			queryCorpus(projectRoot, {
				operationId,
				query: "transparency",
				scope: "documents",
				filters: {},
				limit: 10,
				maxCharsPerHit: 200,
				cursor: null,
			}),
		).resolves.toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: { hits: [] },
			errors: [{ code: "EVIDENCE_PARSED_OUTPUT_INTEGRITY_FAILED" }],
		});
		expect(await validateProject(projectRoot)).toMatchObject({
			valid: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "EVIDENCE_PARSED_OUTPUT_INTEGRITY_FAILED" })]),
		});
	});
});
