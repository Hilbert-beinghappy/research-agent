// SPDX-License-Identifier: Apache-2.0

import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { PROJECT_RELATIVE_PATH_PATTERN } from "../contracts/schemas.ts";

const relativePathPattern = new RegExp(PROJECT_RELATIVE_PATH_PATTERN);
const windowsReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function validateProjectRelativePath(path: string): string {
	if (!relativePathPattern.test(path)) throw new TypeError(`Project path must be canonical POSIX-relative: ${path}`);
	if (path !== path.normalize("NFC")) throw new TypeError(`Project path must use NFC Unicode: ${path}`);
	if (/[\u0000-\u001f\u007f]/.test(path)) throw new TypeError(`Project path contains control characters: ${path}`);
	for (const segment of path.split("/")) {
		if (windowsReservedName.test(segment) || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) {
			throw new TypeError(`Project path is not portable: ${path}`);
		}
	}
	return path;
}

export function validatePortablePathSet(paths: readonly string[]): string[] {
	const portable = paths.map(validateProjectRelativePath);
	const folded = portable.map((path) => path.toLowerCase());
	if (new Set(folded).size !== folded.length)
		throw new TypeError("Project paths collide on case-insensitive filesystems");
	return portable;
}

export async function resolveProjectPath(projectRoot: string, projectPath: string): Promise<string> {
	const relativePath = validateProjectRelativePath(projectPath);
	const canonicalRoot = await realpath(projectRoot);
	const target = resolve(canonicalRoot, ...relativePath.split("/"));
	let existing = target;
	let canonicalExisting: string;

	for (;;) {
		try {
			canonicalExisting = await realpath(existing);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = dirname(existing);
			if (parent === existing) throw error;
			existing = parent;
		}
	}

	const fromRoot = relative(canonicalRoot, canonicalExisting);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
		throw new TypeError(`Project path escapes through a symbolic link: ${projectPath}`);
	}
	return existing === target ? canonicalExisting : target;
}

export async function resolveProjectPathWithoutSymlinks(projectRoot: string, projectPath: string): Promise<string> {
	const relativePath = validateProjectRelativePath(projectPath);
	let current = await realpath(projectRoot);
	for (const segment of relativePath.split("/")) {
		current = resolve(current, segment);
		if ((await lstat(current)).isSymbolicLink()) {
			throw new TypeError(`Project path contains a symbolic link: ${projectPath}`);
		}
	}
	return current;
}
