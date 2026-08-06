import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpaqueId, isOpaqueId, type OpaqueIdKind } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson, hashFile, verifyBytes } from "../../src/kernel/integrity.ts";
import { resolveProjectPath, validatePortablePathSet, validateProjectRelativePath } from "../../src/kernel/paths.ts";

const idKinds: OpaqueIdKind[] = [
	"project",
	"source",
	"document",
	"evidence",
	"claim",
	"citation_verification",
	"task",
	"analysis_run",
	"artifact",
	"approval",
	"operation",
];

describe("identity, integrity, and project paths", () => {
	it("creates unique opaque UUID v4 identifiers for every record kind", () => {
		const ids = idKinds.flatMap((kind) =>
			Array.from({ length: 20 }, () => {
				const id = createOpaqueId(kind);
				expect(isOpaqueId(id, kind)).toBe(true);
				return id;
			}),
		);
		expect(new Set(ids).size).toBe(ids.length);
		expect(isOpaqueId(createOpaqueId("source"), "document")).toBe(false);
	});

	it("matches stable SHA-256 fixtures and detects mismatches", async () => {
		expect(hashBytes("abc")).toEqual({
			algorithm: "sha256",
			value: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		});
		expect(hashCanonicalJson({ b: 2, a: 1 })).toEqual({
			algorithm: "sha256",
			value: "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
		});
		expect(verifyBytes("abd", hashBytes("abc"))).toBe(false);

		const directory = await mkdtemp(join(tmpdir(), "pi-research-hash-"));
		try {
			const path = join(directory, "fixture.txt");
			await writeFile(path, "abc");
			expect(await hashFile(path)).toEqual(hashBytes("abc"));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"/tmp/file.json",
		"C:/data/file.json",
		"C:\\data\\file.json",
		"../file.json",
		"data/../file.json",
		"data/./file.json",
		"data//file.json",
		"data/file.json/",
		"data\\file.json",
		"CON.txt",
		"data/file. ",
		"cafe\u0301/file.json",
	])("rejects non-portable project path %s", (path) => {
		expect(() => validateProjectRelativePath(path)).toThrow();
	});

	it("accepts canonical POSIX-relative paths and rejects case-folding collisions", () => {
		expect(validateProjectRelativePath(".research/records/sources.json")).toBe(".research/records/sources.json");
		expect(validateProjectRelativePath("café/来源.json")).toBe("café/来源.json");
		expect(() => validatePortablePathSet(["Data/file.json", "data/FILE.json"])).toThrow("case-insensitive");
	});

	it("resolves paths inside the project and rejects symbolic-link escapes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-research-path-"));
		const project = join(directory, "project");
		const outside = join(directory, "outside");
		try {
			await mkdir(join(project, "inside"), { recursive: true });
			await mkdir(outside);
			await writeFile(join(project, "inside", "record.json"), "{}");
			await symlink(outside, join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
			const canonicalProject = await realpath(project);

			expect(await resolveProjectPath(project, "inside/record.json")).toBe(
				join(canonicalProject, "inside", "record.json"),
			);
			expect(await resolveProjectPath(project, "inside/new.json")).toBe(
				join(canonicalProject, "inside", "new.json"),
			);
			await expect(resolveProjectPath(project, "escape/secret.json")).rejects.toThrow("symbolic link");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
