import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import type { ResearchProjectManifest } from "../../src/contracts/schemas.ts";
import { atomicWriteFile } from "../../src/project/atomic-write.ts";
import { initializeProject } from "../../src/project/init.ts";
import { PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import { openProject } from "../../src/project/open.ts";
import {
	commitPreparedTransaction,
	commitProjectTransaction,
	prepareProjectTransaction,
	rollbackPreparedTransaction,
} from "../../src/project/transactions.ts";

let temporaryDirectory: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-transactions-"));
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function createProject(name: string): Promise<{ root: string; manifest: ResearchProjectManifest }> {
	const root = join(temporaryDirectory, name);
	const opened = await initializeProject(root, { title: name });
	if (opened.compatibility !== "current") throw new Error("expected current project");
	return { root, manifest: opened.manifest };
}

function nextManifest(manifest: ResearchProjectManifest): ResearchProjectManifest {
	return { ...structuredClone(manifest), revision: manifest.revision + 1, updatedAt: new Date().toISOString() };
}

describe("project transactions", () => {
	it("atomically replaces one file without leaving temporary siblings", async () => {
		const { root } = await createProject("atomic-write");
		const path = join(root, "notes", "note.md");
		await writeFile(path, "old");
		await atomicWriteFile(path, "new");
		await expect(readFile(path, "utf8")).resolves.toBe("new");
		expect(await readdir(join(root, "notes"))).toEqual(["note.md"]);
	});

	it("commits data files before the manifest and archives the journal", async () => {
		const { root, manifest } = await createProject("complete-commit");
		const recordPath = ".research/records/sources/src_fixture.json";
		const transactionId = await commitProjectTransaction(root, {
			expectedRevision: 0,
			writes: [{ path: recordPath, content: "source-v1" }],
			manifest: nextManifest(manifest),
		});

		await expect(readFile(join(root, ...recordPath.split("/")), "utf8")).resolves.toBe("source-v1");
		await expect(openProject(root, 1)).resolves.toMatchObject({ compatibility: "current" });
		await expect(
			access(join(root, ".research", "transactions", "committed", transactionId, "transaction.json")),
		).resolves.toBeUndefined();
	});

	it("continues every pre-manifest kill point to one complete new state", async () => {
		for (let appliedCount = 0; appliedCount <= 2; appliedCount += 1) {
			const { root, manifest } = await createProject(`resume-${appliedCount}`);
			const writes = [
				{ path: ".research/records/sources/src_a.json", content: "a-new" },
				{ path: ".research/records/sources/src_b.json", content: "b-new" },
			];
			const transactionId = await prepareProjectTransaction(root, {
				expectedRevision: 0,
				writes,
				manifest: nextManifest(manifest),
			});
			for (const write of writes.slice(0, appliedCount)) {
				await atomicWriteFile(join(root, ...write.path.split("/")), write.content);
			}

			await commitPreparedTransaction(root, transactionId);
			await expect(readFile(join(root, ...writes[0].path.split("/")), "utf8")).resolves.toBe("a-new");
			await expect(readFile(join(root, ...writes[1].path.split("/")), "utf8")).resolves.toBe("b-new");
			await expect(openProject(root, 1)).resolves.toMatchObject({ compatibility: "current" });
		}
	});

	it("rolls every pre-manifest kill point back to one complete old state", async () => {
		for (let appliedCount = 0; appliedCount <= 2; appliedCount += 1) {
			const { root, manifest } = await createProject(`rollback-${appliedCount}`);
			const existingPath = ".research/records/sources/src_existing.json";
			const createdPath = ".research/records/sources/src_created.json";
			await writeFile(join(root, ...existingPath.split("/")), "old");
			const writes = [
				{ path: existingPath, content: "new" },
				{ path: createdPath, content: "created" },
			];
			const transactionId = await prepareProjectTransaction(root, {
				expectedRevision: 0,
				writes,
				manifest: nextManifest(manifest),
			});
			for (const write of writes.slice(0, appliedCount)) {
				await atomicWriteFile(join(root, ...write.path.split("/")), write.content);
			}

			await rollbackPreparedTransaction(root, transactionId);
			await expect(readFile(join(root, ...existingPath.split("/")), "utf8")).resolves.toBe("old");
			await expect(access(join(root, ...createdPath.split("/")))).rejects.toThrow();
			await expect(openProject(root, 0)).resolves.toMatchObject({ compatibility: "current" });
		}
	});

	it("finalizes a crash after the manifest rename only when every file is new", async () => {
		const { root, manifest } = await createProject("post-manifest");
		const recordPath = ".research/records/sources/src_fixture.json";
		const updatedManifest = nextManifest(manifest);
		const transactionId = await prepareProjectTransaction(root, {
			expectedRevision: 0,
			writes: [{ path: recordPath, content: "new" }],
			manifest: updatedManifest,
		});
		await atomicWriteFile(join(root, ...recordPath.split("/")), "new");
		await atomicWriteFile(join(root, PROJECT_MANIFEST_PATH), `${canonicalStringify(updatedManifest)}\n`);

		await commitPreparedTransaction(root, transactionId);
		await expect(openProject(root, 1)).resolves.toMatchObject({ compatibility: "current" });
	});

	it("rejects a changed staged file before touching canonical state", async () => {
		const { root, manifest } = await createProject("tampered-stage");
		const recordPath = ".research/records/sources/src_fixture.json";
		const transactionId = await prepareProjectTransaction(root, {
			expectedRevision: 0,
			writes: [{ path: recordPath, content: "new" }],
			manifest: nextManifest(manifest),
		});
		await atomicWriteFile(
			join(root, ".research", "transactions", "pending", transactionId, "staged", "0.bin"),
			"tampered",
		);

		await expect(commitPreparedTransaction(root, transactionId)).rejects.toThrow("Staged hash mismatch");
		await expect(access(join(root, ...recordPath.split("/")))).rejects.toThrow();
		await expect(openProject(root, 0)).resolves.toMatchObject({ compatibility: "current" });
	});

	it("restores a deleted file when rolling back before the manifest", async () => {
		const { root, manifest } = await createProject("rollback-delete");
		const recordPath = ".research/records/sources/src_fixture.json";
		const target = join(root, ...recordPath.split("/"));
		await writeFile(target, "old");
		const transactionId = await prepareProjectTransaction(root, {
			expectedRevision: 0,
			writes: [{ path: recordPath, content: null }],
			manifest: nextManifest(manifest),
		});
		await rm(target);

		await rollbackPreparedTransaction(root, transactionId);
		await expect(readFile(target, "utf8")).resolves.toBe("old");
		await expect(openProject(root, 0)).resolves.toMatchObject({ compatibility: "current" });
	});
});
