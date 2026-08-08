// SPDX-License-Identifier: Apache-2.0

import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { validateProjectRelativePath } from "../kernel/paths.ts";

export const MEMORY_PROFILE_PATH = "profile.json";
export const MEMORY_WRITER_LOCK_PATH = "locks/writer.lock";
export const MEMORY_TRANSFER_LOCK_PATH = "locks/transfer.lock";
export const MEMORY_ACTIVE_ITEMS_CACHE_PATH = "cache/active-items-v1.json";
export const MEMORY_RETRIEVAL_INDEX_PATH = "cache/retrieval-index-v1.json";
export const MEMORY_RETRIEVAL_INDEX_HASH_PATH = "cache/retrieval-index-v1.sha256";

export const MEMORY_LAYOUT_DIRECTORIES = [
	"signals",
	"candidates",
	"items",
	"feedback",
	"receipts",
	"tombstones",
	"audit",
	"transfer-manifests",
	"transactions/pending",
	"transactions/committed",
	"transactions/failed",
	"locks",
	"cache",
] as const;

const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,255}$/u;

export function validateMemoryIdentifier(value: string, label: string): string {
	if (!identifierPattern.test(value)) throw new TypeError(`${label} is not a valid memory identifier`);
	return value;
}

export function memoryProfileRoot(doroHome: string, profileId: string): string {
	return join(doroHome, "profiles", validateMemoryIdentifier(profileId, "profileId"));
}

export function memoryMonthPath(timestamp: string): string {
	return `${timestamp.slice(0, 4)}/${timestamp.slice(5, 7)}`;
}

export async function validateMemoryLayout(profileRoot: string): Promise<string> {
	const root = await realpath(profileRoot);
	for (const directory of MEMORY_LAYOUT_DIRECTORIES) {
		const path = join(root, ...directory.split("/"));
		const stats = await lstat(path);
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new TypeError(`Memory layout path must be a real directory: ${directory}`);
		}
	}
	return root;
}

export async function resolveMemoryPath(
	profileRoot: string,
	memoryPath: string,
	options: { allowMissing?: boolean } = {},
): Promise<string> {
	let current = await realpath(profileRoot);
	let missing = false;
	for (const segment of validateProjectRelativePath(memoryPath).split("/")) {
		current = join(current, segment);
		if (missing) continue;
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new TypeError(`Memory path must not contain a symbolic link: ${memoryPath}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !(options.allowMissing ?? false)) throw error;
			missing = true;
		}
	}
	return current;
}
