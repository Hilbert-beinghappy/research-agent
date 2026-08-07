import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	DocumentRecord,
	FileRef,
	HashValue,
	OperationRecord,
	ResearchProjectManifest,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import { type ParsedPdfDocument, parsePdfBytes } from "../../src/documents/pdf-parser.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashFile } from "../../src/kernel/integrity.ts";
import { operationTransitionPatch } from "../../src/kernel/operations.ts";
import { resolveProjectPath } from "../../src/kernel/paths.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, readRecord, updateRecord } from "../../src/project/records.ts";
import { brokerProjectFile } from "../../src/security/broker-files.ts";
import { parseDocument } from "../../src/tools/documents.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures", "documents");
const timestamp = "2026-08-06T00:00:00.000Z";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-pdf-parser-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "PDF parser" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function manifest(): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	return opened.manifest;
}

function operationRecord(operationId: string, name: string): OperationRecord {
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
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

async function createRunningOperation(name: string): Promise<string> {
	const operationId = createOpaqueId("operation");
	const created = await createRecord(projectRoot, operationRecord(operationId, name), {
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

function sourceRecord(sourceId: string, operationId: string, original: FileRef): SourceRecord {
	return {
		kind: "source",
		schemaVersion: "0.1.0",
		sourceId,
		identifiers: [],
		title: "Synthetic PDF fixture",
		titleNormalized: "synthetic pdf fixture",
		contributors: [],
		issuedDate: null,
		containerTitle: null,
		publisher: null,
		sourceType: "document",
		language: "en",
		abstractText: null,
		abstractRights: "unknown",
		discovery: [
			{
				adapterId: "local-fixture",
				adapterVersion: "0.1.0",
				queryText: null,
				queryHash: null,
				discoveredAt: timestamp,
				rank: null,
				rawRecord: original,
				requestOperationId: operationId,
			},
		],
		dedupKeys: {
			doi: null,
			strongIdentifier: null,
			normalizedTitleYearFirstAuthor: null,
			contentHash: original.hash?.value ?? null,
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

async function createDocument(name: string): Promise<DocumentRecord> {
	const bytes = new Uint8Array(await readFile(join(fixtures, name)));
	const operationId = await createRunningOperation(`fixture.import.${name}`);
	const hash = hashBytes(bytes);
	const path = `sources/originals/${hash.value}.pdf`;
	let storedHash: HashValue | null = null;
	try {
		storedHash = await hashFile(await resolveProjectPath(projectRoot, path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (storedHash === null) {
		const stored = await brokerProjectFile(projectRoot, {
			operationId,
			sessionId: null,
			expectedManifestRevision: (await manifest()).revision,
			path,
			content: bytes,
			dataClasses: ["user_provided_document"],
		});
		if (!stored.ok) throw new Error(stored.errors[0].message);
	} else if (storedHash.value !== hash.value) {
		throw new Error("fixture content-addressed path conflict");
	}
	const original: FileRef = { path, hash, mediaType: "application/pdf", bytes: bytes.byteLength };
	const sourceId = createOpaqueId("source");
	const source = await createRecord(projectRoot, sourceRecord(sourceId, operationId, original), {
		expectedManifestRevision: (await manifest()).revision,
		operationId,
	});
	if (!source.ok) throw new Error(source.errors[0].message);
	const documentId = createOpaqueId("document");
	const document: DocumentRecord = {
		kind: "document",
		schemaVersion: "0.1.0",
		documentId,
		sourceId,
		acquisition: {
			method: "local_import",
			adapterId: "local-fixture",
			origin: name,
			accessStatus: "user_provided",
			licenseExpression: null,
			termsReference: null,
			acquiredAt: timestamp,
			approvalId: null,
		},
		localFile: original,
		originalFileName: name,
		immutableOriginal: true,
		fullTextStatus: "acquired_unparsed",
		textLayer: "unknown",
		parser: null,
		parsedOutput: null,
		pageCount: null,
		parsedAt: null,
		warnings: [],
		failure: null,
		audit: {
			createdAt: timestamp,
			updatedAt: timestamp,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const created = await createRecord(projectRoot, document, {
		expectedManifestRevision: (await manifest()).revision,
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	return document;
}

async function parse(document: DocumentRecord, maxBytes = 1_000_000, maxPages = 10) {
	const operationId = await createRunningOperation("document.parse");
	return parseDocument(projectRoot, {
		documentId: document.documentId,
		operationId,
		sessionId: null,
		expectedDocumentRevision: document.audit.revision,
		options: { maxBytes, maxPages },
	});
}

function pdfLiteral(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function nestedScriptPdf(script: string): Uint8Array {
	const content = "BT /F1 12 Tf 72 720 Td (Safe hostile PDF regression fixture with a usable text layer.) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (let index = 0; index < 64; index += 1) {
		const nextObject = index === 63 ? "" : ` /Next ${index + 7} 0 R`;
		objects.push(
			`<< /Type /Action /S /JavaScript /JS (${pdfLiteral(index === 0 ? script : "void(0)")})${nextObject} >>`,
		);
	}
	const encoder = new TextEncoder();
	let body = "%PDF-1.7\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(encoder.encode(body).byteLength);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xrefOffset = encoder.encode(body).byteLength;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	body += offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("");
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return encoder.encode(body);
}

describe("project PDF parsing", () => {
	it("stores deterministic parsed text and records parser provenance", async () => {
		const document = await createDocument("text-layer.pdf");
		const result = await parse(document);
		expect(result).toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				fullTextStatus: "parsed",
				textLayer: "present",
				pageCount: 2,
				parser: { id: "pdfjs-dist", version: "6.2.108" },
				parsedOutput: { mediaType: "application/json" },
				failure: null,
			},
		});
		if (!result.ok || result.value.parsedOutput === null) throw new Error("expected parsed document");
		const outputPath = await resolveProjectPath(projectRoot, result.value.parsedOutput.path);
		expect((await hashFile(outputPath)).value).toBe(result.value.parsedOutput.hash?.value);
		const output = JSON.parse(await readFile(outputPath, "utf8")) as ParsedPdfDocument;
		expect(output).toMatchObject({
			documentId: document.documentId,
			textLayer: "present",
			pages: [
				{ pageNumber: 1, blocks: [{ sectionPath: ["Introduction"] }] },
				{ pageNumber: 2, blocks: [{ sectionPath: ["Methods"] }] },
			],
		});
		const reopened = await openProject(projectRoot);
		expect(reopened.compatibility).toBe("current");
	});

	it("persists OCR, partial text, and parse failures as distinct states", async () => {
		const cases = [
			["scanned.pdf", 1_000_000, 10, "ocr_required", "absent", "PDF_OCR_REQUIRED", true],
			["partial-text-layer.pdf", 1_000_000, 10, "parsed_with_warnings", "partial", "PDF_TEXT_LAYER_PARTIAL", true],
			["encrypted.pdf", 1_000_000, 10, "parse_failed", "unknown", "PDF_ENCRYPTED", false],
			["corrupt.pdf", 1_000_000, 10, "parse_failed", "unknown", "PDF_INVALID", false],
			["text-layer.pdf", 16, 10, "parse_failed", "unknown", "PDF_TOO_LARGE", false],
			["text-layer.pdf", 1_000_000, 1, "parse_failed", "unknown", "PDF_PAGE_LIMIT_EXCEEDED", false],
		] as const;
		for (const [name, maxBytes, maxPages, status, textLayer, code, hasOutput] of cases) {
			const document = await createDocument(name);
			const result = await parse(document, maxBytes, maxPages);
			expect(result, name).toMatchObject({
				ok: true,
				status: "PARTIAL_SUCCESS",
				value: {
					fullTextStatus: status,
					textLayer,
					failure: { code },
				},
				errors: [{ code }],
			});
			if (!result.ok) throw new Error(result.errors[0].message);
			expect(result.value.parsedOutput !== null, name).toBe(hasOutput);
		}
	}, 15_000);

	it("quarantines an original whose bytes no longer match its content hash", async () => {
		const document = await createDocument("text-layer.pdf");
		if (document.localFile === null) throw new Error("expected local file");
		const path = await resolveProjectPath(projectRoot, document.localFile.path);
		const bytes = await readFile(path);
		bytes[100] = (bytes[100] ?? 0) ^ 1;
		await chmod(path, 0o644);
		await writeFile(path, bytes);
		const result = await parse(document);
		expect(result).toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: {
				fullTextStatus: "quarantined",
				parsedOutput: null,
				failure: { code: "PDF_ORIGINAL_INTEGRITY_FAILED" },
			},
			errors: [{ code: "PDF_ORIGINAL_INTEGRITY_FAILED" }],
		});
	});

	it("disables scripting while parsing nested JavaScript actions without host side effects", async () => {
		const fileSentinel = join(temporaryDirectory, "pdf-script-file");
		const subprocessSentinel = join(temporaryDirectory, "pdf-script-process");
		const subprocessCode = `require("node:fs").writeFileSync(${JSON.stringify(subprocessSentinel)}, "spawned")`;
		const script = [
			"globalThis.__doroPdfScriptExecuted = true",
			'try { fetch("https://pdf-script.invalid/") } catch (error) {}',
			`try { process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(fileSentinel)}, "written") } catch (error) {}`,
			`try { process.getBuiltinModule("node:child_process").execFileSync(process.execPath, ["-e", ${JSON.stringify(subprocessCode)}]) } catch (error) {}`,
		].join(";");
		const bytes = nestedScriptPdf(script);
		let networkRequests = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() => {
			networkRequests += 1;
			return Promise.reject(new Error("PDF script attempted network access"));
		}) as typeof fetch;
		try {
			const result = await parsePdfBytes({
				documentId: "document_hostile_pdf",
				sourceContentHash: hashBytes(bytes),
				bytes,
				operationId: "operation_hostile_pdf",
				options: { maxBytes: 1_000_000, maxPages: 10 },
			});
			expect(result).toMatchObject({
				ok: false,
				status: "PERMANENT_FAILURE",
				errors: [{ code: "PDF_SCRIPTING_FORBIDDEN", category: "validation" }],
			});
		} finally {
			globalThis.fetch = originalFetch;
			Reflect.deleteProperty(globalThis, "__doroPdfScriptExecuted");
		}
		expect(networkRequests).toBe(0);
		expect(Reflect.get(globalThis, "__doroPdfScriptExecuted")).toBeUndefined();
		await expect(readFile(fileSentinel)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(subprocessSentinel)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
