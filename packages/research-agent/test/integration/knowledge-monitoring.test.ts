import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createZoteroWriteIntent, parseZoteroWriteResponse } from "../../src/adapters/export/zotero.ts";
import { parseLocalImport } from "../../src/adapters/import/local.ts";
import {
	obsidianResearchIds,
	readStoredZip,
	renderDocx,
	renderObsidianVault,
	renderPdf,
	renderPptx,
	renderXlsx,
} from "../../src/artifacts/portable-formats.ts";
import { renderArtifact } from "../../src/artifacts/render.ts";
import type {
	ManuscriptRecord,
	MonitorSubscription,
	ResearchError,
	SectionRecord,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes } from "../../src/kernel/integrity.ts";
import { buildProjectCatalog, queryProjectCatalog } from "../../src/knowledge/catalog.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";
import { createExportProfile, recordZoteroLinks, sourcesNeedingExport } from "../../src/tools/knowledge.ts";
import { createMonitorSubscription, recordMonitorBatch } from "../../src/tools/monitoring.ts";
import { startOperation } from "../../src/tools/operations.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-v05-"));
	projectRoot = join(temporaryDirectory, "project-a");
	await initializeProject(projectRoot, { title: "Public-management monitor" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function operation(root = projectRoot, name = "v0.5.fixture") {
	const result = await startOperation(root, {
		operationKind: "tool",
		name,
		implementationVersion: "0.5.0",
		session: null,
	});
	if (!result.ok) throw new Error(result.errors[0].message);
	return result.value;
}

function audit(operationId: string) {
	const now = new Date().toISOString();
	return {
		createdAt: now,
		updatedAt: now,
		revision: 0,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

async function source(root: string, doi: string, title: string): Promise<SourceRecord> {
	const creator = await operation(root, "fixture.source");
	const source: SourceRecord = {
		kind: "source",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		sourceId: createOpaqueId("source"),
		identifiers: [{ scheme: "doi", value: doi, normalizedValue: doi, verified: false, verificationId: null }],
		title,
		titleNormalized: title.normalize("NFKC").toLowerCase(),
		contributors: [{ family: "Li", given: "Ming", literal: null, orcid: null }],
		issuedDate: "2025",
		containerTitle: "Synthetic Public Administration",
		publisher: "Fixture Press",
		sourceType: "journal-article",
		language: "en",
		abstractText: null,
		abstractRights: "metadata_only",
		discovery: [],
		dedupKeys: {
			doi,
			strongIdentifier: `doi:${doi}`,
			normalizedTitleYearFirstAuthor: `${title.toLowerCase()}|2025|li`,
			contentHash: null,
		},
		duplicateStatus: "canonical",
		canonicalSourceId: null,
		metadataConflicts: [],
		publicationStatus: "normal",
		audit: audit(creator.operationId),
	};
	const opened = await openProject(root);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	const created = await createRecord(root, source, {
		expectedManifestRevision: opened.manifest.revision,
		operationId: creator.operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	return source;
}

function manuscriptRecords(operationId: string): [ManuscriptRecord, SectionRecord] {
	const manuscriptId = createOpaqueId("manuscript");
	const sectionId = createOpaqueId("section");
	const content = "Evidence remains traceable to the source.";
	const section: SectionRecord = {
		kind: "section",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		sectionId,
		manuscriptId,
		sectionKey: "introduction",
		title: "Introduction",
		order: 0,
		content,
		contentHash: hashBytes(content),
		wordCount: 7,
		audit: audit(operationId),
	};
	const manuscript: ManuscriptRecord = {
		kind: "manuscript",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		manuscriptId,
		manuscriptSeriesId: createOpaqueId("manuscript"),
		version: 1,
		paperType: "literature_review",
		title: "Auditable research",
		abstract: "A synthetic fixture.",
		sectionIds: [sectionId],
		claimOccurrenceIds: [],
		bibliography: [],
		methodRecords: [],
		supersedesManuscriptId: null,
		authoring: { origin: "human", provider: null, modelId: null },
		contentHash: hashBytes(content),
		createdAt: new Date().toISOString(),
		audit: audit(operationId),
	};
	return [manuscript, section];
}

describe("v0.5 knowledge adapters and monitoring", () => {
	it("exports portable formats, escapes Obsidian paths, and preserves bibliography source ID hints", async () => {
		const item = await source(projectRoot, "10.5555/v05.1", 'CON: Governance / "Trust"');
		const vault = renderObsidianVault([item]);
		const vaultEntries = readStoredZip(vault);
		expect([...vaultEntries.keys()]).toContain("Research Index.md");
		expect([...vaultEntries.keys()].some((path) => /[\\:*?"<>|#[\]^]/u.test(path))).toBe(false);
		expect(obsidianResearchIds(vault)).toEqual([item.sourceId]);

		const creator = await operation(projectRoot, "fixture.manuscript");
		const manuscript = manuscriptRecords(creator.operationId);
		expect(readStoredZip(renderDocx(manuscript)).has("word/document.xml")).toBe(true);
		expect(readStoredZip(renderXlsx([item])).has("xl/worksheets/sheet1.xml")).toBe(true);
		expect(readStoredZip(renderPptx(manuscript)).has("ppt/presentation.xml")).toBe(true);
		expect(Buffer.from(renderPdf(manuscript)).subarray(0, 5).toString()).toBe("%PDF-");
		expect(() => renderPdf([{ ...manuscript[0], title: "中文标题" }, manuscript[1]])).toThrow("ASCII");

		for (const format of ["ris", "bibtex"] as const) {
			const rendered = renderArtifact(format, [item], null).content;
			if (typeof rendered !== "string") throw new Error("expected text bibliography");
			const content = Buffer.from(rendered);
			const parsed = parseLocalImport(
				{
					inputIndex: 0,
					originalFileName: `library.${format === "ris" ? "ris" : "bib"}`,
					format,
					mode: "copy",
					contentHash: hashBytes(content),
					bytes: content.byteLength,
					mediaType: "text/plain",
					storedFile: null,
					referencePath: null,
					portable: true,
				},
				content,
			);
			expect(parsed.sourceCandidates[0]?.sourceIdHint).toBe(item.sourceId);
		}
	});

	it("reconciles Zotero partial writes and skips an already synced source", async () => {
		const first = await source(projectRoot, "10.5555/v05.2", "Collaborative governance");
		const second = await source(projectRoot, "10.5555/v05.3", "Administrative burden");
		const creator = await operation(projectRoot, "fixture.profile");
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		const profileResult = await createExportProfile(projectRoot, {
			name: "Private Zotero library",
			adapterId: "zotero-api",
			adapterVersion: "0.5.0",
			format: "zotero-api",
			destination: { kind: "zotero_library", libraryType: "users", libraryId: "123" },
			credentialAlias: "ZOTERO_API_KEY",
			enabled: true,
			expectedManifestRevision: opened.manifest.revision,
			operationId: creator.operationId,
		});
		if (!profileResult.ok) throw new Error(profileResult.errors[0].message);
		const intent = createZoteroWriteIntent(profileResult.value, [first, second], creator.operationId);
		expect(intent).toMatchObject({
			method: "POST",
			url: "https://api.zotero.org/users/123/items",
			headers: { "Zotero-API-Version": "3" },
			credential: { alias: "ZOTERO_API_KEY" },
		});
		expect(intent.headers["Zotero-Write-Token"]).toHaveLength(32);
		const parsed = parseZoteroWriteResponse(
			JSON.stringify({
				successful: { 0: { key: "ITEM1", version: 7 } },
				failed: { 1: { code: 400, message: "invalid item" } },
			}),
			[first, second],
			"7",
		);
		const reconciled = await recordZoteroLinks(projectRoot, profileResult.value, parsed, creator.operationId);
		if (!reconciled.ok) throw new Error(reconciled.errors[0].message);
		expect(reconciled.value.links.map(({ syncStatus }) => syncStatus)).toEqual(["synced", "failed"]);
		expect(reconciled.value.retryTask?.status).toBe("failed_retryable");
		const next = await sourcesNeedingExport(projectRoot, profileResult.value.adapterExportProfileId, [first, second]);
		expect(next.pending.map(({ sourceId }) => sourceId)).toEqual([second.sourceId]);
		expect(next.reusedLinks).toHaveLength(1);
	});

	it("advances five monitor checkpoints atomically, preserves a failed cursor, and catalogs cross-project duplicates", async () => {
		const item = await source(projectRoot, "10.5555/v05.shared", "Shared source");
		const creator = await operation(projectRoot, "fixture.monitor.create");
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		const created = await createMonitorSubscription(projectRoot, {
			name: "Governance monitor",
			adapterId: "crossref",
			adapterVersion: "1.0.0",
			query: {
				text: "algorithmic governance",
				filters: { fromYear: 2020, toYear: null, types: [] },
				maxResults: 20,
			},
			budget: { maxCost: { amount: 0, currency: "USD" }, maxRequests: 2 },
			expectedManifestRevision: opened.manifest.revision,
			operationId: creator.operationId,
		});
		if (!created.ok) throw new Error(created.errors[0].message);
		let subscription = created.value;
		for (let batch = 1; batch <= 5; batch += 1) {
			const runner = await operation(projectRoot, `fixture.monitor.${batch}`);
			const current = await openProject(projectRoot);
			if (current.compatibility !== "current") throw new Error("expected current project");
			const result = await recordMonitorBatch(projectRoot, subscription, {
				createdSourceIds: batch === 1 ? [item.sourceId] : [],
				reusedSourceIds: batch === 1 ? [] : [item.sourceId],
				cursorAfter: `cursor-${batch}`,
				requestCount: 1,
				cost: { amount: 0, currency: "USD" },
				errors: [],
				confirmedAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				expectedManifestRevision: current.manifest.revision,
				operationId: runner.operationId,
			});
			if (!result.ok || result.value.nextSubscription === null) throw new Error("monitor batch failed");
			expect(result.value.run.cursorBefore).toBe(batch === 1 ? null : `cursor-${batch - 1}`);
			subscription = result.value.nextSubscription;
		}
		expect(subscription).toMatchObject({ version: 6, cursor: "cursor-5" });

		const failureOperation = await operation(projectRoot, "fixture.monitor.failure");
		const beforeFailure = await openProject(projectRoot);
		if (beforeFailure.compatibility !== "current") throw new Error("expected current project");
		const failure: ResearchError = {
			code: "MONITOR_RATE_LIMITED",
			category: "rate_limit",
			message: "Synthetic rate limit",
			retryable: true,
			source: "fixture",
			operationId: failureOperation.operationId,
			taskId: null,
			details: null,
			occurredAt: new Date().toISOString(),
			causeCode: null,
		};
		const failed = await recordMonitorBatch(projectRoot, subscription, {
			createdSourceIds: [],
			reusedSourceIds: [],
			cursorAfter: "must-not-commit",
			requestCount: 1,
			cost: { amount: 0, currency: "USD" },
			errors: [failure],
			confirmedAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			expectedManifestRevision: beforeFailure.manifest.revision,
			operationId: failureOperation.operationId,
		});
		if (!failed.ok) throw new Error(failed.errors[0].message);
		expect(failed.value).toMatchObject({
			run: { status: "failed_retryable", cursorBefore: "cursor-5", cursorAfter: "cursor-5" },
			nextSubscription: null,
			retryTask: { status: "failed_retryable" },
		});

		const otherRoot = join(temporaryDirectory, "project-b");
		await initializeProject(otherRoot, { title: "Second project" });
		await source(otherRoot, "10.5555/v05.shared", "Shared source elsewhere");
		const catalog = await buildProjectCatalog([
			{ root: projectRoot, locator: "projects/a" },
			{ root: otherRoot, locator: "projects/b" },
		]);
		expect(queryProjectCatalog(catalog, "doi:10.5555/v05.shared")).toHaveLength(2);
		expect(catalog.duplicates).toHaveLength(1);
		expect((await validateProject(projectRoot)).valid).toBe(true);
	});

	it("rejects a checkpoint that was not produced by its referenced run", async () => {
		const creator = await operation(projectRoot, "fixture.monitor.create");
		let opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		const created = await createMonitorSubscription(projectRoot, {
			name: "Checkpoint integrity",
			adapterId: "crossref",
			adapterVersion: "1.0.0",
			query: { text: "public trust", filters: { fromYear: null, toYear: null, types: [] }, maxResults: 10 },
			budget: { maxCost: { amount: 0, currency: "USD" }, maxRequests: 1 },
			expectedManifestRevision: opened.manifest.revision,
			operationId: creator.operationId,
		});
		if (!created.ok) throw new Error(created.errors[0].message);
		const runner = await operation(projectRoot, "fixture.monitor.run");
		opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		const recorded = await recordMonitorBatch(projectRoot, created.value, {
			createdSourceIds: [],
			reusedSourceIds: [],
			cursorAfter: "cursor-1",
			requestCount: 1,
			cost: { amount: 0, currency: "USD" },
			errors: [],
			confirmedAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			expectedManifestRevision: opened.manifest.revision,
			operationId: runner.operationId,
		});
		if (!recorded.ok || recorded.value.nextSubscription === null) throw new Error("monitor run failed");

		const forger = await operation(projectRoot, "fixture.monitor.forge");
		opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		const previous = recorded.value.nextSubscription;
		const forged: MonitorSubscription = {
			...previous,
			monitorSubscriptionId: createOpaqueId("monitor_subscription"),
			version: previous.version + 1,
			cursor: "forged-cursor",
			supersedesMonitorSubscriptionId: previous.monitorSubscriptionId,
			createdAt: new Date().toISOString(),
			audit: audit(forger.operationId),
		};
		const saved = await createRecord(projectRoot, forged, {
			expectedManifestRevision: opened.manifest.revision,
			operationId: forger.operationId,
		});
		if (!saved.ok) throw new Error(saved.errors[0].message);
		expect((await validateProject(projectRoot)).issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "INVALID_MONITOR_CHECKPOINT" })]),
		);
	});
});
