import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordedHttpTransport, type RecordedHttpExchange } from "../../src/adapters/http/transport.ts";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import type {
	DocumentRecord,
	FileRef,
	OperationRecord,
	RecordRef,
	ResearchProjectManifest,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import { registerResearchCommands } from "../../src/extension/commands.ts";
import { RESEARCH_TOOL_NAMES, type RegisterResearchToolsOptions } from "../../src/extension/tools.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashFile } from "../../src/kernel/integrity.ts";
import { resolveProjectPath } from "../../src/kernel/paths.ts";
import { atomicWriteFile } from "../../src/project/atomic-write.ts";
import { PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import { openProject } from "../../src/project/open.ts";
import {
	listProjectRecordIds,
	type ProjectRecord,
	projectRecordId,
	projectRecordRevision,
} from "../../src/project/record-index.ts";
import { createRecord, readRecord } from "../../src/project/records.ts";
import { listPendingProjectTransactions, prepareProjectTransaction } from "../../src/project/transactions.ts";
import { validateProject } from "../../src/project/validate.ts";

const V0_2_TOOL_NAMES = RESEARCH_TOOL_NAMES.filter(
	(name) =>
		name !== "research_analysis" &&
		name !== "research_qualitative" &&
		name !== "research_manuscript" &&
		name !== "research_review" &&
		name !== "research_knowledge" &&
		name !== "research_monitor",
);
const V0_1_TOOL_NAMES = V0_2_TOOL_NAMES.filter((name) => name !== "research_design");

interface ScenarioTopic {
	slug: string;
	title: string;
	query: string;
	doiPrefix: string;
	sourceTitle: string;
	mixedClaim: string;
	unsupportedClaim: string;
	abstractClaim: string;
}

interface ScenarioEvidenceCase {
	caseId: string;
	evidenceLevel: "abstract" | "fulltext_located";
	relation: "supports" | "refutes" | "qualifies" | "context_only";
	query: string | null;
	evidenceStatement: string;
	paraphrase: string;
}

interface ScenarioFixture {
	schemaVersion: "0.1.0";
	replayId: string;
	scriptedToolSet: string[];
	evidenceCases: ScenarioEvidenceCase[];
	topics: ScenarioTopic[];
}

interface ScenarioGate {
	schemaVersion: "0.1.0";
	scenario: "scenario-a";
	requiredTopicCount: number;
	requiredAnomalies: Record<string, string>;
	requiredArtifacts: string[];
	requiredEvidenceLevels: string[];
}

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const scenarioPath = join(fixtures, "projects/scenario-a/topics.json");
const gatePath = fileURLToPath(new URL("../../evals/v0.1/scenario-a-gate.json", import.meta.url));
const openAlexKey = "scenario-openalex-key";
const unpaywallEmail = "scenario@example.test";
const openAlexSelectedFields = [
	"id",
	"doi",
	"title",
	"publication_year",
	"publication_date",
	"type",
	"language",
	"cited_by_count",
	"is_retracted",
	"authorships",
	"ids",
	"primary_location",
	"open_access",
	"primary_topic",
	"relevance_score",
].join(",");

let temporaryDirectory: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-scenario-a-"));
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Expected array");
	return value;
}

function string(value: unknown): string {
	if (typeof value !== "string") throw new Error("Expected string");
	return value;
}

async function loadFixture<Value>(path: string): Promise<Value> {
	return JSON.parse(await readFile(path, "utf8")) as Value;
}

function searchUrl(topic: ScenarioTopic): string {
	const url = new URL("https://api.crossref.org/v1/works");
	url.searchParams.set("query.bibliographic", topic.query);
	url.searchParams.set("rows", "2");
	url.searchParams.set("cursor", "*");
	return url.toString();
}

function openAlexSearchUrl(topic: ScenarioTopic): string {
	const url = new URL("https://api.openalex.org/works");
	url.searchParams.set("search", topic.query);
	url.searchParams.set("per_page", "2");
	url.searchParams.set("cursor", "*");
	url.searchParams.set("select", openAlexSelectedFields);
	url.searchParams.set("api_key", openAlexKey);
	return url.toString();
}

function unpaywallUrl(doi: string): string {
	const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
	url.searchParams.set("email", unpaywallEmail);
	return url.toString();
}

function crossrefLookupUrl(doi: string): string {
	return `https://api.crossref.org/v1/works/${encodeURIComponent(doi)}`;
}

function crossrefStatusUrl(doi: string): string {
	const url = new URL("https://api.crossref.org/v1/works");
	url.searchParams.set("filter", `updates:${doi}`);
	url.searchParams.set("rows", "1000");
	return url.toString();
}

function crossrefWork(topic: ScenarioTopic, version: 1 | 2): Record<string, unknown> {
	const doi = `${topic.doiPrefix}.${version}`;
	return {
		DOI: doi,
		title: [topic.sourceTitle],
		author: [{ given: "Lin", family: "Chen" }],
		issued: { "date-parts": [[2024]] },
		"container-title": ["Journal of Synthetic Public Administration"],
		publisher: "Fixture Press",
		type: version === 1 ? "journal-article" : "posted-content",
		language: "en",
		abstract:
			version === 1
				? `The abstract reports mixed institutional effects for ${topic.sourceTitle}.`
				: `The abstract reports an association relevant to ${topic.sourceTitle}, but no full text is available.`,
		URL: `https://doi.org/${doi}`,
		...(version === 2
			? {
					"update-to": [
						{
							updated: { "date-parts": [[2026, 8, 6]] },
							DOI: doi,
							type: "correction",
							label: "Correction",
							source: "publisher",
						},
					],
				}
			: {}),
	};
}

function crossrefSearchBody(topic: ScenarioTopic): string {
	return JSON.stringify({
		status: "ok",
		"message-type": "work-list",
		"message-version": "1.0.0",
		message: { "total-results": 2, items: [crossrefWork(topic, 1), crossrefWork(topic, 2)] },
	});
}

function openAlexWork(topic: ScenarioTopic, version: 1 | 2): Record<string, unknown> {
	const doi = `${topic.doiPrefix}.${version}`;
	return {
		id: `https://openalex.org/W${version}${topic.slug.length}`,
		doi: `https://doi.org/${doi}`,
		title: topic.sourceTitle,
		publication_year: 2024,
		publication_date: "2024-01-01",
		type: version === 1 ? "article" : "preprint",
		language: "en",
		cited_by_count: version === 1 ? 12 : 4,
		is_retracted: false,
		relevance_score: version === 1 ? 31.5 : 21.25,
		authorships: [
			{
				author_position: "first",
				author: { id: "https://openalex.org/A1001", display_name: "Lin Chen", orcid: null },
			},
		],
		ids: { openalex: `https://openalex.org/W${version}${topic.slug.length}`, doi: `https://doi.org/${doi}` },
		primary_location: null,
		open_access: { is_oa: version === 1, oa_status: version === 1 ? "gold" : "closed" },
		primary_topic: { id: "https://openalex.org/T1001", display_name: "Public Administration", score: 0.92 },
	};
}

function openAlexSearchBody(topic: ScenarioTopic): string {
	return JSON.stringify({
		meta: { count: 2, per_page: 2, next_cursor: null, cost_usd: 0.001 },
		results: [openAlexWork(topic, 1), openAlexWork(topic, 2)],
	});
}

function unpaywallOpenBody(topic: ScenarioTopic): string {
	const doi = `${topic.doiPrefix}.1`;
	const landing = `https://repository.example.test/${topic.slug}`;
	const location = {
		url: landing,
		url_for_landing_page: landing,
		url_for_pdf: `${landing}.pdf`,
		host_type: "repository",
		version: "acceptedVersion",
		is_best: true,
		license: "cc-by",
		oa_date: "2026-08-06",
		repository_institution: "Fixture University",
		evidence: "scenario-a recorded fixture",
	};
	return JSON.stringify({
		doi,
		is_oa: true,
		oa_status: "green",
		best_oa_location: location,
		oa_locations: [location],
	});
}

function unpaywallClosedBody(topic: ScenarioTopic): string {
	return JSON.stringify({
		doi: `${topic.doiPrefix}.2`,
		is_oa: false,
		oa_status: "closed",
		best_oa_location: null,
		oa_locations: [],
	});
}

function crossrefLookupBody(topic: ScenarioTopic, version: 1 | 2): string {
	const work = crossrefWork(topic, version);
	if (version === 2) work.title = [`Conflicting metadata for ${topic.sourceTitle}`];
	return JSON.stringify({
		status: "ok",
		"message-type": "work",
		"message-version": "1.0.0",
		message: work,
	});
}

function crossrefStatusBody(topic: ScenarioTopic, version: 1 | 2): string {
	const doi = `${topic.doiPrefix}.${version}`;
	const relation = version === 1 ? "retraction" : "correction";
	const items = [
		{
			DOI: `${doi}.${relation}`,
			title: [`${relation === "retraction" ? "Retraction" : "Correction"}: ${topic.sourceTitle}`],
			type: "journal-article",
			"update-to": [
				{
					updated: { "date-parts": [[2026, 8, 6]] },
					DOI: doi,
					type: relation,
					label: relation === "retraction" ? "Retraction" : "Correction",
					source: "publisher",
				},
			],
		},
	];
	return JSON.stringify({
		status: "ok",
		"message-type": "work-list",
		"message-version": "1.0.0",
		message: { "total-results": items.length, items },
	});
}

function scenarioPdf(topic: ScenarioTopic): Buffer {
	const escapeText = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
	const pageStream = (heading: string, lines: string[]) => {
		const commands = [
			"BT",
			"/F1 16 Tf",
			"72 740 Td",
			`(${escapeText(heading)}) Tj`,
			"/F1 11 Tf",
			...lines.flatMap((line) => ["0 -30 Td", `(${escapeText(line)}) Tj`]),
			"ET",
		].join("\n");
		return `<< /Length ${Buffer.byteLength(commands, "ascii")} >>\nstream\n${commands}\nendstream`;
	};
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		pageStream(`Positive result for ${topic.sourceTitle}`, [
			"The high-capacity agency reported a positive outcome after implementation.",
			"The outcome measure improved during the observed period.",
			"This positive result applies only to one institutional setting.",
		]),
		pageStream(`Countervailing result for ${topic.sourceTitle}`, [
			"The low-capacity agency did not report a positive outcome after implementation.",
			"The outcome measure declined during the same observed period.",
			"The two-agency comparison shows heterogeneous institutional effects.",
		]),
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, objectBody] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf, "ascii"));
		pdf += `${index + 1} 0 obj\n${objectBody}\nendobj\n`;
	}
	const xrefOffset = Buffer.byteLength(pdf, "ascii");
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	pdf += offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("");
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(pdf, "ascii");
}

function recordedExchanges(topic: ScenarioTopic): RecordedHttpExchange[] {
	const pdf = scenarioPdf(topic);
	const doi1 = `${topic.doiPrefix}.1`;
	const doi2 = `${topic.doiPrefix}.2`;
	const openPdfUrl = `https://repository.example.test/${topic.slug}.pdf`;
	return [
		{
			request: { method: "GET", url: searchUrl(topic), body: null },
			response: { status: 200, headers: { "content-type": "application/json" }, body: crossrefSearchBody(topic) },
		},
		{
			request: { method: "GET", url: openAlexSearchUrl(topic), body: null },
			response: { status: 200, headers: { "content-type": "application/json" }, body: openAlexSearchBody(topic) },
		},
		...([0, 1].map(() => ({
			request: { method: "GET" as const, url: unpaywallUrl(doi1), body: null },
			response: { status: 200, headers: { "content-type": "application/json" }, body: unpaywallOpenBody(topic) },
		})) satisfies RecordedHttpExchange[]),
		{
			request: { method: "GET", url: openPdfUrl, body: null },
			response: {
				status: 200,
				headers: { "content-type": "application/pdf" },
				body: pdf.toString("base64"),
				bodyBytes: pdf.byteLength,
			},
		},
		{
			request: { method: "GET", url: unpaywallUrl(doi2), body: null },
			response: { status: 200, headers: { "content-type": "application/json" }, body: unpaywallClosedBody(topic) },
		},
		...([1, 2] as const).flatMap((version) => {
			const doi = `${topic.doiPrefix}.${version}`;
			return [
				{
					request: { method: "GET" as const, url: crossrefLookupUrl(doi), body: null },
					response: {
						status: 200,
						headers: { "content-type": "application/json" },
						body: crossrefLookupBody(topic, version),
					},
				},
				{
					request: { method: "GET" as const, url: crossrefStatusUrl(doi), body: null },
					response: {
						status: 200,
						headers: { "content-type": "application/json" },
						body: crossrefStatusBody(topic, version),
					},
				},
			];
		}),
	];
}

function createHarness(
	transport: ReturnType<typeof createRecordedHttpTransport>,
	credentialAliases: NonNullable<RegisterResearchToolsOptions["credentialAliases"]> = {
		unpaywallEmail: "unpaywall-email",
		openalexApiKey: "openalex-api-key",
	},
) {
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, ToolDefinition>();
	const toolCalls: string[] = [];
	const entries: Array<{
		type: "custom";
		customType: string;
		data: unknown;
		id: string;
		parentId: string | null;
		timestamp: string;
	}> = [];
	const notify = vi.fn();
	const confirm = vi.fn(async () => true);
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool(tool: ToolDefinition): void {
			tools.set(tool.name, tool);
			activeTools = [...activeTools, tool.name];
		},
		registerCommand(name: string, options: { handler: CommandHandler }): void {
			commands.set(name, options.handler);
		},
		on(): void {},
		appendEntry(customType: string, data: unknown): void {
			entries.push({
				type: "custom",
				customType,
				data,
				id: `entry-${entries.length + 1}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
			});
		},
		getActiveTools(): string[] {
			return [...activeTools];
		},
		setActiveTools(names: string[]): void {
			activeTools = [...names];
		},
	} as unknown as ExtensionAPI;
	registerResearchCommands(pi, "0.2.0", {
		http: {
			transport,
			resolveCredential: async (alias) => {
				if (alias === "unpaywall-email") return unpaywallEmail;
				if (alias === "openalex-api-key") return openAlexKey;
				throw new Error(`Unexpected credential alias: ${alias}`);
			},
			wait: async () => {},
			random: () => 0,
		},
		credentialAliases,
	});

	const context = (cwd: string) =>
		({
			cwd,
			hasUI: true,
			mode: "tui",
			signal: new AbortController().signal,
			ui: {
				notify,
				confirm,
				select: vi.fn(async (_title: string, choices: string[]) => choices[0]),
				setStatus: vi.fn(),
			},
			sessionManager: {
				getSessionId: () => "scenario-a-session",
				getSessionFile: () => join(cwd, "session.jsonl"),
				getEntries: () => [...entries],
			},
		}) as unknown as ExtensionCommandContext & ExtensionContext;

	return { commands, tools, toolCalls, notify, confirm, activeTools: () => activeTools, context };
}

async function callTool(
	harness: ReturnType<typeof createHarness>,
	name: string,
	params: object,
	ctx: ExtensionContext,
): Promise<Record<string, unknown>> {
	const tool = harness.tools.get(name);
	if (tool === undefined) throw new Error(`Missing tool: ${name}`);
	harness.toolCalls.push(name);
	const result = await tool.execute(`scenario-${harness.toolCalls.length}`, params, ctx.signal, undefined, ctx);
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("Tool did not return JSON text");
	return object(JSON.parse(content.text));
}

function designRecordId(record: Record<string, unknown>): string {
	switch (string(record.kind)) {
		case "research_question_version":
			return string(record.researchQuestionVersionId);
		case "concept":
			return string(record.conceptId);
		case "theory_relation":
			return string(record.theoryRelationId);
		case "design_decision":
			return string(record.designDecisionId);
		case "protocol":
			return string(record.protocolId);
		default:
			throw new Error("Design Tool returned an unknown record kind");
	}
}

async function createConfirmedDesign(
	harness: ReturnType<typeof createHarness>,
	ctx: ExtensionContext,
	projectRoot: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	let opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const created = await callTool(
		harness,
		"research_design",
		{ ...params, expectedRevision: opened.manifest.revision },
		ctx,
	);
	expect(created).toMatchObject({ ok: true, value: { status: "draft" } });
	const record = object(created.value);
	const kind = string(record.kind);
	const id = designRecordId(record);
	const revision = object(record.audit).revision;
	if (typeof revision !== "number") throw new Error("Design Tool did not return a record revision");
	opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const confirmed = await callTool(
		harness,
		"research_design",
		{
			action: "confirm",
			expectedRevision: opened.manifest.revision,
			recordKind: kind,
			recordId: id,
			expectedRecordRevision: revision,
			note: "Confirmed for the frozen Scenario A design",
		},
		ctx,
	);
	if (confirmed.ok !== true) throw new Error(JSON.stringify(confirmed.errors));
	expect(confirmed).toMatchObject({ ok: true, value: { status: "confirmed" } });
	return object(confirmed.value);
}

async function manifest(projectRoot: string): Promise<ResearchProjectManifest> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	return opened.manifest;
}

async function records(projectRoot: string, kind: ProjectRecord["kind"]): Promise<ProjectRecord[]> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const values: ProjectRecord[] = [];
	for (const id of await listProjectRecordIds(opened.root, opened.manifest, kind)) {
		const record = await readRecord(opened.root, kind, id);
		if (!record.ok) throw new Error(record.errors[0].message);
		values.push(record.value);
	}
	return values;
}

function generationRef(record: ProjectRecord): RecordRef {
	if (!["source", "document", "evidence", "claim", "citation_verification"].includes(record.kind)) {
		throw new Error(`Unsupported artifact input: ${record.kind}`);
	}
	return { kind: record.kind, id: projectRecordId(record), revision: projectRecordRevision(record) } as RecordRef;
}

function operationRecord(operationId: string, name: string, inputFiles: FileRef[]): OperationRecord {
	const now = new Date().toISOString();
	return {
		kind: "operation",
		schemaVersion: "0.1.0",
		operationId,
		taskId: null,
		operationKind: "tool",
		name,
		implementationVersion: "0.1.0",
		status: "succeeded",
		session: null,
		actor: { type: "tool", id: "scenario-a-fixture" },
		modelExecution: null,
		adapterExecution: null,
		inputs: [],
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
}

async function linkImportedPdf(
	projectRoot: string,
	fileName: "scanned.pdf" | "corrupt.pdf",
	contentHash: string,
): Promise<{ sourceId: string; documentId: string }> {
	const path = `sources/originals/${contentHash}.pdf`;
	const absolutePath = await resolveProjectPath(projectRoot, path);
	const bytes = await readFile(absolutePath);
	const file: FileRef = {
		path,
		hash: hashBytes(bytes),
		mediaType: "application/pdf",
		bytes: (await stat(absolutePath)).size,
	};
	const operationId = createOpaqueId("operation");
	const sourceId = createOpaqueId("source");
	const documentId = createOpaqueId("document");
	const now = new Date().toISOString();
	const operation = await createRecord(
		projectRoot,
		operationRecord(operationId, `scenario.link.${fileName}`, [file]),
		{
			expectedManifestRevision: (await manifest(projectRoot)).revision,
			operationId,
		},
	);
	if (!operation.ok) throw new Error(operation.errors[0].message);
	const source: SourceRecord = {
		kind: "source",
		schemaVersion: "0.1.0",
		sourceId,
		identifiers: [],
		title: `Scenario A ${fileName}`,
		titleNormalized: `scenario a ${fileName}`,
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
				adapterId: "local-import",
				adapterVersion: "0.1.0",
				queryText: null,
				queryHash: null,
				discoveredAt: now,
				rank: null,
				rawRecord: file,
				requestOperationId: operationId,
			},
		],
		dedupKeys: {
			doi: null,
			strongIdentifier: null,
			normalizedTitleYearFirstAuthor: null,
			contentHash,
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
	const createdSource = await createRecord(projectRoot, source, {
		expectedManifestRevision: (await manifest(projectRoot)).revision,
		operationId,
	});
	if (!createdSource.ok) throw new Error(createdSource.errors[0].message);
	const document: DocumentRecord = {
		kind: "document",
		schemaVersion: "0.1.0",
		documentId,
		sourceId,
		acquisition: {
			method: "local_import",
			adapterId: "local-import",
			origin: fileName,
			accessStatus: "user_provided",
			licenseExpression: null,
			termsReference: null,
			acquiredAt: now,
			approvalId: null,
		},
		localFile: file,
		originalFileName: fileName,
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
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
	const createdDocument = await createRecord(projectRoot, document, {
		expectedManifestRevision: (await manifest(projectRoot)).revision,
		operationId,
	});
	if (!createdDocument.ok) throw new Error(createdDocument.errors[0].message);
	return { sourceId, documentId };
}

async function importAndParseFailure(
	harness: ReturnType<typeof createHarness>,
	ctx: ExtensionContext,
	projectRoot: string,
	fileName: "scanned.pdf" | "corrupt.pdf",
	expectedStatus: "ocr_required" | "parse_failed",
) {
	const imported = await callTool(
		harness,
		"research_import_sources",
		{
			inputs: [{ path: join(fixtures, "documents", fileName), format: "pdf", mode: "copy" }],
			dedupe: "exact-and-review-candidates",
		},
		ctx,
	);
	expect(imported).toMatchObject({
		ok: true,
		value: { importedSourceIds: [], unmatchedDocuments: [{ reason: "BIBLIOGRAPHIC_MATCH_REQUIRED" }] },
	});
	const input = object(array(object(imported.value).inputs)[0]);
	const contentHash = string(object(input.contentHash).value);
	const linked = await linkImportedPdf(projectRoot, fileName, contentHash);
	const parsed = await callTool(
		harness,
		"research_documents",
		{
			action: "parse",
			sourceIds: [linked.sourceId],
			acquisitionPolicy: {
				allowOpenAccessDownload: true,
				allowPublisherLandingPageOnly: true,
				maxBytesPerFile: 1_000_000,
			},
		},
		ctx,
	);
	expect(parsed).toMatchObject({
		ok: true,
		status: "PARTIAL_SUCCESS",
		value: { documents: [{ sourceId: linked.sourceId, fullTextStatus: expectedStatus }] },
	});
	return linked;
}

async function recoverEveryKillPoint(
	harness: ReturnType<typeof createHarness>,
	ctx: ExtensionCommandContext,
	projectRoot: string,
): Promise<void> {
	for (let appliedCount = 0; appliedCount <= 4; appliedCount += 1) {
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const writes = ["search", "download", "evidence"].map((label) => ({
			path: `.research/runs/scenario-recovery-${appliedCount}-${label}.json`,
			content: `${JSON.stringify({ label, appliedCount })}\n`,
		}));
		const nextManifest = {
			...opened.manifest,
			revision: opened.manifest.revision + 1,
			updatedAt: new Date().toISOString(),
		};
		const transactionId = await prepareProjectTransaction(projectRoot, {
			expectedRevision: opened.manifest.revision,
			writes,
			manifest: nextManifest,
		});
		for (const write of writes.slice(0, Math.min(appliedCount, writes.length))) {
			await atomicWriteFile(await resolveProjectPath(projectRoot, write.path), write.content);
		}
		if (appliedCount === 4) {
			await atomicWriteFile(
				await resolveProjectPath(projectRoot, PROJECT_MANIFEST_PATH),
				`${canonicalStringify(nextManifest)}\n`,
			);
		}
		await harness.commands.get("research-recover")?.(`commit ${transactionId}`, ctx);
		const notification = harness.notify.mock.calls.at(-1)?.[0];
		if (typeof notification !== "string") throw new Error("Recovery command did not return a result");
		const recoveryResult = object(JSON.parse(notification));
		expect(recoveryResult.errors).toEqual([]);
		expect(recoveryResult).toMatchObject({
			ok: true,
			value: { recovered: [{ transactionId, action: "commit" }] },
		});
		expect(await listPendingProjectTransactions(projectRoot)).toEqual([]);
		for (const write of writes) {
			await expect(readFile(await resolveProjectPath(projectRoot, write.path), "utf8")).resolves.toBe(write.content);
		}
	}
}

async function artifactInputs(projectRoot: string): Promise<RecordRef[]> {
	const values = await Promise.all(
		(["source", "document", "evidence", "claim", "citation_verification"] as const).map((kind) =>
			records(projectRoot, kind),
		),
	);
	return values.flat().map(generationRef);
}

async function assertArtifact(
	projectRoot: string,
	result: Record<string, unknown>,
	expectedPath: string,
): Promise<Record<string, unknown>> {
	expect(result).toMatchObject({ ok: true, value: { artifact: { outputFile: { path: expectedPath } } } });
	const artifact = object(object(result.value).artifact);
	const output = object(artifact.outputFile);
	const bytes = await readFile(await resolveProjectPath(projectRoot, expectedPath));
	expect(hashBytes(bytes).value).toBe(string(object(output.hash).value));
	expect(bytes.byteLength).toBe(output.bytes);
	return artifact;
}

async function runTopic(
	topic: ScenarioTopic,
	evidenceCases: ScenarioEvidenceCase[],
	gate: ScenarioGate,
	withDesign = false,
): Promise<Record<string, boolean>> {
	const projectRoot = join(temporaryDirectory, topic.slug);
	const harness = createHarness(createRecordedHttpTransport(recordedExchanges(topic)));
	const ctx = harness.context(projectRoot);
	await harness.commands.get("research-init")?.(topic.title, ctx);
	expect(harness.activeTools().sort()).toEqual(["read", ...RESEARCH_TOOL_NAMES].sort());

	const search = await callTool(
		harness,
		"research_search_sources",
		{
			queryPlanId: `${topic.slug}-plan`,
			queries: [
				{
					queryId: `${topic.slug}-query`,
					text: topic.query,
					adapterIds: ["crossref", "openalex"],
					filters: { fromYear: null, toYear: null, types: [] },
					maxResults: 2,
				},
			],
			budget: { maxUsd: 0.003, maxRequests: 2, hardStop: true },
			refresh: "revalidate",
		},
		ctx,
	);
	expect(search.errors).toEqual([]);
	expect(search).toMatchObject({
		ok: true,
		value: { requestCount: 2, cost: { amount: 0.001, currency: "USD" }, createdSourceIds: expect.any(Array) },
	});
	const sourceRecords = (await records(projectRoot, "source")).filter(
		(record): record is SourceRecord => record.kind === "source",
	);
	expect(sourceRecords).toHaveLength(2);
	const source1 = sourceRecords.find(({ dedupKeys }) => dedupKeys.doi === `${topic.doiPrefix}.1`);
	const source2 = sourceRecords.find(({ dedupKeys }) => dedupKeys.doi === `${topic.doiPrefix}.2`);
	if (source1 === undefined || source2 === undefined) throw new Error("Scenario sources were not committed");
	for (const source of [source1, source2]) {
		expect(source.duplicateStatus).toBe("possible_duplicate");
		expect(source.discovery.map(({ adapterId }) => adapterId).sort()).toEqual(["crossref", "openalex"]);
		expect(source.metadataConflicts).toContainEqual(
			expect.objectContaining({ field: "identifiers.doi", resolution: "unresolved" }),
		);
	}
	expect(source2.publicationStatus).toBe("unknown");

	const acquired = await callTool(
		harness,
		"research_documents",
		{
			action: "acquire",
			sourceIds: [source1.sourceId],
			acquisitionPolicy: {
				allowOpenAccessDownload: true,
				allowPublisherLandingPageOnly: true,
				maxBytesPerFile: 1_000_000,
			},
		},
		ctx,
	);
	expect(acquired).toMatchObject({
		ok: true,
		value: { documents: [{ sourceId: source1.sourceId, fullTextStatus: "acquired_unparsed" }] },
	});
	const parsed = await callTool(
		harness,
		"research_documents",
		{
			action: "parse",
			sourceIds: [source1.sourceId],
			acquisitionPolicy: {
				allowOpenAccessDownload: true,
				allowPublisherLandingPageOnly: true,
				maxBytesPerFile: 1_000_000,
			},
		},
		ctx,
	);
	expect(parsed).toMatchObject({
		ok: true,
		value: { documents: [{ sourceId: source1.sourceId, fullTextStatus: "parsed", pageCount: 2 }] },
	});
	const paywall = await callTool(
		harness,
		"research_documents",
		{
			action: "locate",
			sourceIds: [source2.sourceId],
			acquisitionPolicy: {
				allowOpenAccessDownload: true,
				allowPublisherLandingPageOnly: true,
				maxBytesPerFile: 1_000_000,
			},
		},
		ctx,
	);
	expect(paywall).toMatchObject({
		ok: true,
		value: {
			documents: [{ sourceId: source2.sourceId, accessStatus: "paywalled", fullTextStatus: "paywall_blocked" }],
		},
	});
	const paywallDocument = object(array(object(paywall.value).documents)[0]);
	const scanned = await importAndParseFailure(harness, ctx, projectRoot, "scanned.pdf", "ocr_required");
	const corrupt = await importAndParseFailure(harness, ctx, projectRoot, "corrupt.pdf", "parse_failed");

	let opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const claims = await callTool(
		harness,
		"research_commit_evidence",
		{
			evidenceCards: [],
			claims: [
				{
					text: topic.mixedClaim,
					claimType: "synthesis",
					scope: topic.title,
					evidenceLinks: [],
					conflictEvidenceIds: [],
				},
				{
					text: topic.unsupportedClaim,
					claimType: "causal",
					scope: topic.title,
					evidenceLinks: [],
					conflictEvidenceIds: [],
				},
				{
					text: topic.abstractClaim,
					claimType: "descriptive",
					scope: topic.title,
					evidenceLinks: [],
					conflictEvidenceIds: [],
				},
			],
			expectedRevision: opened.manifest.revision,
			validationMode: "strict",
		},
		ctx,
	);
	expect(claims).toMatchObject({ ok: true, value: { claimIds: expect.any(Array) } });
	const claimIds = array(object(claims.value).claimIds).map(string);
	expect(claimIds).toHaveLength(3);
	const [mixedClaimId, unsupportedClaimId, abstractClaimId] = claimIds;
	if (mixedClaimId === undefined || unsupportedClaimId === undefined || abstractClaimId === undefined) {
		throw new Error("Scenario claims were not committed");
	}

	const locatedCases = evidenceCases.filter(({ evidenceLevel }) => evidenceLevel === "fulltext_located");
	const abstractCases = evidenceCases.filter(({ evidenceLevel }) => evidenceLevel === "abstract");
	const locatedHits = new Map<string, Record<string, unknown>>();
	for (const evidenceCase of locatedCases) {
		if (evidenceCase.query === null) throw new Error(`Located evidence case lacks a query: ${evidenceCase.caseId}`);
		const corpus = await callTool(
			harness,
			"research_query_corpus",
			{
				query: evidenceCase.query,
				scope: "documents",
				filters: { sourceId: source1.sourceId },
				limit: 5,
				maxCharsPerHit: 4_000,
				cursor: null,
			},
			ctx,
		);
		expect(corpus).toMatchObject({ ok: true, value: { hits: [expect.any(Object)] } });
		locatedHits.set(evidenceCase.caseId, object(array(object(corpus.value).hits)[0]));
	}
	const locatedDraft = (evidenceCase: ScenarioEvidenceCase) => {
		const hit = locatedHits.get(evidenceCase.caseId);
		if (hit === undefined) throw new Error(`Missing located hit: ${evidenceCase.caseId}`);
		return {
			sourceId: source1.sourceId,
			documentId: string(hit.documentId),
			evidenceLevel: "fulltext_located",
			locator: hit.locator,
			excerpt: string(hit.text),
			excerptExactMatch: true,
			paraphrase: evidenceCase.paraphrase,
			evidenceStatement: evidenceCase.evidenceStatement,
			claimLinks: [
				{ claimId: mixedClaimId, relation: evidenceCase.relation, rationale: `Scenario A ${evidenceCase.caseId}` },
			],
			extraction: { method: "deterministic" },
			confidence: { level: "high", basis: "Exact located fixture text", limitations: ["Synthetic fixture"] },
			rights: { excerptAllowed: true, maxStoredWords: 100, publicExportAllowed: true },
			humanStatus: "not_reviewed",
			supersedesEvidenceId: null,
		};
	};
	const abstractDraft = (evidenceCase: ScenarioEvidenceCase) => ({
		sourceId: source2.sourceId,
		documentId: null,
		evidenceLevel: "abstract",
		locator: null,
		excerpt: null,
		excerptExactMatch: null,
		paraphrase: evidenceCase.paraphrase,
		evidenceStatement: evidenceCase.evidenceStatement,
		claimLinks: [
			{ claimId: abstractClaimId, relation: evidenceCase.relation, rationale: `Scenario A ${evidenceCase.caseId}` },
		],
		extraction: { method: "deterministic" },
		confidence: {
			level: "medium",
			basis: "Abstract metadata only",
			limitations: ["Full text unavailable", "Abstract excerpt storage is not licensed"],
		},
		rights: { excerptAllowed: null, maxStoredWords: null, publicExportAllowed: false },
		humanStatus: "not_reviewed",
		supersedesEvidenceId: null,
	});
	const supportingCase = locatedCases.find(({ relation }) => relation === "supports");
	const refutingCase = locatedCases.find(({ relation }) => relation === "refutes");
	const firstAbstractCase = abstractCases[0];
	if (supportingCase === undefined || refutingCase === undefined || firstAbstractCase === undefined) {
		throw new Error("Scenario evidence case fixture is incomplete");
	}

	opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const supporting = await callTool(
		harness,
		"research_commit_evidence",
		{
			evidenceCards: [locatedDraft(supportingCase)],
			claims: [],
			expectedRevision: opened.manifest.revision,
			validationMode: "strict",
		},
		ctx,
	);
	expect(supporting).toMatchObject({ ok: true, value: { supportStatuses: [{ supportStatus: "supported" }] } });

	const refutingDraft = locatedDraft(refutingCase);
	opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const refuting = await callTool(
		harness,
		"research_commit_evidence",
		{
			evidenceCards: [refutingDraft],
			claims: [],
			expectedRevision: opened.manifest.revision,
			validationMode: "strict",
		},
		ctx,
	);
	expect(refuting).toMatchObject({ ok: true, value: { supportStatuses: [{ supportStatus: "mixed" }] } });
	const refutingEvidenceId = string(array(object(refuting.value).evidenceIds)[0]);

	const currentSource2 = await readRecord(projectRoot, "source", source2.sourceId);
	if (!currentSource2.ok || currentSource2.value.kind !== "source" || currentSource2.value.abstractText === null) {
		throw new Error("Expected abstract-only source");
	}
	opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const abstractEvidence = await callTool(
		harness,
		"research_commit_evidence",
		{
			evidenceCards: [abstractDraft(firstAbstractCase)],
			claims: [],
			expectedRevision: opened.manifest.revision,
			validationMode: "strict",
		},
		ctx,
	);
	expect(abstractEvidence).toMatchObject({
		ok: true,
		value: { evidenceLevels: [{ evidenceLevel: "abstract" }] },
	});
	const seededCaseIds = new Set([supportingCase.caseId, refutingCase.caseId, firstAbstractCase.caseId]);
	const additionalCases = evidenceCases.filter(({ caseId }) => !seededCaseIds.has(caseId));
	opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const additionalEvidence = await callTool(
		harness,
		"research_commit_evidence",
		{
			evidenceCards: additionalCases.map((evidenceCase) =>
				evidenceCase.evidenceLevel === "fulltext_located"
					? locatedDraft(evidenceCase)
					: abstractDraft(evidenceCase),
			),
			claims: [],
			expectedRevision: opened.manifest.revision,
			validationMode: "strict",
		},
		ctx,
	);
	expect(additionalEvidence).toMatchObject({
		ok: true,
		value: { evidenceIds: expect.arrayContaining(additionalCases.map(() => expect.any(String))) },
	});
	expect(array(object(additionalEvidence.value).evidenceIds)).toHaveLength(additionalCases.length);

	const citations = await callTool(
		harness,
		"research_verify_citations",
		{
			sourceIds: [source1.sourceId, source2.sourceId],
			providers: ["crossref"],
			refresh: "revalidate",
			matchThresholds: { title: 0.85, author: 0.8, yearTolerance: 1 },
		},
		ctx,
	);
	expect(citations).toMatchObject({
		ok: true,
		value: {
			verifications: [
				{ sourceId: source1.sourceId, finalStatus: "verified_with_warning", publicationStatus: "retracted" },
				{ sourceId: source2.sourceId, finalStatus: "conflict", publicationStatus: "corrected" },
			],
		},
	});
	const citationRecords = await records(projectRoot, "citation_verification");
	const conflictingCitation = citationRecords.find(
		(record) => record.kind === "citation_verification" && record.sourceId === source2.sourceId,
	);
	expect(conflictingCitation).toMatchObject({
		kind: "citation_verification",
		finalStatus: "conflict",
		fieldChecks: expect.arrayContaining([expect.objectContaining({ field: "title", status: "conflict" })]),
	});

	const storedClaims = (await records(projectRoot, "claim")).filter((record) => record.kind === "claim");
	expect(storedClaims.find(({ claimId }) => claimId === mixedClaimId)).toMatchObject({
		supportStatus: "mixed",
		conflictEvidenceIds: expect.arrayContaining([refutingEvidenceId]),
	});
	expect(storedClaims.find(({ claimId }) => claimId === unsupportedClaimId)).toMatchObject({
		supportStatus: "unsupported",
		publishability: "blocked",
	});
	const evidenceRecords = await records(projectRoot, "evidence");
	expect(evidenceRecords).toHaveLength(evidenceCases.length);
	expect(new Set(evidenceRecords.map((record) => object(record).evidenceStatement))).toEqual(
		new Set(evidenceCases.map(({ evidenceStatement }) => evidenceStatement)),
	);
	for (const evidenceCase of evidenceCases) {
		const record = evidenceRecords.find(
			(candidate) => candidate.kind === "evidence" && candidate.evidenceStatement === evidenceCase.evidenceStatement,
		);
		expect(record).toMatchObject({
			kind: "evidence",
			evidenceLevel: evidenceCase.evidenceLevel,
			claimLinks: expect.arrayContaining([expect.objectContaining({ relation: evidenceCase.relation })]),
		});
		if (record?.kind !== "evidence") throw new Error(`Missing evidence record: ${evidenceCase.caseId}`);
		if (evidenceCase.evidenceLevel === "fulltext_located") {
			expect(record).toMatchObject({
				documentId: expect.any(String),
				locator: expect.objectContaining({ pageStart: expect.any(Number), anchorHash: expect.any(Object) }),
				excerpt: expect.any(String),
				excerptExactMatch: true,
				rights: { excerptAllowed: true, publicExportAllowed: true },
			});
		} else {
			expect(record).toMatchObject({
				documentId: null,
				locator: null,
				excerpt: null,
				excerptExactMatch: null,
				rights: { publicExportAllowed: false },
			});
		}
	}
	expect(
		evidenceRecords.some(
			(record) =>
				record.kind === "evidence" &&
				(record.sourceId === scanned.sourceId || record.sourceId === corrupt.sourceId) &&
				record.evidenceLevel === "fulltext_located",
		),
	).toBe(false);

	const allInputs = await artifactInputs(projectRoot);
	const claimRefs = allInputs.filter(({ kind }) => kind === "claim");
	const sourceRefs = allInputs.filter(({ kind }) => kind === "source");
	const reviewContent = await readFile(
		fileURLToPath(new URL(`../../evals/v0.1/reviews/${topic.slug}.md`, import.meta.url)),
		"utf8",
	);
	const artifactSpecs = [
		{
			action: "generate_structured",
			artifactType: "evidence-matrix",
			sourceRefs: claimRefs,
			targetStatus: "evidence_checked",
			outputPath: "artifacts/evidence-matrix.md",
		},
		{
			action: "commit_markdown",
			artifactType: "review",
			content: reviewContent,
			sourceRefs: claimRefs,
			targetStatus: "evidence_checked",
			outputPath: "artifacts/review.md",
		},
		{
			action: "generate_structured",
			artifactType: "json",
			sourceRefs: allInputs,
			targetStatus: "exploratory",
			outputPath: "artifacts/exports/sources.json",
		},
		{
			action: "generate_structured",
			artifactType: "ris",
			sourceRefs,
			targetStatus: "exploratory",
			outputPath: "artifacts/exports/export.ris",
		},
		{
			action: "generate_structured",
			artifactType: "bibtex",
			sourceRefs,
			targetStatus: "exploratory",
			outputPath: "artifacts/exports/export.bib",
		},
	] as const;
	const artifacts: Array<{ type: (typeof artifactSpecs)[number]["artifactType"]; record: Record<string, unknown> }> =
		[];
	for (const spec of artifactSpecs) {
		const result = await callTool(harness, "research_artifacts", spec, ctx);
		const record = await assertArtifact(projectRoot, result, spec.outputPath);
		artifacts.push({ type: spec.artifactType, record });
	}
	const matrix = await readFile(await resolveProjectPath(projectRoot, "artifacts/evidence-matrix.md"), "utf8");
	expect(matrix).toContain("mixed");
	expect(matrix).toContain("unsupported");
	expect(matrix).toContain("abstract");
	const review = await readFile(await resolveProjectPath(projectRoot, "artifacts/review.md"), "utf8");
	for (const marker of [
		"ABSTRACT_ONLY",
		"PAYWALL_BLOCKED",
		"MULTIPLE_VERSIONS",
		"METADATA_CONFLICT",
		"OCR_REQUIRED",
		"PARSE_FAILED",
		"PUBLICATION_WARNING",
		"MIXED",
		"INSUFFICIENT_EVIDENCE",
		"INTERRUPTION_RECOVERY",
	]) {
		expect(review).toContain(marker);
	}
	const exported = JSON.parse(
		await readFile(await resolveProjectPath(projectRoot, "artifacts/exports/sources.json"), "utf8"),
	) as Record<string, unknown>;
	expect(exported).toMatchObject({ format: "pi-research-record-export", version: 1, records: expect.any(Array) });
	expect(JSON.stringify(exported)).toContain("paywall_blocked");
	expect(JSON.stringify(exported)).toContain("ocr_required");
	expect(JSON.stringify(exported)).toContain("parse_failed");
	expect(await readFile(await resolveProjectPath(projectRoot, "artifacts/exports/export.ris"), "utf8")).toContain(
		topic.sourceTitle,
	);
	expect(await readFile(await resolveProjectPath(projectRoot, "artifacts/exports/export.bib"), "utf8")).toContain(
		`${topic.doiPrefix}.1`,
	);

	for (const artifact of artifacts) {
		const audit = object(artifact.record.audit);
		const validated = await callTool(
			harness,
			"research_artifacts",
			{
				action: "validate",
				artifactType: artifact.type,
				sourceRefs: [
					{
						kind: "artifact",
						id: string(artifact.record.artifactId),
						revision: audit.revision,
					},
				],
				targetStatus:
					artifact.type === "review" || artifact.type === "evidence-matrix" ? "evidence_checked" : "exploratory",
			},
			ctx,
		);
		expect(validated).toMatchObject({ ok: true });
	}

	const beforeRecovery = {
		sources: (await records(projectRoot, "source")).length,
		documents: (await records(projectRoot, "document")).length,
		evidence: (await records(projectRoot, "evidence")).length,
	};
	await recoverEveryKillPoint(harness, ctx, projectRoot);

	const cached = await callTool(
		harness,
		"research_search_sources",
		{
			queryPlanId: `${topic.slug}-plan`,
			queries: [
				{
					queryId: `${topic.slug}-query`,
					text: topic.query,
					adapterIds: ["crossref", "openalex"],
					filters: { fromYear: null, toYear: null, types: [] },
					maxResults: 2,
				},
			],
			budget: { maxUsd: 0.003, maxRequests: 2, hardStop: true },
			refresh: "use-cache",
		},
		ctx,
	);
	expect(cached).toMatchObject({ ok: true, value: { requestCount: 0 } });
	const reparsed = await callTool(
		harness,
		"research_documents",
		{
			action: "parse",
			sourceIds: [source1.sourceId],
			acquisitionPolicy: {
				allowOpenAccessDownload: true,
				allowPublisherLandingPageOnly: true,
				maxBytesPerFile: 1_000_000,
			},
		},
		ctx,
	);
	expect(reparsed).toMatchObject({ ok: true, value: { documents: [{ fullTextStatus: "parsed" }] } });
	opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const repeatedEvidence = await callTool(
		harness,
		"research_commit_evidence",
		{
			evidenceCards: [refutingDraft],
			claims: [],
			expectedRevision: opened.manifest.revision,
			validationMode: "strict",
		},
		ctx,
	);
	expect(repeatedEvidence).toMatchObject({ ok: true, value: { evidenceIds: [refutingEvidenceId] } });
	expect({
		sources: (await records(projectRoot, "source")).length,
		documents: (await records(projectRoot, "document")).length,
		evidence: (await records(projectRoot, "evidence")).length,
	}).toEqual(beforeRecovery);

	if (withDesign) {
		const claim = storedClaims[0];
		const evidence = evidenceRecords.find((record) => record.kind === "evidence");
		if (claim?.kind !== "claim" || evidence?.kind !== "evidence") {
			throw new Error("Scenario A design requires a Claim and EvidenceCard");
		}
		const basis = {
			summary: "Scenario A evidence supports a bounded design proposal but leaves method-specific gaps",
			provenance: [
				{ kind: "claim", id: claim.claimId, revision: claim.audit.revision },
				{ kind: "evidence", id: evidence.evidenceId, revision: evidence.audit.revision },
			],
			evidenceGap: true,
		};
		const confirmationsBefore = harness.confirm.mock.calls.length;
		const question = await createConfirmedDesign(harness, ctx, projectRoot, {
			action: "create_question",
			questionSeriesId: `${topic.slug}-design-question`,
			version: 1,
			text: `How is ${topic.title.toLowerCase()} associated with public-service outcomes, and how do participants explain the mechanism?`,
			questionType: "associational",
			rationale: "Scenario A identifies both located evidence and unresolved design gaps",
			scope: "Management and public-administration settings represented by the frozen fixture",
			boundaryConditions: ["No generalization beyond the declared population and cases"],
			basis,
			supersedesResearchQuestionVersionId: null,
		});
		const questionId = string(question.researchQuestionVersionId);
		const exposure = await createConfirmedDesign(harness, ctx, projectRoot, {
			action: "create_concept",
			name: "Governance intervention",
			definition: "The topic-specific institutional or managerial practice examined in Scenario A",
			role: "exposure",
			aliases: ["governance practice"],
			measurementNotes: ["Specify observable components before collection"],
			boundaryConditions: ["Public-sector organizational setting"],
			basis,
			supersedesConceptId: null,
		});
		const outcome = await createConfirmedDesign(harness, ctx, projectRoot, {
			action: "create_concept",
			name: "Public-service outcome",
			definition: "The declared organizational or resident-facing outcome of the governance practice",
			role: "outcome",
			aliases: ["service outcome"],
			measurementNotes: ["Keep organizational and individual outcomes distinct"],
			boundaryConditions: ["Outcome is observable in the selected setting"],
			basis,
			supersedesConceptId: null,
		});
		const exposureId = string(exposure.conceptId);
		const outcomeId = string(outcome.conceptId);
		const relation = await createConfirmedDesign(harness, ctx, projectRoot, {
			action: "create_relation",
			fromConceptId: exposureId,
			toConceptId: outcomeId,
			relationType: "association",
			direction: "conditional",
			statement: "The governance intervention may be associated with the service outcome under stated conditions",
			hypothesesOrPropositions: ["H1: the intervention is associated with the outcome in the sampled setting"],
			boundaryConditions: ["The intervention and outcome are measured in the same implementation period"],
			alternativeExplanations: ["Pre-existing organizational capacity"],
			basis,
			supersedesTheoryRelationId: null,
		});
		const relationId = string(relation.theoryRelationId);
		const decision = await createConfirmedDesign(harness, ctx, projectRoot, {
			action: "create_decision",
			decisionType: "method",
			question: "Which complementary methods should address the Scenario A design gap?",
			options: [
				{
					optionId: "complementary",
					label: "Panel association study plus comparative cases",
					description: "Keep statistical association and participant explanation as separate targets",
					tradeoffs: ["Requires two collection paths"],
					risks: ["Findings may diverge across methods"],
				},
				{
					optionId: "quantitative-only",
					label: "Panel association study only",
					description: "Estimate the association without a qualitative mechanism account",
					tradeoffs: ["Lower collection burden"],
					risks: ["Mechanism remains weakly observed"],
				},
			],
			selectedOptionId: "complementary",
			rationale: "The protocols answer distinct parts of the question without conflating claim modes",
			alternativesConsidered: ["Panel association study only"],
			limitations: ["Neither protocol automatically establishes a general causal effect"],
			basis,
			critical: true,
			supersedesDesignDecisionId: null,
		});
		const decisionId = string(decision.designDecisionId);
		const protocolCommon = {
			researchQuestionVersionId: questionId,
			population: "Organizations or participants represented by the Scenario A scope",
			timeframe: "One declared implementation cycle",
			samplingPlan: "Use documented eligibility and report coverage, nonresponse, and exclusions",
			measurementPlan: "Freeze construct definitions and observable indicators before analysis",
			dataCollectionPlan: "Collect only authorized records or consented research material",
			inclusionCriteria: ["Falls within the confirmed topic, population, and timeframe"],
			exclusionCriteria: ["Lacks a traceable link to the declared exposure or outcome"],
			alternativeExplanations: ["Pre-existing organizational capacity"],
			boundaryConditions: ["Frozen Scenario A management/public-administration scope"],
			feasibilityLimits: ["No claim beyond accessible organizations or cases"],
			ethicsChecklist: [
				{ item: "Human-subject and data-protection review", status: "required", note: "Not an approval" },
			],
			decisionIds: [decisionId],
			conceptIds: [exposureId, outcomeId],
			theoryRelationIds: [relationId],
			basis,
			supersedesProtocolId: null,
		};
		const quantitative = await createConfirmedDesign(harness, ctx, projectRoot, {
			action: "create_protocol",
			...protocolCommon,
			title: `${topic.title}: quantitative protocol`,
			designType: "quantitative",
			claimMode: "associational",
			method: "Panel association study",
			unitOfAnalysis: "organization-period",
			analysisPlan: "Estimate declared associations with robustness checks and non-causal wording",
			identificationStrategy: null,
			identificationAssumptions: [],
			preanalysisPlan: "Freeze variables, exclusions, models, uncertainty, and robustness checks",
			interviewPlan: null,
			caseSelectionPlan: null,
		});
		const qualitative = await createConfirmedDesign(harness, ctx, projectRoot, {
			action: "create_protocol",
			...protocolCommon,
			title: `${topic.title}: qualitative protocol`,
			designType: "qualitative",
			claimMode: "interpretive",
			method: "Comparative case study with semi-structured interviews",
			unitOfAnalysis: "implementation episode",
			analysisPlan: "Use a versioned codebook, source locators, negative cases, and a cross-case matrix",
			identificationStrategy: null,
			identificationAssumptions: [],
			preanalysisPlan: null,
			interviewPlan: "Use a consented role-specific guide and document nonresponse and contradictions",
			caseSelectionPlan: "Select contrasting cases using declared governance and capacity dimensions",
		});
		expect(harness.confirm.mock.calls.length - confirmationsBefore).toBe(7);
		const designRefs = [quantitative, qualitative].map((record) => {
			const revision = object(record.audit).revision;
			if (typeof revision !== "number") throw new Error("Missing protocol revision");
			return { kind: "protocol", id: string(record.protocolId), revision };
		});
		const designArtifact = await callTool(
			harness,
			"research_artifacts",
			{
				action: "generate_structured",
				artifactType: "research-design",
				sourceRefs: designRefs,
				targetStatus: "exploratory",
				outputPath: "artifacts/designs/scenario-a-design.md",
			},
			ctx,
		);
		await assertArtifact(projectRoot, designArtifact, "artifacts/designs/scenario-a-design.md");
		const designMarkdown = await readFile(
			await resolveProjectPath(projectRoot, "artifacts/designs/scenario-a-design.md"),
			"utf8",
		);
		expect(designMarkdown).toContain("quantitative protocol");
		expect(designMarkdown).toContain("qualitative protocol");
		await harness.commands.get("research-status")?.("full", ctx);
		const statusNotification = harness.notify.mock.calls.at(-1)?.[0];
		if (typeof statusNotification !== "string") throw new Error("Status command returned no result");
		expect(JSON.parse(statusNotification)).toMatchObject({
			ok: true,
			value: { stage: "research_design", designByStatus: { confirmed: 7 } },
		});
		await harness.commands.get("research-resume")?.("", ctx);
		const resumeNotification = harness.notify.mock.calls.at(-1)?.[0];
		if (typeof resumeNotification !== "string") throw new Error("Resume command returned no result");
		expect(JSON.parse(resumeNotification)).toMatchObject({
			ok: true,
			value: { designAwaitingConfirmation: [] },
		});
	}

	const adapterSearchOperations = (await records(projectRoot, "operation")).filter(
		(record): record is OperationRecord =>
			record.kind === "operation" &&
			record.adapterExecution !== null &&
			record.name.endsWith(".search") &&
			record.rawRequest !== null &&
			record.rawResponse !== null,
	);
	expect(new Set(adapterSearchOperations.map(({ adapterExecution }) => adapterExecution?.adapterId))).toEqual(
		new Set(["crossref", "openalex"]),
	);
	for (const operation of adapterSearchOperations) {
		if (operation.rawRequest === null || operation.rawResponse === null) throw new Error("Missing search receipt");
		expect((await hashFile(await resolveProjectPath(projectRoot, operation.rawRequest.path))).value).toBe(
			operation.rawRequest.hash?.value,
		);
		expect((await hashFile(await resolveProjectPath(projectRoot, operation.rawResponse.path))).value).toBe(
			operation.rawResponse.hash?.value,
		);
		expect(operation.usage.networkRequests).toBe(1);
	}
	const validation = await validateProject(projectRoot);
	expect(validation).toMatchObject({ valid: true, issues: [], pendingTransactionIds: [] });
	expect(
		JSON.stringify(await readFile(await resolveProjectPath(projectRoot, PROJECT_MANIFEST_PATH), "utf8")),
	).not.toContain(openAlexKey);
	expect(new Set(harness.toolCalls)).toEqual(new Set(withDesign ? V0_2_TOOL_NAMES : V0_1_TOOL_NAMES));

	return {
		L1: true,
		L2: harness.toolCalls.length > 0,
		L3: adapterSearchOperations.length >= 2,
		L4: gate.requiredArtifacts.every((path) =>
			artifacts.some(({ record }) => object(record.outputFile).path === path),
		),
		L5: validation.valid,
		L6: paywallDocument.fullTextStatus === "paywall_blocked",
		L7: storedClaims.some((claim) => claim.kind === "claim" && claim.supportStatus === "mixed"),
	};
}

describe("Scenario A release gate", () => {
	it("runs three frozen management and public-administration topics with all anomaly and recovery gates", async () => {
		const scenario = await loadFixture<ScenarioFixture>(scenarioPath);
		const gate = await loadFixture<ScenarioGate>(gatePath);
		expect(scenario.schemaVersion).toBe("0.1.0");
		expect(scenario.topics).toHaveLength(gate.requiredTopicCount);
		expect(scenario.scriptedToolSet).toEqual(V0_1_TOOL_NAMES);
		expect(Object.keys(gate.requiredAnomalies)).toHaveLength(10);
		for (const topic of scenario.topics) {
			const ladder = await runTopic(topic, scenario.evidenceCases, gate);
			expect(ladder).toEqual(Object.fromEntries(gate.requiredEvidenceLevels.map((level) => [level, true])));
		}
	}, 120_000);

	it("extends a Scenario A project into confirmed quantitative and qualitative designs", async () => {
		const scenario = await loadFixture<ScenarioFixture>(scenarioPath);
		const gate = await loadFixture<ScenarioGate>(gatePath);
		const topic = scenario.topics[0];
		if (topic === undefined) throw new Error("Scenario A has no topic");
		await runTopic(topic, scenario.evidenceCases, gate, true);
	}, 120_000);
});
