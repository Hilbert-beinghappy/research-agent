import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaimRecord } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, deleteRecord, readRecord, updateRecord } from "../../src/project/records.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-records-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Record repository" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function claimRecord(claimId: string, operationId: string): ClaimRecord & { futureField: { keep: boolean } } {
	const now = new Date().toISOString();
	return {
		kind: "claim",
		schemaVersion: "0.1.0",
		claimId,
		text: "Transparency may affect public trust.",
		claimType: "theoretical",
		scope: "literature review",
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
		futureField: { keep: true },
	};
}

describe("record repository", () => {
	it("creates, reads, updates, and deletes only through manifest-last transactions", async () => {
		const claimId = createOpaqueId("claim");
		const createOperationId = createOpaqueId("operation");
		const claim = claimRecord(claimId, createOperationId);

		await expect(
			createRecord(projectRoot, claim, { expectedManifestRevision: 0, operationId: createOperationId }),
		).resolves.toMatchObject({ ok: true, value: { kind: "claim", id: claimId, revision: 0 } });
		const afterCreate = await openProject(projectRoot, 1);
		if (afterCreate.compatibility !== "current") throw new Error("expected current project");
		expect(afterCreate.manifest.recordSets.find(({ kind }) => kind === "claim")).toMatchObject({
			count: 1,
			contentHash: { algorithm: "sha256" },
		});

		const duplicate = await createRecord(projectRoot, claim, {
			expectedManifestRevision: 1,
			operationId: createOperationId,
		});
		expect(duplicate).toMatchObject({ ok: false, status: "DATA_CONFLICT" });

		const updateOperationId = createOpaqueId("operation");
		await expect(
			updateRecord(projectRoot, "claim", claimId, {
				expectedManifestRevision: 1,
				expectedRecordRevision: 0,
				operationId: updateOperationId,
				changes: { text: "Transparency is associated with public trust." },
			}),
		).resolves.toMatchObject({ ok: true, value: { revision: 1 } });

		const read = await readRecord(projectRoot, "claim", claimId);
		expect(read).toMatchObject({ ok: true });
		if (!read.ok || read.value.kind !== "claim") throw new Error("expected claim record");
		expect(read.value.text).toBe("Transparency is associated with public trust.");
		expect((read.value as typeof claim).futureField).toEqual({ keep: true });
		expect(read.value.audit).toMatchObject({ revision: 1, updatedByOperationId: updateOperationId });

		const staleOperationId = createOpaqueId("operation");
		const stale = await updateRecord(projectRoot, "claim", claimId, {
			expectedManifestRevision: 2,
			expectedRecordRevision: 0,
			operationId: staleOperationId,
			changes: { text: "stale overwrite" },
		});
		expect(stale).toMatchObject({ ok: false, status: "DATA_CONFLICT" });

		const deleteOperationId = createOpaqueId("operation");
		await expect(
			deleteRecord(projectRoot, "claim", claimId, {
				expectedManifestRevision: 2,
				expectedRecordRevision: 1,
				operationId: deleteOperationId,
			}),
		).resolves.toMatchObject({ ok: true, value: { revision: 1 } });
		const afterDelete = await openProject(projectRoot, 3);
		if (afterDelete.compatibility !== "current") throw new Error("expected current project");
		expect(afterDelete.manifest.recordSets.find(({ kind }) => kind === "claim")).toMatchObject({
			count: 0,
			contentHash: null,
		});
		await expect(readRecord(projectRoot, "claim", claimId)).resolves.toMatchObject({
			ok: false,
			errors: [{ code: "RECORD_NOT_FOUND" }],
		});

		expect(await readdir(join(projectRoot, ".research", "transactions", "committed"))).toHaveLength(3);
		expect(await readdir(join(projectRoot, ".research", "transactions", "pending"))).toEqual([]);
	});

	it("returns DATA_CONFLICT for a stale manifest revision without writing", async () => {
		const operationId = createOpaqueId("operation");
		const claim = claimRecord(createOpaqueId("claim"), operationId);
		const result = await createRecord(projectRoot, claim, { expectedManifestRevision: 1, operationId });
		expect(result).toMatchObject({ ok: false, status: "DATA_CONFLICT" });
		await expect(openProject(projectRoot, 0)).resolves.toMatchObject({ compatibility: "current" });
		expect(await readdir(join(projectRoot, ".research", "transactions", "pending"))).toEqual([]);
	});
});
