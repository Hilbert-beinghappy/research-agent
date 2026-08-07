// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createProjectBackup,
	listProjectBackups,
	readProjectBackup,
	restoreProjectBackup,
} from "../../src/project/backup.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { validateProject } from "../../src/project/validate.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-backup-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Backup fixture" });
	await writeFile(join(projectRoot, "notes", "decision.md"), "# Decision\n\nSynthetic project note.\n");
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("project backup and restore", () => {
	it("restores a hash-identical project into an empty destination", async () => {
		const backup = await createProjectBackup(projectRoot, "Before upgrade");
		expect(await listProjectBackups(projectRoot)).toEqual([backup.backupId]);
		expect(await readProjectBackup(projectRoot, backup.backupId)).toEqual(backup);

		const destination = join(temporaryDirectory, "restored");
		const restored = await restoreProjectBackup(projectRoot, backup.backupId, destination);
		expect(restored).toMatchObject({
			destination,
			compatibility: "current",
			backup: { rootHash: backup.rootHash },
		});
		await expect(readFile(join(destination, "notes", "decision.md"), "utf8")).resolves.toBe(
			"# Decision\n\nSynthetic project note.\n",
		);
		await expect(openProject(destination)).resolves.toMatchObject({ compatibility: "current" });
		expect(await validateProject(destination)).toMatchObject({ valid: true, issues: [] });
	});

	it("rejects a modified backup file", async () => {
		const backup = await createProjectBackup(projectRoot);
		const note = join(
			projectRoot,
			".research",
			"backups",
			"committed",
			backup.backupId,
			"files",
			"notes",
			"decision.md",
		);
		await writeFile(note, "tampered\n");

		await expect(
			restoreProjectBackup(projectRoot, backup.backupId, join(temporaryDirectory, "tampered-restore")),
		).rejects.toThrow("Backup file hash mismatch");
	});
});
