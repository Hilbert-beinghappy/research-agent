import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLocalImport, type RawImportFile } from "../../src/adapters/import/local.ts";
import type {
	CitationVerification,
	ClaimRecord,
	DocumentRecord,
	EvidenceCard,
	FileRef,
	OperationRecord,
	RecordRef,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import { registerResearchTools } from "../../src/extension/tools.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../../src/kernel/integrity.ts";
import { resolveProjectPath } from "../../src/kernel/paths.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { listProjectRecordIds } from "../../src/project/record-index.ts";
import { createRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-artifacts-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Artifact fixture" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function manifestRevision(): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	return opened.manifest.revision;
}

async function projectFile(path: string, content: string, mediaType: string): Promise<FileRef> {
	const absolutePath = await resolveProjectPath(projectRoot, path);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content);
	return { path, hash: hashBytes(content), mediaType, bytes: Buffer.byteLength(content) };
}

interface OperationFixture {
	operationKind: "tool" | "adapter";
	name: string;
	inputs?: RecordRef[];
	inputFiles?: FileRef[];
	rawResponse?: FileRef | null;
	adapterId?: string;
}

async function persistOperation(input: OperationFixture): Promise<OperationRecord> {
	const operationId = createOpaqueId("operation");
	const now = new Date().toISOString();
	const operation: OperationRecord = {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId,
		taskId: null,
		operationKind: input.operationKind,
		name: input.name,
		implementationVersion: "0.1.0",
		status: "succeeded",
		session: null,
		actor: { type: input.operationKind, id: input.adapterId ?? input.name },
		modelExecution: null,
		adapterExecution:
			input.operationKind === "adapter"
				? {
						adapterId: input.adapterId ?? input.name,
						adapterVersion: "0.1.0",
						capabilitySnapshotHash: hashCanonicalJson({ fixture: input.name }),
					}
				: null,
		inputs: input.inputs ?? [],
		inputFiles: input.inputFiles ?? [],
		outputs: [],
		outputFiles: [],
		rawRequest: null,
		rawResponse: input.rawResponse ?? null,
		approvalIds: [],
		usage: {
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			networkRequests: input.operationKind === "adapter" ? 1 : 0,
			cost: { amount: 0, currency: "USD" },
		},
		error: null,
		startedAt: now,
		finishedAt: now,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const created = await createRecord(projectRoot, operation, {
		expectedManifestRevision: await manifestRevision(),
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	return operation;
}

async function persistRecord(
	record: SourceRecord | DocumentRecord | ClaimRecord | EvidenceCard | CitationVerification,
) {
	const created = await createRecord(projectRoot, record, {
		expectedManifestRevision: await manifestRevision(),
		operationId: record.audit.createdByOperationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
}

async function createSource(): Promise<SourceRecord> {
	const rawContent = '{"fixture":"source"}\n';
	const operationId = createOpaqueId("operation");
	const rawRecord = await projectFile(`.research/runs/${operationId}/source.json`, rawContent, "application/json");
	const now = new Date().toISOString();
	const operation: OperationRecord = {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId,
		taskId: null,
		operationKind: "adapter",
		name: "fixture.source",
		implementationVersion: "0.1.0",
		status: "succeeded",
		session: null,
		actor: { type: "adapter", id: "fixture" },
		modelExecution: null,
		adapterExecution: {
			adapterId: "fixture",
			adapterVersion: "0.1.0",
			capabilitySnapshotHash: hashCanonicalJson({ fixture: true }),
		},
		inputs: [],
		inputFiles: [],
		outputs: [],
		outputFiles: [],
		rawRequest: null,
		rawResponse: rawRecord,
		approvalIds: [],
		usage: {
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			networkRequests: 1,
			cost: { amount: 0, currency: "USD" },
		},
		error: null,
		startedAt: now,
		finishedAt: now,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const operationCreated = await createRecord(projectRoot, operation, {
		expectedManifestRevision: await manifestRevision(),
		operationId,
	});
	if (!operationCreated.ok) throw new Error(operationCreated.errors[0].message);
	const source: SourceRecord = {
		kind: "source",
		schemaVersion: "0.1.0",
		sourceId: createOpaqueId("source"),
		identifiers: [
			{
				scheme: "doi",
				value: "https://doi.org/10.5555/artifact.1",
				normalizedValue: "10.5555/artifact.1",
				verified: false,
				verificationId: null,
			},
		],
		title: "Evidence Boundaries in Public Management",
		titleNormalized: "evidence boundaries in public management",
		contributors: [{ family: "Chen", given: "Lin", literal: null, orcid: null }],
		issuedDate: "2025",
		containerTitle: "Journal of Synthetic Public Administration",
		publisher: "Fixture Press",
		sourceType: "journal-article",
		language: "en",
		abstractText: "restricted abstract fixture",
		abstractRights: "metadata_only",
		discovery: [
			{
				adapterId: "fixture",
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
			doi: "10.5555/artifact.1",
			strongIdentifier: "doi:10.5555/artifact.1",
			normalizedTitleYearFirstAuthor: "evidence boundaries in public management|2025|chen",
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
	await persistRecord(source);
	return source;
}

interface SeedOptions {
	located: boolean;
	verified: boolean;
	reviewed?: boolean;
}

async function seedClaimProject(options: SeedOptions) {
	const source = await createSource();
	let document: DocumentRecord | null = null;
	let inputFiles: FileRef[] = [];
	if (options.located) {
		const original = await projectFile(
			"sources/originals/artifact-fixture.pdf",
			"%PDF-artifact-fixture\n",
			"application/pdf",
		);
		const parsed = await projectFile(
			"sources/parsed/artifact-fixture.json",
			'{"fixture":"parsed table"}\n',
			"application/json",
		);
		const auditOperation = await persistOperation({ operationKind: "tool", name: "fixture.document" });
		const now = new Date().toISOString();
		document = {
			kind: "document",
			schemaVersion: "0.1.0",
			documentId: createOpaqueId("document"),
			sourceId: source.sourceId,
			acquisition: {
				method: "local_import",
				adapterId: null,
				origin: null,
				accessStatus: "user_provided",
				licenseExpression: null,
				termsReference: null,
				acquiredAt: now,
				approvalId: null,
			},
			localFile: original,
			originalFileName: "artifact-fixture.pdf",
			immutableOriginal: true,
			fullTextStatus: "parsed",
			textLayer: "present",
			parser: { id: "fixture", version: "0.1.0", optionsHash: hashCanonicalJson({ fixture: true }) },
			parsedOutput: parsed,
			pageCount: 1,
			parsedAt: now,
			warnings: [],
			failure: null,
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: auditOperation.operationId,
				updatedByOperationId: auditOperation.operationId,
			},
		};
		await persistRecord(document);
		inputFiles = [parsed];
	}
	const evidenceId = createOpaqueId("evidence");
	const claimId = createOpaqueId("claim");
	const extraction = await persistOperation({
		operationKind: "tool",
		name: "fixture.evidence",
		inputs: [
			{ kind: "source", id: source.sourceId, revision: source.audit.revision },
			...(document === null
				? []
				: [{ kind: "document" as const, id: document.documentId, revision: document.audit.revision }]),
		],
		inputFiles,
	});
	const now = new Date().toISOString();
	const claim: ClaimRecord = {
		kind: "claim",
		schemaVersion: "0.1.0",
		claimId,
		text: "Evidence boundaries improve the auditability of public management research.",
		claimType: "methodological",
		scope: "Synthetic public-management fixture",
		evidenceLinks: [{ evidenceId, relation: "supports", assessment: "Fixture evidence" }],
		supportStatus: "supported",
		conflictEvidenceIds: [],
		humanConfirmation:
			options.reviewed === false
				? { status: "not_reviewed", decidedAt: null, note: null }
				: { status: "accepted", decidedAt: now, note: "Fixture decision" },
		publishability: "exploratory",
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: extraction.operationId,
			updatedByOperationId: extraction.operationId,
		},
	};
	const evidence: EvidenceCard = {
		kind: "evidence",
		schemaVersion: "0.1.0",
		evidenceId,
		sourceId: source.sourceId,
		documentId: document?.documentId ?? null,
		evidenceLevel: options.located ? "table_or_figure_located" : "metadata",
		locator: options.located
			? {
					locatorType: "table",
					pageStart: 1,
					pageEnd: 1,
					sectionPath: ["Results"],
					label: "Table 1",
					charStart: null,
					charEnd: null,
					anchorHash: hashBytes("artifact-table-1"),
				}
			: null,
		excerpt: options.located ? null : source.title,
		excerptExactMatch: options.located ? null : true,
		paraphrase: "The fixture illustrates an auditable evidence boundary.",
		evidenceStatement: "The evidence boundary is explicitly located and auditable.",
		claimLinks: [{ claimId, relation: "supports", rationale: "Fixture link" }],
		extraction: {
			method: "deterministic",
			operationId: extraction.operationId,
			modelProvider: null,
			modelId: null,
			promptHash: null,
		},
		confidence: { level: "high", basis: "Synthetic fixture", limitations: [] },
		rights: { excerptAllowed: true, maxStoredWords: 100, publicExportAllowed: true },
		humanStatus: "accepted",
		validity: "active",
		supersedesEvidenceId: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: extraction.operationId,
			updatedByOperationId: extraction.operationId,
		},
	};
	await persistRecord(claim);
	await persistRecord(evidence);

	if (options.verified) {
		const providerOperationId = createOpaqueId("operation");
		const rawResponse = await projectFile(
			`.research/runs/${providerOperationId}/crossref.json`,
			'{"fixture":"verified"}\n',
			"application/json",
		);
		const providerNow = new Date().toISOString();
		const provider: OperationRecord = {
			kind: "operation",
			schemaVersion: "0.1.0",
			operationId: providerOperationId,
			taskId: null,
			operationKind: "adapter",
			name: "crossref.lookup",
			implementationVersion: "0.1.0",
			status: "succeeded",
			session: null,
			actor: { type: "adapter", id: "crossref" },
			modelExecution: null,
			adapterExecution: {
				adapterId: "crossref",
				adapterVersion: "0.1.0",
				capabilitySnapshotHash: hashCanonicalJson({ adapter: "crossref" }),
			},
			inputs: [{ kind: "source", id: source.sourceId, revision: source.audit.revision }],
			inputFiles: [],
			outputs: [],
			outputFiles: [],
			rawRequest: null,
			rawResponse,
			approvalIds: [],
			usage: {
				inputTokens: null,
				outputTokens: null,
				cacheReadTokens: null,
				cacheWriteTokens: null,
				networkRequests: 1,
				cost: { amount: 0, currency: "USD" },
			},
			error: null,
			startedAt: providerNow,
			finishedAt: providerNow,
			audit: {
				createdAt: providerNow,
				updatedAt: providerNow,
				revision: 0,
				createdByOperationId: providerOperationId,
				updatedByOperationId: providerOperationId,
			},
		};
		const providerCreated = await createRecord(projectRoot, provider, {
			expectedManifestRevision: await manifestRevision(),
			operationId: providerOperationId,
		});
		if (!providerCreated.ok) throw new Error(providerCreated.errors[0].message);
		const verifier = await persistOperation({
			operationKind: "tool",
			name: "research.verify_citations",
			inputs: [{ kind: "source", id: source.sourceId, revision: source.audit.revision }],
		});
		const verificationId = createOpaqueId("citation_verification");
		const verification: CitationVerification = {
			kind: "citation_verification",
			schemaVersion: "0.1.0",
			verificationId,
			sourceId: source.sourceId,
			citationKey: source.sourceId,
			identifiers: source.identifiers.map((identifier) => ({
				...identifier,
				verified: true,
				verificationId,
			})),
			verificationSources: [
				{
					adapterId: "crossref",
					adapterVersion: "0.1.0",
					checkedAt: providerNow,
					rawRecord: rawResponse,
					operationId: providerOperationId,
				},
			],
			fieldChecks: [
				{
					field: "identifier",
					expected: "10.5555/artifact.1",
					observed: "10.5555/artifact.1",
					status: "match",
					sourceAdapterId: "crossref",
				},
			],
			publicationStatus: "normal",
			conflicts: [],
			finalStatus: "verified",
			verifiedAt: new Date().toISOString(),
			expiresAt: "2099-01-01T00:00:00.000Z",
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: verifier.operationId,
				updatedByOperationId: verifier.operationId,
			},
		};
		await persistRecord(verification);
	}

	return {
		source,
		claim,
		claimRef: { kind: "claim" as const, id: claim.claimId, revision: claim.audit.revision },
	};
}

function createHarness(hasUI = true) {
	const tools = new Map<string, ToolDefinition>();
	const confirm = vi.fn(async () => true);
	const pi = {
		registerTool(tool: ToolDefinition): void {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerResearchTools(pi, {
		version: "0.1.0",
		async requireProject() {
			const opened = await openProject(projectRoot);
			if (opened.compatibility !== "current") throw new Error("Expected current project");
			return opened;
		},
		appendProjectLink(): void {},
	});
	const context = {
		cwd: projectRoot,
		hasUI,
		mode: "tui",
		model: { provider: "deepseek", id: "deepseek-v4-flash" },
		signal: new AbortController().signal,
		ui: { confirm, notify: vi.fn(), select: vi.fn(), setStatus: vi.fn() },
		sessionManager: {
			getSessionId: () => "artifact-session",
			getSessionFile: () => join(projectRoot, "session.jsonl"),
			getEntries: () => [],
		},
	} as unknown as ExtensionContext;
	return { tools, confirm, context };
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}

async function callArtifacts(
	harness: ReturnType<typeof createHarness>,
	params: object,
): Promise<Record<string, unknown>> {
	const tool = harness.tools.get("research_artifacts");
	if (tool === undefined) throw new Error("Missing research_artifacts tool");
	const result = await tool.execute("artifact-call", params, undefined, undefined, harness.context);
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("Artifact tool did not return JSON text");
	return object(JSON.parse(content.text));
}

function artifactFromResult(result: Record<string, unknown>): Record<string, unknown> {
	return object(object(result.value).artifact);
}

async function artifactContent(artifact: Record<string, unknown>): Promise<string> {
	const output = object(artifact.outputFile);
	if (typeof output.path !== "string") throw new Error("Artifact has no output path");
	return readFile(join(projectRoot, ...output.path.split("/")), "utf8");
}

function rawImport(format: "ris" | "bibtex", content: string, file: FileRef): RawImportFile {
	return {
		inputIndex: 0,
		originalFileName: format === "ris" ? "sources.ris" : "sources.bib",
		format,
		mode: "copy",
		contentHash: hashBytes(content),
		bytes: Buffer.byteLength(content),
		mediaType: file.mediaType ?? "text/plain",
		storedFile: file,
		referencePath: null,
		portable: true,
	};
}

describe("research artifacts", () => {
	it("renders deterministic JSON, RIS, and BibTeX and reuses identical exports", async () => {
		const source = await createSource();
		const sourceRef = { kind: "source" as const, id: source.sourceId, revision: source.audit.revision };
		const harness = createHarness();
		const jsonParams = {
			action: "generate_structured",
			artifactType: "json",
			sourceRefs: [sourceRef],
			targetStatus: "exploratory",
		};
		const first = await callArtifacts(harness, jsonParams);
		expect(first).toMatchObject({ ok: true, value: { reused: false, artifact: { publishability: "exploratory" } } });
		const firstArtifact = artifactFromResult(first);
		expect(firstArtifact.sourceFiles).toEqual([
			expect.objectContaining({ path: expect.stringContaining("/source.json") }),
		]);
		const firstContent = await artifactContent(firstArtifact);
		expect(firstContent).toContain("Evidence Boundaries in Public Management");
		expect(firstContent).not.toContain("restricted abstract fixture");
		const repeated = await callArtifacts(harness, jsonParams);
		expect(repeated).toMatchObject({
			ok: true,
			value: { reused: true, artifact: { artifactId: firstArtifact.artifactId } },
		});
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		expect(await listProjectRecordIds(opened.root, opened.manifest, "artifact")).toHaveLength(1);

		for (const artifactType of ["ris", "bibtex"] as const) {
			const generated = await callArtifacts(harness, {
				action: "generate_structured",
				artifactType,
				sourceRefs: [sourceRef],
				targetStatus: "exploratory",
			});
			expect(generated).toMatchObject({ ok: true, value: { artifact: { artifactKind: artifactType } } });
			const artifact = artifactFromResult(generated);
			const content = await artifactContent(artifact);
			const outputFile = object(artifact.outputFile) as FileRef;
			const parsed = parseLocalImport(rawImport(artifactType, content, outputFile), Buffer.from(content));
			expect(parsed.sourceCandidates[0]?.metadata).toMatchObject({
				title: "Evidence Boundaries in Public Management",
				DOI: "10.5555/artifact.1",
			});
		}
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
		if (!Array.isArray(firstArtifact.sourceFiles)) throw new Error("Artifact has no source files");
		const firstSourceFile = object(firstArtifact.sourceFiles[0]);
		if (typeof firstSourceFile.path !== "string") throw new Error("Artifact source file has no path");
		await writeFile(join(projectRoot, ...firstSourceFile.path.split("/")), '{"fixture":"tampered"}\n');
		const validation = await callArtifacts(harness, {
			action: "validate",
			artifactType: "json",
			sourceRefs: [{ kind: "artifact", id: firstArtifact.artifactId, revision: 0 }],
			targetStatus: "exploratory",
		});
		expect(validation).toMatchObject({
			ok: true,
			value: {
				artifact: { validation: { status: "failed" } },
				blockers: [expect.objectContaining({ name: "artifact_input_file_integrity", status: "failed" })],
			},
		});
	});

	it("writes a blocked review when core claims lack located and verified evidence", async () => {
		const seeded = await seedClaimProject({ located: false, verified: false });
		const harness = createHarness();
		const result = await callArtifacts(harness, {
			action: "commit_markdown",
			artifactType: "review",
			content: "# Review\n\nA draft claim.",
			sourceRefs: [seeded.claimRef],
			targetStatus: "submission_candidate",
		});
		expect(result).toMatchObject({
			ok: true,
			value: {
				artifact: { publishability: "blocked", validation: { status: "failed" } },
			},
		});
		expect(harness.confirm).not.toHaveBeenCalled();
		const blockers = object(result.value).blockers;
		expect(JSON.stringify(blockers)).toContain("located_evidence");
		expect(JSON.stringify(blockers)).toContain("citation_verification");
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	});

	it("blocks submission confirmation when no interactive UI is available", async () => {
		const seeded = await seedClaimProject({ located: true, verified: true });
		const harness = createHarness(false);
		const result = await callArtifacts(harness, {
			action: "commit_markdown",
			artifactType: "review",
			content: "# Review\n\nEvidence-checked synthesis.",
			sourceRefs: [seeded.claimRef],
			targetStatus: "submission_candidate",
		});
		expect(result).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "APPROVAL_REQUIRED" }],
		});
		expect(harness.confirm).not.toHaveBeenCalled();
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		expect(await listProjectRecordIds(opened.root, opened.manifest, "artifact")).toHaveLength(0);
	});

	it("requires final confirmation and approval before replacing a fixed artifact path", async () => {
		const seeded = await seedClaimProject({ located: true, verified: true, reviewed: false });
		const harness = createHarness();
		const outputPath = "artifacts/final/review.md";
		const submitted = await callArtifacts(harness, {
			action: "commit_markdown",
			artifactType: "review",
			content: "# Review v1\n\nEvidence-checked synthesis.",
			sourceRefs: [seeded.claimRef],
			targetStatus: "submission_candidate",
			outputPath,
		});
		expect(submitted).toMatchObject({
			ok: true,
			value: { artifact: { publishability: "submission_candidate", validation: { status: "passed" } } },
		});
		expect(harness.confirm).toHaveBeenCalledTimes(1);
		expect(harness.confirm).toHaveBeenNthCalledWith(
			1,
			"Confirm submission candidate",
			expect.stringContaining("has not been individually reviewed"),
		);
		const submittedArtifact = artifactFromResult(submitted);
		const repeated = await callArtifacts(harness, {
			action: "commit_markdown",
			artifactType: "review",
			content: "# Review v1\n\nEvidence-checked synthesis.",
			sourceRefs: [seeded.claimRef],
			targetStatus: "submission_candidate",
			outputPath,
		});
		expect(repeated).toMatchObject({
			ok: true,
			value: { reused: true, artifact: { artifactId: submittedArtifact.artifactId } },
		});
		expect(harness.confirm).toHaveBeenCalledTimes(2);
		const validated = await callArtifacts(harness, {
			action: "validate",
			artifactType: "review",
			sourceRefs: [{ kind: "artifact", id: submittedArtifact.artifactId, revision: 0 }],
			targetStatus: "submission_candidate",
		});
		expect(validated).toMatchObject({ ok: true, value: { artifact: { validation: { status: "passed" } } } });

		const replaced = await callArtifacts(harness, {
			action: "commit_markdown",
			artifactType: "review",
			content: "# Review v2\n\nRevised evidence-checked synthesis.",
			sourceRefs: [seeded.claimRef],
			targetStatus: "evidence_checked",
			outputPath,
		});
		expect(replaced).toMatchObject({
			ok: true,
			value: {
				artifact: {
					publishability: "evidence_checked",
					supersedesArtifactId: submittedArtifact.artifactId,
				},
			},
		});
		expect(harness.confirm).toHaveBeenCalledTimes(3);
		expect(await readFile(join(projectRoot, ...outputPath.split("/")), "utf8")).toContain("Review v2");

		harness.confirm.mockResolvedValueOnce(false);
		const denied = await callArtifacts(harness, {
			action: "commit_markdown",
			artifactType: "review",
			content: "# Review v3\n\nThis overwrite must be denied.",
			sourceRefs: [seeded.claimRef],
			targetStatus: "evidence_checked",
			outputPath,
		});
		expect(denied).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "ACTION_DENIED" }],
		});
		expect(harness.confirm).toHaveBeenCalledTimes(4);
		expect(await readFile(join(projectRoot, ...outputPath.split("/")), "utf8")).toContain("Review v2");
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	});
});
