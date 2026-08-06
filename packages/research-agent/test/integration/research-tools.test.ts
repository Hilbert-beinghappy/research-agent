import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecordedHttpTransport, type RecordedHttpExchange } from "../../src/adapters/http/transport.ts";
import { registerResearchCommands } from "../../src/extension/commands.ts";
import { RESEARCH_TOOL_NAMES, type RegisterResearchToolsOptions } from "../../src/extension/tools.ts";
import { openProject } from "../../src/project/open.ts";
import { listProjectRecordIds } from "../../src/project/record-index.ts";
import { readRecord, updateRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
let temporaryDirectory: string | undefined;

afterEach(async () => {
	if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
});

function searchUrl(): string {
	const url = new URL("https://api.crossref.org/v1/works");
	url.searchParams.set("query.bibliographic", "algorithmic governance");
	url.searchParams.set("rows", "2");
	url.searchParams.set("cursor", "*");
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

function unpaywallUrl(doi: string): string {
	const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
	url.searchParams.set("email", "fixture@example.test");
	return url.toString();
}

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

function openAlexSearchUrl(apiKey: string): string {
	const url = new URL("https://api.openalex.org/works");
	url.searchParams.set("search", "algorithmic governance");
	url.searchParams.set("per_page", "2");
	url.searchParams.set("cursor", "*");
	url.searchParams.set("select", openAlexSelectedFields);
	url.searchParams.set("api_key", apiKey);
	return url.toString();
}

function lookupBody(): string {
	return JSON.stringify({
		status: "ok",
		"message-type": "work",
		"message-version": "1.0.0",
		message: {
			DOI: "10.5555/governance.1",
			title: ["Algorithmic Governance in Public Organizations"],
			author: [{ given: "Lin", family: "Chen", ORCID: "https://orcid.org/0000-0000-0000-0001" }],
			issued: { "date-parts": [[2023, 5, 2]] },
			"container-title": ["Journal of Synthetic Public Administration"],
			publisher: "Fixture Press",
			type: "journal-article",
			language: "en",
			URL: "https://doi.org/10.5555/governance.1",
		},
	});
}

function statusBody(): string {
	return JSON.stringify({
		status: "ok",
		"message-type": "work-list",
		"message-version": "1.0.0",
		message: { "total-results": 0, items: [] },
	});
}

async function exchanges(): Promise<RecordedHttpExchange[]> {
	const pdf = await readFile(join(fixtures, "documents/text-layer.pdf"));
	return [
		{
			request: { method: "GET", url: searchUrl(), body: null },
			response: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: await readFile(join(fixtures, "crossref/search-page-1.json"), "utf8"),
			},
		},
		{
			request: { method: "GET", url: unpaywallUrl("10.5555/governance.1"), body: null },
			response: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: await readFile(join(fixtures, "unpaywall/oa-multiple.json"), "utf8"),
			},
		},
		{
			request: { method: "GET", url: unpaywallUrl("10.5555/governance.1"), body: null },
			response: {
				status: 200,
				headers: { "content-type": "application/json" },
				body: await readFile(join(fixtures, "unpaywall/oa-multiple.json"), "utf8"),
			},
		},
		{
			request: {
				method: "GET",
				url: "https://publisher.example/articles/governance-1.pdf",
				body: null,
			},
			response: {
				status: 200,
				headers: { "content-type": "application/pdf" },
				body: pdf.toString("base64"),
				bodyBytes: pdf.byteLength,
			},
		},
		{
			request: { method: "GET", url: crossrefLookupUrl("10.5555/governance.1"), body: null },
			response: { status: 200, headers: { "content-type": "application/json" }, body: lookupBody() },
		},
		{
			request: { method: "GET", url: crossrefStatusUrl("10.5555/governance.1"), body: null },
			response: { status: 200, headers: { "content-type": "application/json" }, body: statusBody() },
		},
	];
}

function createHarness(
	transport: ReturnType<typeof createRecordedHttpTransport>,
	credentialAliases: NonNullable<RegisterResearchToolsOptions["credentialAliases"]> = {
		unpaywallEmail: "unpaywall-email",
	},
	credentials: Readonly<Record<string, string>> = { "unpaywall-email": "fixture@example.test" },
) {
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, ToolDefinition>();
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
	registerResearchCommands(pi, "0.1.0", {
		http: {
			transport,
			resolveCredential: async (alias) => {
				const value = credentials[alias];
				if (value === undefined) throw new Error(`Unexpected credential alias: ${alias}`);
				return value;
			},
			wait: async () => {},
			random: () => 0,
		},
		credentialAliases,
	});

	const context = (cwd: string): ExtensionCommandContext =>
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
				getSessionId: () => "research-tools-session",
				getSessionFile: () => join(cwd, "session.jsonl"),
				getEntries: () => [...entries],
			},
		}) as unknown as ExtensionCommandContext;

	return { commands, tools, notify, confirm, activeTools: () => activeTools, context };
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Expected array");
	return value;
}

async function callTool(
	harness: ReturnType<typeof createHarness>,
	name: string,
	params: object,
	ctx: ExtensionContext,
): Promise<Record<string, unknown>> {
	const tool = harness.tools.get(name);
	if (tool === undefined) throw new Error(`Missing tool: ${name}`);
	const result = await tool.execute(`call-${name}`, params, new AbortController().signal, undefined, ctx);
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("Tool did not return JSON text");
	return object(JSON.parse(content.text));
}

describe("research tools", () => {
	it("runs the M1 aggregate-tool vertical without direct canonical writes", async () => {
		temporaryDirectory = join(tmpdir(), `pi-research-tools-${crypto.randomUUID()}`);
		const harness = createHarness(createRecordedHttpTransport(await exchanges()));
		const ctx = harness.context(temporaryDirectory);
		expect([...harness.tools.keys()]).toEqual(RESEARCH_TOOL_NAMES);
		await harness.commands.get("research-init")?.("Research Tools Fixture", ctx);
		expect(harness.activeTools().sort()).toEqual(["read", ...RESEARCH_TOOL_NAMES].sort());

		const search = await callTool(
			harness,
			"research_search_sources",
			{
				queryPlanId: "plan-fixture",
				queries: [
					{
						queryId: "query-fixture",
						text: "algorithmic governance",
						adapterIds: ["crossref"],
						filters: { fromYear: null, toYear: null, types: [] },
						maxResults: 2,
					},
				],
				budget: { maxUsd: 0, maxRequests: 3, hardStop: true },
				refresh: "revalidate",
			},
			ctx,
		);
		expect(search).toMatchObject({ ok: true, value: { requestCount: 1, cost: { amount: 0, currency: "USD" } } });
		const searchValue = object(search.value);
		const sourceIds = array(searchValue.createdSourceIds);
		expect(sourceIds).toHaveLength(2);
		const sourceId = sourceIds[0];
		if (typeof sourceId !== "string") throw new Error("Missing source ID");

		const cached = await callTool(
			harness,
			"research_search_sources",
			{
				queryPlanId: "plan-fixture",
				queries: [
					{
						queryId: "query-fixture",
						text: "algorithmic governance",
						adapterIds: ["crossref"],
						filters: { fromYear: null, toYear: null, types: [] },
						maxResults: 2,
					},
				],
				budget: { maxUsd: 0, maxRequests: 1, hardStop: true },
				refresh: "use-cache",
			},
			ctx,
		);
		expect(cached).toMatchObject({ ok: true, value: { requestCount: 0, runs: [{ status: "cached" }] } });

		const imported = await callTool(
			harness,
			"research_import_sources",
			{
				inputs: [{ path: join(fixtures, "imports/library.ris"), format: "ris", mode: "copy" }],
				dedupe: "exact-and-review-candidates",
			},
			ctx,
		);
		expect(imported).toMatchObject({ ok: true, value: { portable: true } });

		const acquired = await callTool(
			harness,
			"research_documents",
			{
				action: "acquire",
				sourceIds: [sourceId],
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
			value: { documents: [{ sourceId, fullTextStatus: "acquired_unparsed", accessStatus: "open_access" }] },
		});

		const parsed = await callTool(
			harness,
			"research_documents",
			{
				action: "parse",
				sourceIds: [sourceId],
				acquisitionPolicy: {
					allowOpenAccessDownload: true,
					allowPublisherLandingPageOnly: true,
					maxBytesPerFile: 1_000_000,
				},
			},
			ctx,
		);
		expect(parsed).toMatchObject({ ok: true, value: { documents: [{ fullTextStatus: "parsed", pageCount: 2 }] } });

		const corpus = await callTool(
			harness,
			"research_query_corpus",
			{
				query: "Collaborative governance",
				scope: "documents",
				filters: { sourceId },
				limit: 5,
				maxCharsPerHit: 4_000,
				cursor: null,
			},
			ctx,
		);
		expect(corpus).toMatchObject({ ok: true, meta: { operationId: null } });
		const hit = object(array(object(corpus.value).hits)[0]);
		const documentId = hit.documentId;
		const excerpt = hit.text;
		if (typeof documentId !== "string" || typeof excerpt !== "string") throw new Error("Missing corpus hit");

		let opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const claimResult = await callTool(
			harness,
			"research_commit_evidence",
			{
				evidenceCards: [],
				claims: [
					{
						text: "Collaborative governance improves service coordination.",
						claimType: "descriptive",
						scope: "Synthetic fixture",
						evidenceLinks: [],
						conflictEvidenceIds: [],
					},
				],
				expectedRevision: opened.manifest.revision,
				validationMode: "strict",
			},
			ctx,
		);
		expect(claimResult).toMatchObject({ ok: true, value: { claimIds: [expect.any(String)] } });
		const claimId = array(object(claimResult.value).claimIds)[0];
		if (typeof claimId !== "string") throw new Error("Missing claim ID");

		opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const evidence = await callTool(
			harness,
			"research_commit_evidence",
			{
				evidenceCards: [
					{
						sourceId,
						documentId,
						evidenceLevel: "fulltext_located",
						locator: hit.locator,
						excerpt,
						excerptExactMatch: true,
						paraphrase: "The fixture reports improved coordination under collaborative governance.",
						evidenceStatement: "Collaborative governance is associated with better service coordination.",
						claimLinks: [{ claimId, relation: "supports", rationale: "Direct located statement" }],
						extraction: { method: "deterministic" },
						confidence: { level: "high", basis: "Exact located text", limitations: ["Synthetic fixture"] },
						rights: { excerptAllowed: true, maxStoredWords: 100, publicExportAllowed: true },
						humanStatus: "not_reviewed",
						supersedesEvidenceId: null,
					},
				],
				claims: [],
				expectedRevision: opened.manifest.revision,
				validationMode: "strict",
			},
			ctx,
		);
		expect(evidence).toMatchObject({
			ok: true,
			value: {
				evidenceIds: [expect.any(String)],
				evidenceLevels: [{ evidenceLevel: "fulltext_located" }],
				supportStatuses: [{ claimId, supportStatus: "supported" }],
			},
		});
		expect(harness.confirm).not.toHaveBeenCalled();
		const firstEvidenceId = array(object(evidence.value).evidenceIds)[0];
		if (typeof firstEvidenceId !== "string") throw new Error("Missing evidence ID");
		const evidenceOperationId = object(evidence.meta).operationId;
		if (typeof evidenceOperationId !== "string") throw new Error("Missing evidence operation ID");
		let storedClaim = await readRecord(temporaryDirectory, "claim", claimId);
		expect(storedClaim).toMatchObject({
			ok: true,
			value: {
				supportStatus: "supported",
				evidenceLinks: [{ evidenceId: firstEvidenceId, relation: "supports" }],
				publishability: "exploratory",
			},
		});
		if (!storedClaim.ok || storedClaim.value.kind !== "claim") throw new Error("Missing stored claim");
		opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const conflictingClaim = await callTool(
			harness,
			"research_commit_evidence",
			{
				evidenceCards: [],
				claims: [
					{
						text: "Collaborative governance always reduces service coordination.",
						claimType: "descriptive",
						scope: "Synthetic fixture",
						evidenceLinks: [
							{
								evidenceId: firstEvidenceId,
								relation: "refutes",
								assessment: "The located statement reports the opposite relationship.",
							},
						],
						conflictEvidenceIds: [firstEvidenceId],
					},
				],
				expectedRevision: opened.manifest.revision,
				validationMode: "strict",
			},
			ctx,
		);
		expect(conflictingClaim).toMatchObject({
			ok: true,
			value: { supportStatuses: [{ supportStatus: "contradicted" }] },
		});
		opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const frozen = await updateRecord(opened.root, "claim", claimId, {
			expectedManifestRevision: opened.manifest.revision,
			expectedRecordRevision: storedClaim.value.audit.revision,
			operationId: evidenceOperationId,
			changes: {
				humanConfirmation: {
					status: "accepted",
					decidedAt: "2026-08-06T00:00:00.000Z",
					note: "Frozen fixture claim",
				},
			},
		});
		expect(frozen).toMatchObject({ ok: true });

		opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const qualificationDraft = {
			sourceId,
			documentId,
			evidenceLevel: "fulltext_located",
			locator: hit.locator,
			excerpt,
			excerptExactMatch: true,
			paraphrase: "The fixture only establishes the relationship in its synthetic setting.",
			evidenceStatement: "The reported relationship is limited to the fixture setting.",
			claimLinks: [{ claimId, relation: "qualifies", rationale: "Scope qualification" }],
			extraction: { method: "deterministic" },
			confidence: { level: "high", basis: "Exact located text", limitations: ["Synthetic fixture"] },
			rights: { excerptAllowed: true, maxStoredWords: 100, publicExportAllowed: true },
			humanStatus: "not_reviewed",
			supersedesEvidenceId: null,
		};
		const qualifiedEvidence = await callTool(
			harness,
			"research_commit_evidence",
			{
				evidenceCards: [qualificationDraft],
				claims: [],
				expectedRevision: opened.manifest.revision,
				validationMode: "strict",
			},
			ctx,
		);
		expect(qualifiedEvidence).toMatchObject({
			ok: true,
			value: { supportStatuses: [{ claimId, supportStatus: "partially_supported" }] },
		});
		const qualifiedEvidenceId = array(object(qualifiedEvidence.value).evidenceIds)[0];
		if (typeof qualifiedEvidenceId !== "string") throw new Error("Missing qualified evidence ID");
		expect(harness.confirm).toHaveBeenCalledTimes(1);
		const qualifiedOperationId = object(qualifiedEvidence.meta).operationId;
		if (typeof qualifiedOperationId !== "string") throw new Error("Missing qualified evidence operation ID");
		const qualifiedOperation = await readRecord(temporaryDirectory, "operation", qualifiedOperationId);
		expect(qualifiedOperation).toMatchObject({
			ok: true,
			value: { status: "succeeded", approvalIds: [expect.any(String)] },
		});
		storedClaim = await readRecord(temporaryDirectory, "claim", claimId);
		expect(storedClaim).toMatchObject({
			ok: true,
			value: {
				supportStatus: "partially_supported",
				evidenceLinks: [{ evidenceId: firstEvidenceId, relation: "supports" }, { relation: "qualifies" }],
				humanConfirmation: { status: "accepted" },
				publishability: "exploratory",
			},
		});

		opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const evidenceCount = (await listProjectRecordIds(opened.root, opened.manifest, "evidence")).length;
		const repeatedEvidence = await callTool(
			harness,
			"research_commit_evidence",
			{
				evidenceCards: [qualificationDraft],
				claims: [],
				expectedRevision: opened.manifest.revision,
				validationMode: "strict",
			},
			ctx,
		);
		expect(repeatedEvidence).toMatchObject({
			ok: true,
			value: {
				evidenceIds: [qualifiedEvidenceId],
				supportStatuses: [{ claimId, supportStatus: "partially_supported" }],
			},
		});
		expect(harness.confirm).toHaveBeenCalledTimes(1);
		opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		expect(await listProjectRecordIds(opened.root, opened.manifest, "evidence")).toHaveLength(evidenceCount);
		harness.confirm.mockResolvedValue(false);
		const deniedEvidence = await callTool(
			harness,
			"research_commit_evidence",
			{
				evidenceCards: [
					{
						sourceId,
						documentId,
						evidenceLevel: "fulltext_located",
						locator: hit.locator,
						excerpt,
						excerptExactMatch: true,
						paraphrase: "The fixture does not justify a universal causal interpretation.",
						evidenceStatement: "The reported relationship does not establish a universal causal effect.",
						claimLinks: [{ claimId, relation: "refutes", rationale: "Causal overreach" }],
						extraction: { method: "deterministic" },
						confidence: { level: "high", basis: "Exact located text", limitations: ["Synthetic fixture"] },
						rights: { excerptAllowed: true, maxStoredWords: 100, publicExportAllowed: true },
						humanStatus: "not_reviewed",
						supersedesEvidenceId: null,
					},
				],
				claims: [],
				expectedRevision: opened.manifest.revision,
				validationMode: "strict",
			},
			ctx,
		);
		expect(deniedEvidence).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "CLAIM_LINK_UPDATE_DENIED" }],
		});
		expect(harness.confirm).toHaveBeenCalledTimes(2);
		opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		expect(await listProjectRecordIds(opened.root, opened.manifest, "evidence")).toHaveLength(evidenceCount);
		storedClaim = await readRecord(temporaryDirectory, "claim", claimId);
		expect(storedClaim).toMatchObject({ ok: true, value: { supportStatus: "partially_supported" } });

		const citations = await callTool(
			harness,
			"research_verify_citations",
			{
				sourceIds: [sourceId],
				providers: ["crossref"],
				refresh: "revalidate",
				matchThresholds: { title: 0.85, author: 0.8, yearTolerance: 1 },
			},
			ctx,
		);
		expect(citations).toMatchObject({
			ok: true,
			value: { verifications: [{ sourceId, finalStatus: "verified_with_warning", publicationStatus: "unknown" }] },
		});

		opened = await openProject(temporaryDirectory);
		if (opened.compatibility !== "current") throw new Error("Expected current project");
		const source = await readRecord(opened.root, "source", sourceId);
		expect(source).toMatchObject({ ok: true, value: { sourceId, duplicateStatus: "canonical" } });
		const validation = await validateProject(opened.root);
		expect(validation.issues).toEqual([]);
		expect(validation).toMatchObject({ valid: true, pendingTransactionIds: [] });
	}, 15_000);

	it("records approval for a metered OpenAlex search without persisting the credential", async () => {
		temporaryDirectory = join(tmpdir(), `pi-research-tools-openalex-${crypto.randomUUID()}`);
		const apiKey = "fixture-openalex-key";
		const harness = createHarness(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: openAlexSearchUrl(apiKey), body: null },
					response: {
						status: 200,
						headers: { "content-type": "application/json" },
						body: await readFile(join(fixtures, "openalex/search-page-1.json"), "utf8"),
					},
				},
			]),
			{ openalexApiKey: "openalex-api-key" },
			{ "openalex-api-key": apiKey },
		);
		const ctx = harness.context(temporaryDirectory);
		await harness.commands.get("research-init")?.("OpenAlex Approval Fixture", ctx);
		const searched = await callTool(
			harness,
			"research_search_sources",
			{
				queryPlanId: "plan-openalex",
				queries: [
					{
						queryId: "query-openalex",
						text: "algorithmic governance",
						adapterIds: ["openalex"],
						filters: { fromYear: null, toYear: null, types: [] },
						maxResults: 2,
					},
				],
				budget: { maxUsd: 0.003, maxRequests: 1, hardStop: true },
				refresh: "revalidate",
			},
			ctx,
		);
		expect(searched).toMatchObject({
			ok: true,
			value: { requestCount: 1, cost: { amount: 0.001, currency: "USD" } },
		});
		expect(harness.confirm).toHaveBeenCalledTimes(1);
		const run = object(array(object(searched.value).runs)[0]);
		const adapterOperationId = array(run.operationIds)[0];
		if (typeof adapterOperationId !== "string") throw new Error("Missing OpenAlex operation ID");
		const operation = await readRecord(temporaryDirectory, "operation", adapterOperationId);
		expect(operation).toMatchObject({
			ok: true,
			value: {
				status: "succeeded",
				approvalIds: [expect.any(String)],
				usage: { networkRequests: 1, cost: { amount: 0.001, currency: "USD" } },
			},
		});
		if (!operation.ok || operation.value.kind !== "operation") throw new Error("Missing OpenAlex operation");
		const approvalId = operation.value.approvalIds[0];
		if (approvalId === undefined || operation.value.rawRequest === null) throw new Error("Missing approval receipt");
		const approval = await readRecord(temporaryDirectory, "approval", approvalId);
		expect(approval).toMatchObject({
			ok: true,
			value: { actionClass: "paid_service_call", decision: "approved", operationId: adapterOperationId },
		});
		const requestReceipt = await readFile(join(temporaryDirectory, operation.value.rawRequest.path), "utf8");
		expect(requestReceipt).toContain("openalex-api-key");
		expect(requestReceipt).not.toContain(apiKey);
		const validation = await validateProject(temporaryDirectory);
		expect(validation).toMatchObject({ valid: true, issues: [], pendingTransactionIds: [] });
	});

	it("preserves the aggregate permission status when credential resolution fails", async () => {
		temporaryDirectory = join(tmpdir(), `pi-research-tools-permission-${crypto.randomUUID()}`);
		const harness = createHarness(createRecordedHttpTransport([]), { openalexApiKey: "missing-openalex-key" }, {});
		const ctx = harness.context(temporaryDirectory);
		await harness.commands.get("research-init")?.("Permission Failure Fixture", ctx);
		const searched = await callTool(
			harness,
			"research_search_sources",
			{
				queryPlanId: "plan-permission",
				queries: [
					{
						queryId: "query-permission",
						text: "algorithmic governance",
						adapterIds: ["openalex"],
						filters: { fromYear: null, toYear: null, types: [] },
						maxResults: 2,
					},
				],
				budget: { maxUsd: 0.003, maxRequests: 1, hardStop: true },
				refresh: "revalidate",
			},
			ctx,
		);
		expect(searched).toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "CREDENTIAL_UNAVAILABLE", category: "permission" }],
		});
		expect(harness.confirm).toHaveBeenCalledTimes(1);
		const operationId = object(searched.meta).operationId;
		if (typeof operationId !== "string") throw new Error("Missing failed search operation ID");
		const operation = await readRecord(temporaryDirectory, "operation", operationId);
		expect(operation).toMatchObject({ ok: true, value: { status: "blocked" } });
		const validation = await validateProject(temporaryDirectory);
		expect(validation).toMatchObject({ valid: true, issues: [], pendingTransactionIds: [] });
	});
});
