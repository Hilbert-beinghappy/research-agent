// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function syncParentDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export async function atomicWriteFile(path: string, content: string | Uint8Array): Promise<void> {
	const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		const file = await open(temporaryPath, "wx");
		try {
			await file.writeFile(content);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, path);
		await syncParentDirectory(path);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}
