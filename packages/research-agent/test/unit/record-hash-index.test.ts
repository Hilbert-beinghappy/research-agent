import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import type { ClaimRecord, HashValue, ResearchProjectManifest } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../../src/kernel/integrity.ts";
import { atomicWriteFile } from "../../src/project/atomic-write.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import {
	derivedRecordHashIndexPath,
	type PreparedDerivedRecordHashIndex,
	prepareDerivedRecordHashIndex,
} from "../../src/project/record-hash-index.ts";
import { calculateRecordSetIndex, projectRecordPath } from "../../src/project/record-index.ts";
import { createRecord, createRecordWithWriterLeaseHeld, readRecord } from "../../src/project/records.ts";
import {
	commitPreparedTransaction,
	listPendingProjectTransactions,
	prepareProjectTransaction,
} from "../../src/project/transactions.ts";
import { withProjectWriterLease } from "../../src/project/writer-lock.ts";

interface StoredRecordHashIndex {
	format: "research-record-hash-index";
	version: 1;
	kind: "claim";
	basedOnManifestRevision: number;
	count: number;
	entries: Record<string, string>;
	contentHash: HashValue;
	generatedAt: string;
}

interface PreparedClaimUpdate {
	transactionId: string;
	recordPath: string;
	recordContent: string;
	index: PreparedDerivedRecordHashIndex;
}

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-record-index-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Derived record index" });
});

afterEach(async () => {
	delete process.env.RESEARCH_RECORD_INDEX_MODE;
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function claimRecord(claimId: string, operationId: string, text: string): ClaimRecord {
	const now = new Date().toISOString();
	return {
		kind: "claim",
		schemaVersion: "0.1.0",
		claimId,
		text,
		claimType: "theoretical",
		scope: "derived index test",
		evidenceLinks: [],
		supportStatus: "unassessed",
		conflictEvidenceIds: [],
		humanConfirmation: { status: "not_reviewed", decidedAt: null, note: null },
		publishability: "blocked",
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: operationId,
			updatedByOperationId: operationId,
		},
	};
}

function indexAbsolutePath(): string {
	return join(projectRoot, ...derivedRecordHashIndexPath("claim").split("/"));
}

async function readStoredIndex(): Promise<StoredRecordHashIndex> {
	return JSON.parse(await readFile(indexAbsolutePath(), "utf8")) as StoredRecordHashIndex;
}

async function createClaimAtRevision(revision: number, text: string): Promise<string> {
	const operationId = createOpaqueId("operation");
	const claimId = createOpaqueId("claim");
	await expect(
		createRecord(projectRoot, claimRecord(claimId, operationId, text), {
			expectedManifestRevision: revision,
			operationId,
		}),
	).resolves.toMatchObject({ ok: true, value: { id: claimId } });
	return claimId;
}

function expectManifestMatchesIndex(manifest: ResearchProjectManifest, index: StoredRecordHashIndex): void {
	const entries = Object.entries(index.entries)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([id, value]) => ({ id, hash: { algorithm: "sha256" as const, value } }));
	const recordSet = manifest.recordSets.find(({ kind }) => kind === "claim");
	expect(recordSet).toMatchObject({ count: index.count });
	expect(recordSet?.contentHash?.value).toBe(entries.length === 0 ? undefined : hashCanonicalJson(entries).value);
}

async function expectCanonicalClaimSetMatchesManifest(revision: number): Promise<void> {
	const opened = await openProject(projectRoot, revision);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	const actual = await calculateRecordSetIndex(projectRoot, opened.manifest, "claim");
	expect(opened.manifest.recordSets.find(({ kind }) => kind === "claim")).toMatchObject(actual);
}

async function prepareClaimUpdate(
	manifest: ResearchProjectManifest,
	claim: ClaimRecord,
	text: string,
): Promise<PreparedClaimUpdate> {
	const operationId = createOpaqueId("operation");
	const recordPath = projectRecordPath(manifest, "claim", claim.claimId);
	const oldContent = await readFile(join(projectRoot, ...recordPath.split("/")), "utf8");
	const updated: ClaimRecord = {
		...claim,
		text,
		audit: {
			...claim.audit,
			updatedAt: new Date().toISOString(),
			revision: claim.audit.revision + 1,
			updatedByOperationId: operationId,
		},
	};
	const recordContent = `${canonicalStringify(updated)}\n`;
	const index = await prepareDerivedRecordHashIndex(projectRoot, manifest, "claim", [
		{ id: claim.claimId, hash: hashBytes(recordContent) },
	]);
	const nextManifest: ResearchProjectManifest = {
		...manifest,
		recordSets: manifest.recordSets.map((recordSet) =>
			recordSet.kind === "claim" ? { ...recordSet, count: index.count, contentHash: index.contentHash } : recordSet,
		),
		lastCommittedOperationId: operationId,
		updatedAt: new Date().toISOString(),
		revision: manifest.revision + 1,
	};
	const transactionId = await prepareProjectTransaction(projectRoot, {
		expectedRevision: manifest.revision,
		writes: [{ path: recordPath, content: recordContent, expectedHash: hashBytes(oldContent) }, index.write],
		manifest: nextManifest,
	});
	return { transactionId, recordPath, recordContent, index };
}

describe("derived record hash index", () => {
	it("rebuilds missing, corrupt, stale, forged, and scan-mode indexes from canonical records", async () => {
		const firstClaimId = await createClaimAtRevision(0, "first");
		let index = await readStoredIndex();
		expect(index).toMatchObject({ basedOnManifestRevision: 1, count: 1 });

		await rm(indexAbsolutePath(), { force: true });
		await expectCanonicalClaimSetMatchesManifest(1);
		await createClaimAtRevision(1, "after missing index");
		index = await readStoredIndex();
		expect(index).toMatchObject({ basedOnManifestRevision: 2, count: 2 });

		await writeFile(indexAbsolutePath(), "{broken\n");
		await createClaimAtRevision(2, "after corrupt index");
		const staleIndex = await readFile(indexAbsolutePath(), "utf8");
		expect(await readStoredIndex()).toMatchObject({ basedOnManifestRevision: 3, count: 3 });

		await createClaimAtRevision(3, "before stale index");
		await writeFile(indexAbsolutePath(), staleIndex);
		await createClaimAtRevision(4, "after stale index");
		index = await readStoredIndex();
		expect(index).toMatchObject({ basedOnManifestRevision: 5, count: 5 });

		const firstEntry = Object.keys(index.entries).sort()[0];
		if (firstEntry === undefined) throw new Error("expected indexed claim");
		index.entries[firstEntry] = "0".repeat(64);
		index.contentHash = hashCanonicalJson(index.entries);
		await writeFile(indexAbsolutePath(), `${canonicalStringify(index)}\n`);
		await createClaimAtRevision(5, "after forged index");

		process.env.RESEARCH_RECORD_INDEX_MODE = "scan";
		await createClaimAtRevision(6, "forced canonical scan");
		delete process.env.RESEARCH_RECORD_INDEX_MODE;

		const opened = await openProject(projectRoot, 7);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		index = await readStoredIndex();
		expect(index).toMatchObject({ basedOnManifestRevision: 7, count: 7 });
		expectManifestMatchesIndex(opened.manifest, index);
		expect(await readRecord(projectRoot, "claim", firstClaimId)).toMatchObject({
			ok: true,
			value: { text: "first" },
		});
		await expectCanonicalClaimSetMatchesManifest(7);
	});

	it("allows only one concurrent create for the same record ID", async () => {
		const claimId = createOpaqueId("claim");
		const leftOperationId = createOpaqueId("operation");
		const rightOperationId = createOpaqueId("operation");
		const results = await Promise.all([
			createRecord(projectRoot, claimRecord(claimId, leftOperationId, "left"), {
				expectedManifestRevision: 0,
				operationId: leftOperationId,
			}),
			createRecord(projectRoot, claimRecord(claimId, rightOperationId, "right"), {
				expectedManifestRevision: 0,
				operationId: rightOperationId,
			}),
		]);

		expect(results.filter(({ ok }) => ok)).toHaveLength(1);
		expect(results.filter(({ ok }) => !ok)).toMatchObject([{ status: "DATA_CONFLICT" }]);
		const opened = await openProject(projectRoot, 1);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		expect(opened.manifest.recordSets.find(({ kind }) => kind === "claim")?.count).toBe(1);
		await expectCanonicalClaimSetMatchesManifest(1);
	});

	it("rejects a true nested writer-lease acquisition", async () => {
		await expect(
			withProjectWriterLease(projectRoot, () => withProjectWriterLease(projectRoot, async () => undefined)),
		).rejects.toThrow("PROJECT_WRITER_LOCK_REENTRANT");
	});

	it("rejects the internal record writer when no lease is held", async () => {
		const operationId = createOpaqueId("operation");
		const claimId = createOpaqueId("claim");
		await expect(
			createRecordWithWriterLeaseHeld(projectRoot, claimRecord(claimId, operationId, "lease required"), {
				expectedManifestRevision: 0,
				operationId,
			}),
		).resolves.toMatchObject({
			ok: false,
			status: "PERMANENT_FAILURE",
			errors: [{ message: expect.stringContaining("PROJECT_WRITER_LEASE_REQUIRED") }],
		});
		await expect(openProject(projectRoot, 0)).resolves.toMatchObject({ compatibility: "current" });
	});

	it("recovers record-before-index and index-before-manifest interruptions", async () => {
		const claimId = await createClaimAtRevision(0, "initial");
		const opened = await openProject(projectRoot, 1);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		const loaded = await readRecord(projectRoot, "claim", claimId);
		if (!loaded.ok || loaded.value.kind !== "claim") throw new Error("expected claim record");

		const recordFirst = await prepareClaimUpdate(opened.manifest, loaded.value, "record committed first");
		await atomicWriteFile(join(projectRoot, ...recordFirst.recordPath.split("/")), recordFirst.recordContent);
		await commitPreparedTransaction(projectRoot, recordFirst.transactionId);
		expect(await readStoredIndex()).toMatchObject({ basedOnManifestRevision: 2, count: 1 });
		await expect(openProject(projectRoot, 2)).resolves.toMatchObject({ compatibility: "current" });

		const openedAgain = await openProject(projectRoot, 2);
		if (openedAgain.compatibility !== "current") throw new Error("expected current project");
		const loadedAgain = await readRecord(projectRoot, "claim", claimId);
		if (!loadedAgain.ok || loadedAgain.value.kind !== "claim") throw new Error("expected claim record");
		const indexFirst = await prepareClaimUpdate(openedAgain.manifest, loadedAgain.value, "index committed first");
		await atomicWriteFile(join(projectRoot, ...indexFirst.recordPath.split("/")), indexFirst.recordContent);
		await atomicWriteFile(indexAbsolutePath(), indexFirst.index.write.content);
		await commitPreparedTransaction(projectRoot, indexFirst.transactionId);

		await expect(openProject(projectRoot, 3)).resolves.toMatchObject({ compatibility: "current" });
		expect(await readStoredIndex()).toMatchObject({ basedOnManifestRevision: 3, count: 1 });
		await expectCanonicalClaimSetMatchesManifest(3);
		expect(await listPendingProjectTransactions(projectRoot)).toEqual([]);
	});
});
