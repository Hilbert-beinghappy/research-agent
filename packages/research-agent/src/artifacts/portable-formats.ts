// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import type { ClaimRecord, EvidenceCard, ManuscriptRecord, SectionRecord, SourceRecord } from "../contracts/schemas.ts";
import type { ProjectRecord } from "../project/record-index.ts";

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}

function bytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

export function createStoredZip(input: readonly { path: string; content: string | Uint8Array }[]): Uint8Array {
	const localParts: Uint8Array[] = [];
	const centralParts: Uint8Array[] = [];
	let offset = 0;
	for (const item of [...input].sort((left, right) => left.path.localeCompare(right.path))) {
		if (item.path.length === 0 || item.path.startsWith("/") || item.path.split("/").includes("..")) {
			throw new TypeError(`Invalid ZIP entry path: ${item.path}`);
		}
		const name = Buffer.from(item.path, "utf8");
		const data = bytes(item.content);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.byteLength, 18);
		local.writeUInt32LE(data.byteLength, 22);
		local.writeUInt16LE(name.byteLength, 26);
		localParts.push(local, name, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.byteLength, 20);
		central.writeUInt32LE(data.byteLength, 24);
		central.writeUInt16LE(name.byteLength, 28);
		central.writeUInt32LE(offset, 42);
		centralParts.push(central, name);
		offset += local.byteLength + name.byteLength + data.byteLength;
	}
	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(input.length, 8);
	end.writeUInt16LE(input.length, 10);
	end.writeUInt32LE(centralDirectory.byteLength, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readStoredZip(value: Uint8Array): Map<string, Uint8Array> {
	const archive = Buffer.from(value);
	const entries = new Map<string, Uint8Array>();
	let offset = 0;
	while (offset + 4 <= archive.byteLength && archive.readUInt32LE(offset) === 0x04034b50) {
		const method = archive.readUInt16LE(offset + 8);
		const size = archive.readUInt32LE(offset + 18);
		const nameLength = archive.readUInt16LE(offset + 26);
		const extraLength = archive.readUInt16LE(offset + 28);
		if (method !== 0) throw new TypeError("Only stored ZIP entries are supported");
		const nameStart = offset + 30;
		const dataStart = nameStart + nameLength + extraLength;
		const dataEnd = dataStart + size;
		if (dataEnd > archive.byteLength) throw new TypeError("ZIP entry exceeds archive bounds");
		const path = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
		if (entries.has(path)) throw new TypeError(`Duplicate ZIP entry: ${path}`);
		entries.set(path, archive.subarray(dataStart, dataEnd));
		offset = dataEnd;
	}
	if (entries.size === 0) throw new TypeError("ZIP archive has no stored entries");
	return entries;
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function oneManuscript(records: readonly ProjectRecord[]): { manuscript: ManuscriptRecord; sections: SectionRecord[] } {
	const manuscripts = records.filter((record): record is ManuscriptRecord => record.kind === "manuscript");
	if (manuscripts.length !== 1) throw new TypeError("Portable manuscript export requires one ManuscriptRecord");
	const manuscript = manuscripts[0];
	if (manuscript === undefined) throw new TypeError("Portable manuscript export is missing its manuscript");
	const sectionsById = new Map(
		records
			.filter((record): record is SectionRecord => record.kind === "section")
			.map((record) => [record.sectionId, record]),
	);
	const sections = manuscript.sectionIds.map((id) => sectionsById.get(id));
	if (sections.some((section) => section === undefined)) throw new TypeError("Portable export is missing a section");
	return { manuscript, sections: sections.filter((section): section is SectionRecord => section !== undefined) };
}

function paragraphXml(value: string, level: "body" | "heading" | "title" = "body"): string {
	const paragraph = level === "body" ? "" : `<w:pPr><w:outlineLvl w:val="${level === "title" ? 0 : 1}"/></w:pPr>`;
	const run = level === "body" ? "" : `<w:rPr><w:b/><w:sz w:val="${level === "title" ? 36 : 28}"/></w:rPr>`;
	return `<w:p>${paragraph}<w:r>${run}<w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`;
}

export function renderDocx(records: readonly ProjectRecord[]): Uint8Array {
	const { manuscript, sections } = oneManuscript(records);
	const paragraphs = [paragraphXml(manuscript.title, "title")];
	if (manuscript.abstract !== null)
		paragraphs.push(paragraphXml("Abstract", "heading"), paragraphXml(manuscript.abstract));
	for (const section of sections) {
		paragraphs.push(paragraphXml(section.title, "heading"));
		paragraphs.push(...section.content.split(/\r?\n/u).map((line) => paragraphXml(line)));
	}
	return createStoredZip([
		{
			path: "[Content_Types].xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		},
		{
			path: "_rels/.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		},
		{
			path: "word/document.xml",
			content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
		},
	]);
}

function pdfLiteral(value: string): string {
	if (/[^\x09\x0a\x0d\x20-\x7e]/u.test(value)) {
		throw new TypeError("Native PDF export currently requires ASCII text; use DOCX for Unicode manuscripts");
	}
	return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function renderPdf(records: readonly ProjectRecord[]): Uint8Array {
	const { manuscript, sections } = oneManuscript(records);
	const lines = [manuscript.title];
	if (manuscript.abstract !== null) lines.push("", "Abstract", manuscript.abstract);
	for (const section of sections) lines.push("", section.title, ...section.content.split(/\r?\n/u));
	const pages = Array.from({ length: Math.ceil(lines.length / 48) }, (_, index) =>
		lines.slice(index * 48, index * 48 + 48),
	);
	const objects: string[] = [];
	const pageIds = pages.map((_, index) => 4 + index * 2);
	objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
	objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	for (const [index, pageLines] of pages.entries()) {
		const pageId = pageIds[index];
		if (pageId === undefined) throw new TypeError("PDF page indexing failed");
		const contentId = pageId + 1;
		const stream = `BT /F1 11 Tf 50 792 Td 14 TL ${pageLines.map((line) => `(${pdfLiteral(line)}) Tj T*`).join(" ")} ET`;
		objects[pageId - 1] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
		objects[contentId - 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
	}
	let output = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(output));
		output += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(output);
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
		.join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(output, "ascii");
}

function evidenceRows(records: readonly ProjectRecord[]): string[][] {
	const evidence = new Map(
		records
			.filter((record): record is EvidenceCard => record.kind === "evidence")
			.map((record) => [record.evidenceId, record]),
	);
	const sources = new Map(
		records
			.filter((record): record is SourceRecord => record.kind === "source")
			.map((record) => [record.sourceId, record]),
	);
	const claims = records.filter((record): record is ClaimRecord => record.kind === "claim");
	return [
		["Claim ID", "Claim", "Support", "Evidence ID", "Relation", "Source", "Evidence level", "Locator"],
		...claims.flatMap((claim) =>
			claim.evidenceLinks.length === 0
				? [[claim.claimId, claim.text, claim.supportStatus, "", "", "", "", ""]]
				: claim.evidenceLinks.map((link) => {
						const card = evidence.get(link.evidenceId);
						const source = card === undefined ? undefined : sources.get(card.sourceId);
						return [
							claim.claimId,
							claim.text,
							claim.supportStatus,
							link.evidenceId,
							link.relation,
							source?.title ?? "",
							card?.evidenceLevel ?? "",
							card?.locator?.label ?? "",
						];
					}),
		),
	];
}

export function renderXlsx(records: readonly ProjectRecord[]): Uint8Array {
	const rows = evidenceRows(records);
	const columns = [18, 48, 20, 20, 16, 36, 20, 24]
		.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
		.join("");
	const sheet = rows
		.map(
			(row, rowIndex) =>
				`<row r="${rowIndex + 1}">${row
					.map((cell, columnIndex) => {
						const column = String.fromCharCode(65 + columnIndex);
						return `<c r="${column}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`;
					})
					.join("")}</row>`,
		)
		.join("");
	return createStoredZip([
		{
			path: "[Content_Types].xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
		},
		{
			path: "_rels/.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
		},
		{
			path: "xl/workbook.xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Evidence Matrix" sheetId="1" r:id="rId1"/></sheets></workbook>',
		},
		{
			path: "xl/_rels/workbook.xml.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
		},
		{
			path: "xl/worksheets/sheet1.xml",
			content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${columns}</cols><sheetData>${sheet}</sheetData></worksheet>`,
		},
	]);
}

function slideXml(title: string, content: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2800" b="1"/><a:t>${xml(title)}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4800600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1600"/><a:t>${xml(content)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

export function renderPptx(records: readonly ProjectRecord[]): Uint8Array {
	const { manuscript, sections } = oneManuscript(records);
	const slides = [{ title: manuscript.title, content: manuscript.abstract ?? "" }, ...sections];
	const overrides = slides
		.map(
			(_, index) =>
				`<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
		)
		.join("");
	const slideIds = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
	const slideRelationships = slides
		.map(
			(_, index) =>
				`<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
		)
		.join("");
	return createStoredZip([
		{
			path: "[Content_Types].xml",
			content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${overrides}</Types>`,
		},
		{
			path: "_rels/.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
		},
		{
			path: "ppt/presentation.xml",
			content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
		},
		{
			path: "ppt/_rels/presentation.xml.rels",
			content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRelationships}</Relationships>`,
		},
		{
			path: "ppt/slideMasters/slideMaster1.xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>',
		},
		{
			path: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>',
		},
		{
			path: "ppt/slideLayouts/slideLayout1.xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
		},
		{
			path: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
		},
		{
			path: "ppt/theme/theme1.xml",
			content:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Pi Research"><a:themeElements><a:clrScheme name="Pi"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2><a:accent1><a:srgbClr val="2F5597"/></a:accent1><a:accent2><a:srgbClr val="70AD47"/></a:accent2><a:accent3><a:srgbClr val="ED7D31"/></a:accent3><a:accent4><a:srgbClr val="A5A5A5"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="FFC000"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Pi"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Pi"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>',
		},
		...slides.flatMap((slide, index) => [
			{ path: `ppt/slides/slide${index + 1}.xml`, content: slideXml(slide.title, slide.content) },
			{
				path: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
				content:
					'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
			},
		]),
	]);
}

function sourceFileName(source: SourceRecord): string {
	let stem = source.title
		.normalize("NFKC")
		.replace(/[\\/:*?"<>|#[\]^\u0000-\u001f]/gu, "-")
		.replace(/[\s-]+/gu, "-")
		.replace(/^[.-]+|[.-]+$/gu, "")
		.slice(0, 72);
	if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
	return `${stem.length === 0 ? "source" : stem}--${source.sourceId}.md`;
}

function sourceDoi(source: SourceRecord): string | null {
	return source.identifiers.find(({ scheme }) => scheme === "doi")?.normalizedValue ?? null;
}

function sourceYear(source: SourceRecord): number | null {
	if (source.issuedDate === null) return null;
	const year = Number(source.issuedDate.slice(0, 4));
	return Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null;
}

export function renderObsidianVault(records: readonly ProjectRecord[]): Uint8Array {
	const sources = records.filter((record): record is SourceRecord => record.kind === "source");
	const evidence = records.filter((record): record is EvidenceCard => record.kind === "evidence");
	const claims = records.filter((record): record is ClaimRecord => record.kind === "claim");
	const sourcePaths = new Map(sources.map((source) => [source.sourceId, `sources/${sourceFileName(source)}`]));
	const entries: Array<{ path: string; content: string }> = [
		{
			path: "Research Index.md",
			content: `---\nresearch_agent_format: "obsidian-v1"\n---\n# Research Index\n\n## Sources\n${sources
				.map(
					(source) =>
						`- [[${sourcePaths.get(source.sourceId)?.slice(0, -3)}|${source.title.replace(/\|/g, "-")}]]`,
				)
				.join(
					"\n",
				)}\n\n## Claims\n${claims.map((claim) => `- [[claims/${claim.claimId}|${claim.text.replace(/\|/g, "-")}]]`).join("\n")}\n`,
		},
		{
			path: "Sources.base",
			content:
				'views:\n  - type: table\n    name: Sources\n    filters:\n      and:\n        - file.inFolder("sources")\n    order:\n      - title\n      - doi\n      - publication_year\n      - research_agent_id\n',
		},
	];
	for (const source of sources) {
		entries.push({
			path: sourcePaths.get(source.sourceId) ?? `sources/${source.sourceId}.md`,
			content: `---\nresearch_agent_id: ${JSON.stringify(source.sourceId)}\ntype: "source"\ntitle: ${JSON.stringify(source.title)}\ndoi: ${JSON.stringify(sourceDoi(source))}\npublication_year: ${sourceYear(source) ?? "null"}\n---\n# ${source.title}\n\n- Status: ${source.publicationStatus}\n- Canonical source: ${source.sourceId}\n`,
		});
	}
	for (const card of evidence) {
		const sourcePath = sourcePaths.get(card.sourceId)?.slice(0, -3) ?? card.sourceId;
		entries.push({
			path: `evidence/${card.evidenceId}.md`,
			content: `---\nresearch_agent_id: ${JSON.stringify(card.evidenceId)}\ntype: "evidence"\nevidence_level: ${JSON.stringify(card.evidenceLevel)}\n---\n# ${card.evidenceId}\n\n- Source: [[${sourcePath}]]\n- Locator: ${card.locator?.label ?? "unlocated"}\n- Statement: ${card.evidenceStatement}\n`,
		});
	}
	for (const claim of claims) {
		entries.push({
			path: `claims/${claim.claimId}.md`,
			content: `---\nresearch_agent_id: ${JSON.stringify(claim.claimId)}\ntype: "claim"\nsupport_status: ${JSON.stringify(claim.supportStatus)}\n---\n# Claim\n\n${claim.text}\n\n## Evidence\n${claim.evidenceLinks.map(({ evidenceId, relation }) => `- [[evidence/${evidenceId}|${evidenceId}]] (${relation})`).join("\n")}\n`,
		});
	}
	return createStoredZip(entries);
}

export function obsidianResearchIds(value: Uint8Array): string[] {
	const ids: string[] = [];
	for (const [path, content] of readStoredZip(value)) {
		if (!path.endsWith(".md")) continue;
		const match = /^research_agent_id:\s*("(?:[^"\\]|\\.)*")$/mu.exec(Buffer.from(content).toString("utf8"));
		if (match?.[1] !== undefined) ids.push(JSON.parse(match[1]) as string);
	}
	return ids.sort();
}
