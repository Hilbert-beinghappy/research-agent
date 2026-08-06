import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESEARCH_SCHEMA_VERSION } from "../../src/contracts/schemas.ts";
import { isOpaqueId } from "../../src/kernel/identity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { PROJECT_LAYOUT_DIRECTORIES, PROJECT_MANIFEST_PATH } from "../../src/project/layout.ts";
import { openProject } from "../../src/project/open.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-project-"));
	projectRoot = join(temporaryDirectory, "project");
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("project initialization and opening", () => {
	it("initializes the fixed v0.1 layout and reopens idempotently", async () => {
		const created = await initializeProject(projectRoot, {
			title: "Algorithmic transparency and public trust",
			domain: "public-administration",
		});

		expect(created.mode).toBe("read-write");
		if (created.compatibility !== "current") throw new Error("expected a current project");
		expect(created.manifest).toMatchObject({
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			title: "Algorithmic transparency and public trust",
			revision: 0,
			lastSessionLink: null,
		});
		expect(isOpaqueId(created.manifest.projectId, "project")).toBe(true);
		expect(created.manifest.recordSets.map(({ kind }) => kind)).toEqual([
			"source",
			"document",
			"evidence",
			"claim",
			"citation_verification",
			"task",
			"operation",
			"artifact",
			"approval",
		]);
		await Promise.all(PROJECT_LAYOUT_DIRECTORIES.map((path) => access(join(projectRoot, ...path.split("/")))));
		await access(join(projectRoot, "README.md"));

		const reopened = await initializeProject(projectRoot, {
			title: "Algorithmic transparency and public trust",
			domain: "public-administration",
		});
		if (reopened.compatibility !== "current") throw new Error("expected a current project");
		expect(reopened.manifest.projectId).toBe(created.manifest.projectId);
		expect(reopened.manifest.revision).toBe(0);
	});

	it("rejects a non-empty directory without changing it", async () => {
		await mkdir(projectRoot);
		await writeFile(join(projectRoot, "notes.txt"), "user work");
		await expect(initializeProject(projectRoot, { title: "Conflict" })).rejects.toThrow("non-empty");
		await expect(readFile(join(projectRoot, "notes.txt"), "utf8")).resolves.toBe("user work");
		await expect(access(join(projectRoot, PROJECT_MANIFEST_PATH))).rejects.toThrow();
	});

	it("rejects corrupt manifests and revision conflicts", async () => {
		await mkdir(projectRoot);
		await writeFile(join(projectRoot, PROJECT_MANIFEST_PATH), "{");
		await expect(openProject(projectRoot)).rejects.toThrow("Cannot parse");

		await rm(projectRoot, { recursive: true });
		await initializeProject(projectRoot, { title: "Revision guard" });
		await expect(openProject(projectRoot, 1)).rejects.toThrow("DATA_CONFLICT");
		await expect(openProject(projectRoot, 0)).resolves.toMatchObject({ compatibility: "current" });
	});

	it("opens older and newer schemas read-only and rejects invalid versions", async () => {
		await initializeProject(projectRoot, { title: "Schema compatibility" });
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		const current = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

		await writeFile(manifestPath, JSON.stringify({ ...current, schemaVersion: "0.0.9" }));
		await expect(openProject(projectRoot)).resolves.toMatchObject({
			mode: "read-only",
			compatibility: "migration_required",
			schemaVersion: "0.0.9",
		});

		await writeFile(manifestPath, JSON.stringify({ ...current, schemaVersion: "0.2.0" }));
		await expect(openProject(projectRoot)).resolves.toMatchObject({
			mode: "read-only",
			compatibility: "newer_schema",
			schemaVersion: "0.2.0",
		});

		await writeFile(manifestPath, JSON.stringify({ ...current, schemaVersion: "next" }));
		await expect(openProject(projectRoot)).rejects.toThrow("Invalid schema version");
	});

	it("rejects platform-ambiguous manifest paths", async () => {
		await initializeProject(projectRoot, { title: "Portable paths" });
		const manifestPath = join(projectRoot, PROJECT_MANIFEST_PATH);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.directories = { ...(manifest.directories as Record<string, unknown>), sources: "CON" };
		await writeFile(manifestPath, JSON.stringify(manifest));
		await expect(openProject(projectRoot)).rejects.toThrow("not portable");
	});
});
