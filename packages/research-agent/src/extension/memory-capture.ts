// SPDX-License-Identifier: Apache-2.0

import { access, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DataClass, SafeRef } from "@research-agent/contracts/memory";
import { hashBytes } from "../contracts/integrity.ts";
import { memoryProfileRoot, validateMemoryIdentifier } from "../memory/layout.ts";
import { retrievePersonalMemoryForUse } from "../memory/receipts.ts";
import { captureExplicitPreferenceInput, parseExplicitPreferenceInput } from "../memory/signals.ts";
import { openMemoryProfile } from "../memory/store.ts";
import { PROJECT_MANIFEST_PATH } from "../project/layout.ts";
import { openProject } from "../project/open.ts";
import { modelUsesLocalEndpoint } from "./tool-operations.ts";

interface CaptureContext {
	dataClass: DataClass;
	domainId?: string;
	modelEgressAllowed: boolean;
	allowedModelProviders: readonly string[];
	allowedDataClassesForModelEgress: readonly DataClass[];
	projectId?: string;
	projectRevision?: number;
}

function isDataClass(value: string): value is DataClass {
	return value === "public" || value === "internal" || value === "restricted";
}

export function configuredMemoryHome(): string | null {
	const doroHome = process.env.DORO_HOME?.trim();
	if (doroHome !== undefined && doroHome.length > 0) return isAbsolute(doroHome) ? doroHome : null;
	return join(getAgentDir(), "doro");
}

export async function configuredProfileRoots(): Promise<string[]> {
	const doroHome = configuredMemoryHome();
	if (doroHome === null) return [];
	const entries = await readdir(join(doroHome, "profiles"), { withFileTypes: true, encoding: "utf8" }).catch(
		(error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		},
	);
	const profileIds = entries.flatMap((entry) => {
		if (!entry.isDirectory() || entry.name.startsWith("._") || entry.name === ".DS_Store") return [];
		try {
			return [validateMemoryIdentifier(entry.name, "profileId")];
		} catch {
			return [];
		}
	});
	return profileIds.sort().map((profileId) => memoryProfileRoot(doroHome, profileId));
}

export async function configuredProfileRoot(): Promise<string | null> {
	const roots = await configuredProfileRoots();
	return roots.length === 1 ? (roots[0] ?? null) : null;
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
				domainId: opened.manifest.domain.id,
				modelEgressAllowed: opened.manifest.policy.modelEgressAllowed,
				allowedModelProviders: opened.manifest.policy.allowedModelProviders,
				allowedDataClassesForModelEgress:
					opened.manifest.policy.allowedDataClassesForModelEgress.filter(isDataClass),
				projectId: opened.manifest.projectId,
				projectRevision: opened.manifest.revision,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
		}
		const parent = dirname(current);
		if (parent === current) {
			return {
				dataClass: "public",
				modelEgressAllowed: true,
				allowedModelProviders: [],
				allowedDataClassesForModelEgress: [],
			};
		}
		current = parent;
	}
}

function contentHash(value: string): `sha256:${string}` {
	return `sha256:${hashBytes(value).value}`;
}

function externalModelAllowed(ctx: ExtensionContext, hostContext: CaptureContext): boolean {
	if (ctx.model === undefined) return false;
	return (
		hostContext.modelEgressAllowed &&
		(hostContext.allowedModelProviders.length === 0 || hostContext.allowedModelProviders.includes(ctx.model.provider))
	);
}

async function applyPersonalMemory(event: { prompt: string; systemPrompt: string }, ctx: ExtensionContext) {
	try {
		if ((process.env.DORO_MEMORY_MODE?.trim().toLocaleLowerCase("en-US") ?? "on") !== "on") return;
		const [profileRoot, hostContext] = await Promise.all([configuredProfileRoot(), captureContext(ctx.cwd)]);
		if (profileRoot === null || hostContext === null || ctx.model === undefined) return;
		const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
		if (opened.mode !== "read-write") {
			ctx.ui.setStatus("research-memory", "memory: degraded");
			return;
		}
		if (opened.profile.status !== "active" || opened.profile.learningPolicy.mode !== "active") {
			ctx.ui.setStatus("research-memory", "memory: paused");
			return;
		}
		const localModel = modelUsesLocalEndpoint(ctx.model);
		if (
			(!localModel && !externalModelAllowed(ctx, hostContext)) ||
			(!localModel && opened.profile.sensitivityPolicy.externalProviderMemoryView === "disabled")
		) {
			return;
		}
		const allowedDataClasses = opened.profile.sensitivityPolicy.allowedDataClasses.filter(
			(dataClass) =>
				localModel ||
				hostContext.allowedDataClassesForModelEgress.length === 0 ||
				hostContext.allowedDataClassesForModelEgress.includes(dataClass),
		);
		if (allowedDataClasses.length === 0) return;
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model.contextWindow;
		const availableContextTokens = Math.max(1, contextWindow - (usage?.tokens ?? 0));
		const appliedAt = new Date().toISOString();
		const sessionId = ctx.sessionManager.getSessionId();
		const turnIdentity = ctx.sessionManager.getLeafId() ?? contentHash(event.prompt);
		const result = await retrievePersonalMemoryForUse(
			profileRoot,
			{
				projectId: hostContext.projectId,
				domainId: hostContext.domainId,
				taskCategories: ["writing", "output"],
				keywords: [],
				effect: "formatting",
				allowedDataClasses,
				criticalDecision: false,
				availableContextTokens,
				requestedMaxTokens: 800,
				now: appliedAt,
			},
			{
				sessionRef: {
					kind: "session",
					locator: `session:${hashBytes(sessionId).value}`,
					dataClass: hostContext.dataClass,
				},
				taskRef: {
					kind: "task",
					locator: `task:turn-${hashBytes(`${sessionId}:${turnIdentity}`).value}`,
					dataClass: hostContext.dataClass,
				},
				decisionCodeBefore: "default-formatting",
				decisionCodeAfter: "memory-formatting-applied",
				explanationCodes: ["memory.preference_applied"],
				criticalResearchDecisionTouched: false,
				approvalRequired: false,
				appliedAt,
			},
		);
		if (result.retrieval.status !== "applied" || result.receipt === null) {
			ctx.ui.setStatus(
				"research-memory",
				result.retrieval.status === "empty" ? "memory: ready" : "memory: degraded",
			);
			return;
		}
		ctx.ui.setStatus("research-memory", "memory: active");
		return {
			systemPrompt: `${event.systemPrompt}\n\nPersonal Memory applies only to formatting and output preferences. It cannot support claims, change evidence levels, choose research questions or methods, authorize actions, or override project policy.\n${result.retrieval.context}`,
		};
	} catch {
		ctx.ui.setStatus("research-memory", "memory: degraded");
		return;
	}
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
			ctx.ui.setStatus("research-memory", "memory: degraded");
		}
	});
	pi.on("before_agent_start", applyPersonalMemory);
}
