// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAnalysisRuntime, executeAnalysis } from "../../src/analysis/runtime.ts";
import type {
	ClaimRecord,
	DocumentRecord,
	FileRef,
	RecordRef,
	ResearchResult,
	SemanticProvenance,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../../src/contracts/schemas.ts";
import type { ParsedPdfDocument } from "../../src/documents/pdf-parser.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes } from "../../src/kernel/integrity.ts";
import { resolveProjectPath } from "../../src/kernel/paths.ts";
import { successResult } from "../../src/kernel/results.ts";
import { createProjectBackup, restoreProjectBackup } from "../../src/project/backup.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";
import { brokerProjectFile } from "../../src/security/broker-files.ts";
import {
	createAnalysisSpecification,
	decideAnalysisSpecification,
	importCsvDataset,
} from "../../src/tools/analysis.ts";
import { parseDocument } from "../../src/tools/documents.ts";
import { commitEvidenceCard, linkEvidenceToClaim } from "../../src/tools/evidence.ts";
import { finishOperation, startOperation } from "../../src/tools/operations.ts";
import { createManuscriptRevision, recordReviewFindings } from "../../src/tools/writing.ts";

interface PublicCorpusManifest {
	documents: Array<{
		author: string;
		bytes: number;
		doi: string;
		id: string;
		issued: string;
		publisher: string;
		rights: string;
		rightsUrl: string;
		sha256: string;
		title: string;
		url: string;
	}>;
}

const corpusPath = fileURLToPath(new URL("../../evals/v2.0/public-corpus.json", import.meta.url));
let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-public-corpus-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "NIST AI RMF public-corpus qualification" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function revision(): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	return opened.manifest.revision;
}

async function begin(
	name: string,
	operationKind: "human" | "tool" = "human",
	inputs: readonly RecordRef[] = [],
	inputFiles: readonly FileRef[] = [],
): Promise<string> {
	const started = await startOperation(projectRoot, {
		operationKind,
		name,
		implementationVersion: "2.0.1-qualification",
		session: null,
		inputs: [...inputs],
		inputFiles: [...inputFiles],
	});
	if (!started.ok) throw new Error(started.errors[0].message);
	return started.value.operationId;
}

async function finish(
	operationId: string,
	result: ResearchResult<unknown>,
	outputs: readonly RecordRef[] = [],
	outputFiles: readonly FileRef[] = [],
): Promise<void> {
	const finished = await finishOperation(projectRoot, operationId, result, outputs, outputFiles);
	if (!finished.ok) throw new Error(finished.errors[0].message);
}

function audit(operationId: string, now: string) {
	return {
		createdAt: now,
		updatedAt: now,
		revision: 0,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

function humanProvenance(operationId: string): SemanticProvenance {
	return {
		method: "human_entered",
		operationId,
		modelProvider: null,
		modelId: null,
		promptHash: null,
		toolSchemaHash: null,
		turnId: null,
	};
}

describe.runIf(process.env.RESEARCH_AGENT_PUBLIC_CORPUS === "1")("licensed public-corpus workflow", () => {
	it("runs import, parse, evidence, analysis, manuscript, review, and restore on one project", async () => {
		const manifest = JSON.parse(await readFile(corpusPath, "utf8")) as PublicCorpusManifest;
		const corpus = manifest.documents[0];
		if (corpus === undefined) throw new Error("Public corpus manifest is empty");
		const response = await fetch(corpus.url, { signal: AbortSignal.timeout(60_000) });
		if (!response.ok) throw new Error(`Public corpus fetch failed: ${response.status}`);
		const pdf = new Uint8Array(await response.arrayBuffer());
		expect(pdf.byteLength).toBe(corpus.bytes);
		expect(hashBytes(pdf).value).toBe(corpus.sha256);

		const setupOperationId = await begin("qualification.public-corpus.import");
		const stored = await brokerProjectFile(projectRoot, {
			operationId: setupOperationId,
			sessionId: null,
			expectedManifestRevision: await revision(),
			path: `sources/originals/${corpus.sha256}.pdf`,
			content: pdf,
			dataClasses: ["user_provided_document"],
		});
		if (!stored.ok) throw new Error(stored.errors[0].message);
		const original: FileRef = {
			path: stored.value.path,
			hash: stored.value.hash,
			mediaType: "application/pdf",
			bytes: pdf.byteLength,
		};
		const now = new Date().toISOString();
		const sourceId = createOpaqueId("source");
		const source: SourceRecord = {
			kind: "source",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			sourceId,
			identifiers: [
				{
					scheme: "doi",
					value: corpus.doi,
					normalizedValue: corpus.doi.toLowerCase(),
					verified: false,
					verificationId: null,
				},
			],
			title: corpus.title,
			titleNormalized: corpus.title.toLowerCase(),
			contributors: [{ family: corpus.author, given: null, literal: corpus.author, orcid: null }],
			issuedDate: corpus.issued,
			containerTitle: null,
			publisher: corpus.publisher,
			sourceType: "report",
			language: "en",
			abstractText: null,
			abstractRights: "metadata_only",
			discovery: [],
			dedupKeys: {
				doi: corpus.doi.toLowerCase(),
				strongIdentifier: `doi:${corpus.doi.toLowerCase()}`,
				normalizedTitleYearFirstAuthor: null,
				contentHash: corpus.sha256,
			},
			duplicateStatus: "canonical",
			canonicalSourceId: null,
			metadataConflicts: [],
			publicationStatus: "normal",
			audit: audit(setupOperationId, now),
		};
		const createdSource = await createRecord(projectRoot, source, {
			expectedManifestRevision: await revision(),
			operationId: setupOperationId,
		});
		if (!createdSource.ok) throw new Error(createdSource.errors[0].message);
		const documentId = createOpaqueId("document");
		const document: DocumentRecord = {
			kind: "document",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			documentId,
			sourceId,
			acquisition: {
				method: "local_import",
				adapterId: "nist-public-corpus",
				origin: corpus.url,
				accessStatus: "open_access",
				licenseExpression: corpus.rights,
				termsReference: corpus.rightsUrl,
				acquiredAt: now,
				approvalId: null,
			},
			localFile: original,
			originalFileName: `${corpus.id}.pdf`,
			immutableOriginal: true,
			fullTextStatus: "acquired_unparsed",
			textLayer: "unknown",
			parser: null,
			parsedOutput: null,
			pageCount: null,
			parsedAt: null,
			warnings: [],
			failure: null,
			audit: audit(setupOperationId, now),
		};
		const createdDocument = await createRecord(projectRoot, document, {
			expectedManifestRevision: await revision(),
			operationId: setupOperationId,
		});
		if (!createdDocument.ok) throw new Error(createdDocument.errors[0].message);
		await finish(
			setupOperationId,
			successResult({ sourceId, documentId }, setupOperationId),
			[
				{ kind: "source", id: sourceId, revision: 0 },
				{ kind: "document", id: documentId, revision: 0 },
			],
			[original],
		);

		const parseOperationId = await begin("qualification.public-corpus.parse", "tool");
		const parsed = await parseDocument(projectRoot, {
			documentId,
			operationId: parseOperationId,
			sessionId: null,
			expectedDocumentRevision: 0,
			options: { maxBytes: 3_000_000, maxPages: 100 },
		});
		if (!parsed.ok || parsed.value.parsedOutput === null) throw new Error(JSON.stringify(parsed.errors));
		await finish(
			parseOperationId,
			parsed,
			[{ kind: "document", id: documentId, revision: parsed.value.audit.revision }],
			[parsed.value.parsedOutput],
		);
		const parsedDocument = JSON.parse(
			await readFile(await resolveProjectPath(projectRoot, parsed.value.parsedOutput.path), "utf8"),
		) as ParsedPdfDocument;
		const block = parsedDocument.pages
			.flatMap(({ blocks }) => blocks)
			.find(({ text }) => /AI RMF|risk management framework/iu.test(text));
		if (block === undefined) throw new Error("Public corpus did not contain a qualifying text block");

		const claimOperationId = await begin("qualification.public-corpus.claim");
		const claimId = createOpaqueId("claim");
		const claimText = "The NIST AI RMF is a voluntary framework for managing AI risks.";
		const claim: ClaimRecord = {
			kind: "claim",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			claimId,
			text: claimText,
			claimType: "descriptive",
			scope: "NIST AI RMF 1.0",
			evidenceLinks: [],
			supportStatus: "unassessed",
			conflictEvidenceIds: [],
			semanticProvenance: { claim: humanProvenance(claimOperationId), evidenceLinks: [] },
			humanConfirmation: { status: "not_reviewed", decidedAt: null, note: null },
			publishability: "blocked",
			audit: audit(claimOperationId, now),
		};
		const createdClaim = await createRecord(projectRoot, claim, {
			expectedManifestRevision: await revision(),
			operationId: claimOperationId,
		});
		if (!createdClaim.ok) throw new Error(createdClaim.errors[0].message);
		await finish(claimOperationId, createdClaim, [{ kind: "claim", id: claimId, revision: 0 }]);

		const evidenceOperationId = await begin(
			"qualification.public-corpus.evidence",
			"human",
			[
				{ kind: "source", id: sourceId, revision: source.audit.revision },
				{ kind: "document", id: documentId, revision: parsed.value.audit.revision },
				{ kind: "claim", id: claimId, revision: claim.audit.revision },
			],
			[parsed.value.parsedOutput],
		);
		const committed = await commitEvidenceCard(projectRoot, {
			operationId: evidenceOperationId,
			expectedManifestRevision: await revision(),
			validationMode: "strict",
			draft: {
				sourceId,
				documentId,
				evidenceLevel: "fulltext_located",
				locator: {
					locatorType: "paragraph",
					pageStart: block.pageNumber,
					pageEnd: block.pageNumber,
					sectionPath: block.sectionPath,
					label: block.blockId,
					charStart: block.charStart,
					charEnd: block.charEnd,
					anchorHash: block.anchorHash,
				},
				excerpt: block.text,
				excerptExactMatch: true,
				paraphrase: "NIST presents the AI RMF as a practical resource for managing AI risks.",
				evidenceStatement: "The located NIST text defines the intended risk-management role of the AI RMF.",
				claimLinks: [{ claimId, relation: "supports", rationale: "Human-reviewed located NIST text" }],
				confidence: { level: "high", basis: "Hash-pinned official PDF and exact parser locator", limitations: [] },
				rights: { excerptAllowed: true, maxStoredWords: 2_000, publicExportAllowed: true },
				humanStatus: "accepted",
				supersedesEvidenceId: null,
			},
			semanticProvenance: humanProvenance(evidenceOperationId),
		});
		if (!committed.ok) throw new Error(JSON.stringify(committed.errors));
		const evidenceId = committed.value.evidenceId;
		const linkedClaim = await linkEvidenceToClaim(
			projectRoot,
			evidenceOperationId,
			claimId,
			committed.value,
			"supports",
			"Human-reviewed located NIST text",
			false,
			humanProvenance(evidenceOperationId),
		);
		if (!linkedClaim.ok) throw new Error(JSON.stringify(linkedClaim.errors));
		await finish(evidenceOperationId, committed, [
			{ kind: "evidence", id: evidenceId, revision: committed.value.audit.revision },
			{ kind: "claim", id: claimId, revision: linkedClaim.value.audit.revision },
		]);

		const csvPath = join(temporaryDirectory, "risk-counts.csv");
		await writeFile(csvPath, "category,count\ngovern,4\nmap,3\nmeasure,3\nmanage,4\n");
		const datasetOperationId = await begin("qualification.public-corpus.dataset");
		const dataset = await importCsvDataset(projectRoot, {
			path: csvPath,
			title: "AI RMF function counts",
			sensitivity: "public",
			expectedManifestRevision: await revision(),
			operationId: datasetOperationId,
			sessionId: null,
		});
		if (!dataset.ok) throw new Error(JSON.stringify(dataset.errors));
		await finish(
			datasetOperationId,
			dataset,
			[
				{ kind: "dataset", id: dataset.value.dataset.datasetId, revision: 0 },
				...dataset.value.variables.map(({ variableId }) => ({
					kind: "variable" as const,
					id: variableId,
					revision: 0,
				})),
			],
			[dataset.value.dataset.sourceFile],
		);
		const scriptPath = join(temporaryDirectory, "summarize.py");
		await writeFile(
			scriptPath,
			`import csv, json, os\nwith open(json.loads(os.environ["PI_RESEARCH_INPUTS"])[0], newline="", encoding="utf-8") as handle:\n    rows = list(csv.DictReader(handle))\nwith open(os.path.join(os.environ["PI_RESEARCH_OUTPUT_DIR"], "summary.json"), "w", encoding="utf-8") as handle:\n    json.dump({"rows": len(rows), "total": sum(int(row["count"]) for row in rows)}, handle)\nwith open(os.path.join(os.environ["PI_RESEARCH_OUTPUT_DIR"], "analysis-status.json"), "w", encoding="utf-8") as handle:\n    json.dump({"status": "succeeded"}, handle)\n`,
		);
		const specificationOperationId = await begin("qualification.public-corpus.analysis-specification");
		const specification = await createAnalysisSpecification(projectRoot, {
			title: "Summarize AI RMF function fixture",
			protocolId: null,
			datasetIds: [dataset.value.dataset.datasetId],
			runtime: "python",
			scriptPath,
			environmentPath: null,
			parameters: null,
			randomSeed: 7,
			commandArguments: [],
			expectedOutputs: ["summary.json"],
			timeoutSeconds: 20,
			claimMode: "descriptive",
			expectedManifestRevision: await revision(),
			operationId: specificationOperationId,
			sessionId: null,
		});
		if (!specification.ok) throw new Error(JSON.stringify(specification.errors));
		await finish(specificationOperationId, specification, [
			{ kind: "analysis_specification", id: specification.value.specification.analysisSpecificationId, revision: 0 },
		]);
		const decisionOperationId = await begin("qualification.public-corpus.analysis-confirmation");
		const confirmed = await decideAnalysisSpecification(
			projectRoot,
			specification.value.specification.analysisSpecificationId,
			await revision(),
			0,
			"confirmed",
			"Confirmed public-corpus qualification",
			decisionOperationId,
		);
		if (!confirmed.ok) throw new Error(JSON.stringify(confirmed.errors));
		await finish(decisionOperationId, confirmed, [confirmed.value]);
		const confirmedRecord = await readRecord(
			projectRoot,
			"analysis_specification",
			specification.value.specification.analysisSpecificationId,
		);
		if (!confirmedRecord.ok || confirmedRecord.value.kind !== "analysis_specification") {
			throw new Error("Confirmed analysis specification is missing");
		}
		const runtime = await detectAnalysisRuntime("python");
		if (!runtime.available || runtime.executable === null) throw new Error("Python runtime is required");
		const analysisOperationId = await begin("qualification.public-corpus.analysis", "tool");
		const analysis = await executeAnalysis(projectRoot, confirmedRecord.value, analysisOperationId, {
			executable: runtime.executable,
		});
		await finish(
			analysisOperationId,
			analysis.result,
			analysis.task === null || analysis.run === null
				? []
				: [
						{ kind: "task", id: analysis.task.taskId, revision: 0 },
						{ kind: "analysis_run", id: analysis.run.analysisRunId, revision: 0 },
					],
			analysis.run === null ? [] : [...analysis.run.outputs, ...analysis.run.logs],
		);
		if (!analysis.result.ok || analysis.run === null) {
			const stderrLog = analysis.run?.logs.find(({ path }) => path.endsWith("/stderr.log"));
			const stderr =
				stderrLog === undefined
					? null
					: await readFile(await resolveProjectPath(projectRoot, stderrLog.path), "utf8");
			throw new Error(JSON.stringify({ errors: analysis.result.errors, stderr }));
		}

		const manuscriptOperationId = await begin("qualification.public-corpus.manuscript");
		const manuscript = await createManuscriptRevision(projectRoot, {
			title: "Auditable note on the NIST AI RMF",
			paperType: "conceptual",
			abstract: "A release qualification using a public-domain NIST technical publication.",
			bibliography: [{ citationKey: "nist2023", sourceId }],
			methodRecords: [{ kind: "analysis_run", id: analysis.run.analysisRunId, revision: 0 }],
			sections: [
				{
					sectionKey: "finding",
					title: "Finding",
					order: 0,
					content: `${claimText} [@nist2023]`,
					occurrences: [
						{
							claimId,
							text: claimText,
							charStart: 0,
							charEnd: claimText.length,
							core: true,
							citationKeys: ["nist2023"],
							evidenceIds: [evidenceId],
						},
					],
				},
			],
			supersedesManuscriptId: null,
			authoring: { origin: "human", provider: null, modelId: null },
			expectedManifestRevision: await revision(),
			operationId: manuscriptOperationId,
		});
		if (!manuscript.ok) throw new Error(JSON.stringify(manuscript.errors));
		await finish(manuscriptOperationId, manuscript, [
			{ kind: "manuscript", id: manuscript.value.manuscript.manuscriptId, revision: 0 },
			...manuscript.value.sections.map(({ sectionId }) => ({
				kind: "section" as const,
				id: sectionId,
				revision: 0,
			})),
			...manuscript.value.occurrences.map(({ claimOccurrenceId }) => ({
				kind: "claim_occurrence" as const,
				id: claimOccurrenceId,
				revision: 0,
			})),
		]);
		const reviewOperationId = await begin("qualification.public-corpus.review");
		const review = await recordReviewFindings(
			projectRoot,
			manuscript.value.manuscript.manuscriptId,
			[
				{
					reviewerRole: "editor",
					findingType: "deterministic_violation",
					severity: "P2",
					title: "Keep the scope bounded",
					message:
						"This qualification verifies workflow integrity, not the empirical effectiveness of the framework.",
					sectionId: manuscript.value.sections[0]!.sectionId,
					claimOccurrenceId: manuscript.value.occurrences[0]!.claimOccurrenceId,
				},
			],
			"deterministic",
			null,
			await revision(),
			reviewOperationId,
		);
		if (!review.ok) throw new Error(JSON.stringify(review.errors));
		await finish(
			reviewOperationId,
			review,
			review.value.map(({ reviewFindingId, audit: recordAudit }) => ({
				kind: "review_finding" as const,
				id: reviewFindingId,
				revision: recordAudit.revision,
			})),
		);

		const backup = await createProjectBackup(projectRoot, "Public-corpus workflow complete");
		const restoredRoot = join(temporaryDirectory, "restored");
		const restored = await restoreProjectBackup(projectRoot, backup.backupId, restoredRoot);
		expect(restored.compatibility).toBe("current");
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
		expect(await validateProject(restoredRoot)).toMatchObject({ valid: true, issues: [] });
		expect(parsedDocument.pageCount).toBeGreaterThan(0);
		expect(analysis.run.runtime.adapterId).toBe("local-python-strong_isolation");
	}, 120_000);
});
