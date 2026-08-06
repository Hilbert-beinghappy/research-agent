import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OperationRecord, ResearchProjectManifest } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes } from "../../src/kernel/integrity.ts";
import { operationTransitionPatch } from "../../src/kernel/operations.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";
import { importSourceFiles } from "../../src/tools/import-sources.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "fixtures", "imports");

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-imports-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Import fixture project" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function currentManifest(): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	return opened.manifest;
}

async function runningOperation(): Promise<{ operationId: string; revision: number }> {
	const operationId = createOpaqueId("operation");
	const now = new Date().toISOString();
	const operation: OperationRecord = {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId,
		taskId: null,
		operationKind: "tool",
		name: "research.import-sources",
		implementationVersion: "0.1.0",
		status: "planned",
		session: null,
		actor: { type: "tool", id: "research_import_sources" },
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
	let manifest = await currentManifest();
	const created = await createRecord(projectRoot, operation, {
		expectedManifestRevision: manifest.revision,
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	manifest = await currentManifest();
	const loaded = await readRecord(projectRoot, "operation", operationId);
	if (!loaded.ok || loaded.value.kind !== "operation") throw new Error("expected import operation");
	const running = await updateRecord(projectRoot, "operation", operationId, {
		expectedManifestRevision: manifest.revision,
		expectedRecordRevision: 0,
		operationId,
		changes: operationTransitionPatch(loaded.value, "running"),
	});
	if (!running.ok) throw new Error(running.errors[0].message);
	return { operationId, revision: (await currentManifest()).revision };
}

describe("local source imports", () => {
	it("copies RIS, BibTeX, CSL-JSON, and PDF inputs into content-addressed project storage", async () => {
		const operation = await runningOperation();
		const result = await importSourceFiles(projectRoot, {
			inputs: [
				{ path: join(fixtureDirectory, "library.ris"), format: "auto", mode: "copy" },
				{ path: join(fixtureDirectory, "library.bib"), format: "bibtex", mode: "copy" },
				{ path: join(fixtureDirectory, "library.json"), format: "csl-json", mode: "copy" },
				{ path: join(fixtureDirectory, "local.pdf"), format: "pdf", mode: "copy" },
			],
			operationId: operation.operationId,
			sessionId: "import-fixture-session",
			expectedManifestRevision: operation.revision,
		});
		expect(result).toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				rawInputs: [
					{ format: "ris", mode: "copy", portable: true },
					{ format: "bibtex", mode: "copy", portable: true },
					{ format: "csl-json", mode: "copy", portable: true },
					{ format: "pdf", mode: "copy", portable: true },
				],
				sourceCandidates: [
					{ metadata: { DOI: "10.5555/transparency.1" }, metadataStatus: "provided" },
					{ metadata: { DOI: "10.5555/transparency.1" }, metadataStatus: "provided" },
					{ metadata: { title: "Public Sector AI Accountability" }, metadataStatus: "provided" },
					{ metadata: { DOI: "10.5555/platform.1" }, metadataStatus: "provided" },
					{
						format: "pdf",
						metadata: null,
						metadataStatus: "missing",
						requiresBibliographicMatch: true,
					},
				],
				documentCandidates: [
					{
						originalFileName: "local.pdf",
						portable: true,
						immutableOriginal: true,
						fullTextStatus: "acquired_unparsed",
						textLayer: "unknown",
						acquisition: { accessStatus: "user_provided", licenseExpression: null },
					},
				],
				manifestRevision: operation.revision + 4,
			},
		});
		if (!result.ok) throw new Error(result.errors[0].message);
		for (const input of result.value.rawInputs) {
			if (input.storedFile === null) throw new Error("expected copied raw input");
			const stored = await readFile(join(projectRoot, input.storedFile.path));
			expect(hashBytes(stored)).toEqual(input.contentHash);
		}
		const pdf = result.value.rawInputs.find(({ format }) => format === "pdf");
		if (pdf?.storedFile === null || pdf === undefined) throw new Error("expected copied PDF");
		expect((await stat(join(projectRoot, pdf.storedFile.path))).mode & 0o222).toBe(0);
		const manifest = await currentManifest();
		expect(manifest.recordSets.find(({ kind }) => kind === "source")?.count).toBe(0);
		expect(manifest.recordSets.find(({ kind }) => kind === "document")?.count).toBe(0);
		await expect(
			importSourceFiles(projectRoot, {
				inputs: [{ path: join(fixtureDirectory, "library.ris"), format: "ris", mode: "reference" }],
				operationId: operation.operationId,
				sessionId: null,
				expectedManifestRevision: operation.revision,
			}),
		).resolves.toMatchObject({
			ok: false,
			status: "DATA_CONFLICT",
			errors: [{ code: "IMPORT_REVISION_CONFLICT" }],
		});
	});

	it("keeps successful reference imports when another input cannot be decoded", async () => {
		const invalid = join(temporaryDirectory, "invalid.bib");
		await writeFile(invalid, Uint8Array.from([0xff, 0xfe, 0xfd]));
		const operation = await runningOperation();
		const result = await importSourceFiles(projectRoot, {
			inputs: [
				{ path: join(fixtureDirectory, "library.ris"), format: "ris", mode: "reference" },
				{ path: invalid, format: "bibtex", mode: "reference" },
			],
			operationId: operation.operationId,
			sessionId: null,
			expectedManifestRevision: operation.revision,
		});
		expect(result).toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: {
				rawInputs: [
					{ format: "ris", storedFile: null, portable: false },
					{ format: "bibtex", storedFile: null, portable: false },
				],
				sourceCandidates: [{ metadata: { DOI: "10.5555/transparency.1" } }],
				documentCandidates: [],
				manifestRevision: operation.revision,
			},
			errors: [{ code: "IMPORT_PARSE_FAILED", category: "parse", details: { inputIndex: 1 } }],
		});
	});

	it("stores identical PDFs once and never derives bibliography from their filenames", async () => {
		const first = join(temporaryDirectory, "descriptive-title.pdf");
		const second = join(temporaryDirectory, "different-title.pdf");
		await Promise.all([
			copyFile(join(fixtureDirectory, "local.pdf"), first),
			copyFile(join(fixtureDirectory, "local.pdf"), second),
		]);
		const operation = await runningOperation();
		const result = await importSourceFiles(projectRoot, {
			inputs: [
				{ path: first, format: "auto", mode: "copy" },
				{ path: second, format: "auto", mode: "copy" },
			],
			operationId: operation.operationId,
			sessionId: null,
			expectedManifestRevision: operation.revision,
		});
		expect(result).toMatchObject({ ok: true, value: { manifestRevision: operation.revision + 1 } });
		if (!result.ok) throw new Error(result.errors[0].message);
		expect(result.value.rawInputs[0].storedFile?.path).toBe(result.value.rawInputs[1].storedFile?.path);
		expect(result.value.sourceCandidates).toHaveLength(2);
		expect(result.value.sourceCandidates.every(({ metadata }) => metadata === null)).toBe(true);
		expect(new Set(result.value.sourceCandidates.map(({ candidateKey }) => candidateKey)).size).toBe(1);
		expect(new Set(result.value.documentCandidates.map(({ candidateKey }) => candidateKey)).size).toBe(1);
	});
});
