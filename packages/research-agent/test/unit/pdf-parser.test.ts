import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePdfBytes } from "../../src/documents/pdf-parser.ts";
import { hashBytes } from "../../src/kernel/integrity.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures", "documents");
const operationId = "operation-pdf-parser-fixture";

async function parseFixture(name: string, maxBytes = 1_000_000, maxPages = 10) {
	const bytes = new Uint8Array(await readFile(join(fixtures, name)));
	return parsePdfBytes({
		documentId: `document-${name}`,
		sourceContentHash: hashBytes(bytes),
		bytes,
		operationId,
		options: { maxBytes, maxPages },
	});
}

describe("PDF text parser", () => {
	it("produces deterministic page and section blocks with stable offsets", async () => {
		const first = await parseFixture("text-layer.pdf");
		const second = await parseFixture("text-layer.pdf");
		expect(first).toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				formatVersion: "0.1.0",
				textLayer: "present",
				pageCount: 2,
				parser: { id: "pdfjs-dist", version: "6.2.108" },
				pages: [
					{ pageNumber: 1, blocks: [{ blockId: "p1-b1", sectionPath: ["Introduction"] }] },
					{ pageNumber: 2, blocks: [{ blockId: "p2-b1", sectionPath: ["Methods"] }] },
				],
			},
		});
		if (!first.ok || !second.ok) throw new Error("expected parsed PDF");
		expect(second.value).toEqual(first.value);
		for (const page of first.value.pages) {
			expect(first.value.text.slice(page.charStart, page.charEnd)).toBe(page.text);
			for (const block of page.blocks) {
				expect(first.value.text.slice(block.charStart, block.charEnd)).toBe(block.text);
			}
		}
		expect(first.value.text).toContain("Collaborative governance improves service coordination.");
		expect(first.value.text).toContain("All values in this fixture are synthetic.");
	});

	it("distinguishes absent and partial text layers without inventing OCR text", async () => {
		const scanned = await parseFixture("scanned.pdf");
		expect(scanned).toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: { textLayer: "absent", pageCount: 1, text: "", pages: [{ text: "", blocks: [] }] },
			errors: [{ code: "PDF_OCR_REQUIRED" }],
		});

		const partial = await parseFixture("partial-text-layer.pdf");
		expect(partial).toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: {
				textLayer: "partial",
				pageCount: 2,
				pages: [{ text: "Results\nThe first page has a reliable text layer." }, { text: "", blocks: [] }],
			},
			errors: [{ code: "PDF_TEXT_LAYER_PARTIAL" }],
		});
	});

	it("classifies encrypted, corrupt, oversized, and over-page-limit inputs", async () => {
		const encrypted = await parseFixture("encrypted.pdf");
		expect(encrypted).toMatchObject({ ok: false, errors: [{ code: "PDF_ENCRYPTED", category: "parse" }] });

		const corrupt = await parseFixture("corrupt.pdf");
		expect(corrupt).toMatchObject({ ok: false, errors: [{ code: "PDF_INVALID", category: "parse" }] });

		const oversized = await parseFixture("text-layer.pdf", 16);
		expect(oversized).toMatchObject({ ok: false, errors: [{ code: "PDF_TOO_LARGE", category: "validation" }] });

		const tooManyPages = await parseFixture("text-layer.pdf", 1_000_000, 1);
		expect(tooManyPages).toMatchObject({
			ok: false,
			errors: [{ code: "PDF_PAGE_LIMIT_EXCEEDED", category: "validation" }],
		});

		const bytes = new Uint8Array(await readFile(join(fixtures, "text-layer.pdf")));
		const wrongHash = await parsePdfBytes({
			documentId: "document-wrong-hash",
			sourceContentHash: hashBytes("different"),
			bytes,
			operationId,
			options: { maxBytes: 1_000_000, maxPages: 10 },
		});
		expect(wrongHash).toMatchObject({ ok: false, errors: [{ code: "PDF_SOURCE_HASH_MISMATCH" }] });
	});
});
