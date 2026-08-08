// SPDX-License-Identifier: Apache-2.0

import { access, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DataClass, SafeRef } from "@research-agent/contracts/memory";
import { hashBytes } from "../contracts/integrity.ts";
import { memoryProfileRoot, validateMemoryIdentifier } from "../memory/layout.ts";
import { captureExplicitPreferenceInput, parseExplicitPreferenceInput } from "../memory/signals.ts";
import { PROJECT_MANIFEST_PATH } from "../project/layout.ts";
import { openProject } from "../project/open.ts";

interface CaptureContext {
	dataClass: DataClass;
	projectId?: string;
	projectRevision?: number;
}

async function configuredProfileRoot(): Promise<string | null> {
	const doroHome = process.env.DORO_HOME?.trim();
	if (doroHome === undefined || doroHome.length === 0 || !isAbsolute(doroHome)) return null;
	const entries = await readdir(join(doroHome, "profiles"), { withFileTypes: true, encoding: "utf8" });
	const profileIds = entries.flatMap((entry) => {
		if (!entry.isDirectory() || entry.name.startsWith("._") || entry.name === ".DS_Store") return [];
		try {
			return [validateMemoryIdentifier(entry.name, "profileId")];
		} catch {
			return [];
		}
	});
	const profileId = profileIds[0];
	return profileIds.length === 1 && profileId !== undefined ? memoryProfileRoot(doroHome, profileId) : null;
}

async function captureContext(cwd: string): Promise<CaptureContext | null> {
	let current = resolve(cwd);
	while (true) {
		try {
			await access(join(current, PROJECT_MANIFEST_PATH));
			const opened = await openProject(current);
			if (opened.mode !== "read-write") return null;
			return {
				dataClass:
					opened.manifest.policy.sensitivity === "public"
						? "public"
						: opened.manifest.policy.sensitivity === "internal"
							? "internal"
							: "restricted",
				projectId: opened.manifest.projectId,
				projectRevision: opened.manifest.revision,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
		}
		const parent = dirname(current);
		if (parent === current) return { dataClass: "public" };
		current = parent;
	}
}

function contentHash(value: string): `sha256:${string}` {
	return `sha256:${hashBytes(value).value}`;
}

export function registerMemorySignalCapture(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (parseExplicitPreferenceInput(event.text) === null) return;
		try {
			const [profileRoot, hostContext] = await Promise.all([configuredProfileRoot(), captureContext(ctx.cwd)]);
			if (profileRoot === null || hostContext === null) return;
			const inputHash = contentHash(event.text);
			const sourceRefs: SafeRef[] = [
				{
					kind: "session",
					locator: `session:${hashBytes(ctx.sessionManager.getSessionId()).value}`,
					contentHash: inputHash,
					dataClass: hostContext.dataClass,
				},
			];
			if (hostContext.projectId !== undefined) {
				sourceRefs.push({
					kind: "project",
					locator: `project:${hostContext.projectId}`,
					revision: hostContext.projectRevision,
					dataClass: hostContext.dataClass,
				});
			}
			await captureExplicitPreferenceInput(profileRoot, {
				text: event.text,
				inputSource: event.source,
				hasAttachments: (event.images?.length ?? 0) > 0,
				observedAt: new Date().toISOString(),
				sourceRefs,
			});
		} catch {
			// Personal Memory degrades independently; input processing must continue unchanged.
		}
	});
}
