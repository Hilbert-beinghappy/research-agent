import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
	listPendingProjectTransactions,
	prepareProjectTransaction,
	rollbackPreparedTransaction,
} from "../../src/project/transactions.ts";
import { validateProject } from "../../src/project/validate.ts";

let temporaryDirectory: string;
const writerWorker = join(import.meta.dirname, "..", "fixtures", "project-writer-worker.ts");

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

interface WriterResult {
	conflicts: number;
	stderr: string;
}

async function runWriter(root: string, label: string, count = 500, trace = false): Promise<WriterResult> {
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", writerWorker, "batch", root, label, String(count)],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, RESEARCH_TX_TRACE: trace ? "1" : "0" },
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const [code] = (await once(child, "exit")) as [number | null];
	if (code !== 0) throw new Error(`writer ${label} failed (${code}): ${stderr}`);
	const result = JSON.parse(stdout) as { count: number; conflicts: number };
	expect(result.count).toBe(count);
	return { conflicts: result.conflicts, stderr };
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

	it.skipIf(process.platform === "win32")("rejects a symbolic-link transaction target", async () => {
		const { root, manifest } = await createProject("symlink-target");
		const outside = join(temporaryDirectory, "outside.txt");
		const target = join(root, "notes", "linked.txt");
		await writeFile(outside, "outside");
		await symlink(outside, target);

		await expect(
			commitProjectTransaction(root, {
				expectedRevision: 0,
				writes: [{ path: "notes/linked.txt", content: "changed" }],
				manifest: nextManifest(manifest),
			}),
		).rejects.toThrow("symbolic link");
		await expect(readFile(outside, "utf8")).resolves.toBe("outside");
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

	it("serializes 1,000 writes from two independent processes without lost updates", async () => {
		const { root } = await createProject("multi-process-writers");
		await Promise.all([runWriter(root, "left"), runWriter(root, "right")]);
		const opened = await openProject(root, 1_000);
		if (opened.compatibility !== "current") throw new Error("expected current project");
		expect(opened.manifest.recordSets.find(({ kind }) => kind === "operation")?.count).toBe(1_000);
		expect(await validateProject(root)).toMatchObject({ valid: true, issues: [] });
		expect(await listPendingProjectTransactions(root)).toEqual([]);
	}, 300_000);

	it("emits opt-in structured transaction diagnostics without raw identifiers or paths", async () => {
		const { root } = await createProject("transaction-trace");
		const label = "private-worker-label";
		const result = await runWriter(root, label, 1, true);
		const records = result.stderr
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		expect(records.length).toBeGreaterThan(10);
		expect(records.some(({ phase, state }) => phase === "record_index_hash" && state === "completed")).toBe(true);
		expect(records.some(({ phase, state }) => phase === "writer_lease_wait" && state === "completed")).toBe(true);
		expect(records.some(({ phase, state }) => phase === "worker_batch" && state === "completed")).toBe(true);
		expect(result.stderr).not.toContain(root);
		expect(result.stderr).not.toContain(label);
		for (const record of records) {
			expect(record).toMatchObject({ format: "doro-project-transaction-trace", version: 1 });
			expect(record).not.toHaveProperty("operationId");
			expect(record).not.toHaveProperty("transactionId");
			expect(record).not.toHaveProperty("workerId");
			expect(record).not.toHaveProperty("path");
			expect(record).not.toHaveProperty("projectRoot");
		}
	});

	it("recovers a prepared transaction after killing its lease-holding process", async () => {
		const { root } = await createProject("killed-writer");
		const child = spawn(process.execPath, ["--experimental-strip-types", writerWorker, "prepare-crash", root], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf8");
		const lines = createInterface({ input: child.stdout });
		const [line] = (await once(lines, "line")) as [string];
		lines.close();
		const { transactionId } = JSON.parse(line) as { transactionId: string };
		child.kill("SIGKILL");
		await once(child, "exit");
		await commitPreparedTransaction(root, transactionId);
		await expect(readFile(join(root, "notes", "crash-a.txt"), "utf8")).resolves.toBe("new-a");
		await expect(readFile(join(root, "notes", "crash-b.txt"), "utf8")).resolves.toBe("new-b");
		expect(await validateProject(root)).toMatchObject({ valid: true, issues: [] });
		expect(await listPendingProjectTransactions(root)).toEqual([]);
	}, 30_000);
});
