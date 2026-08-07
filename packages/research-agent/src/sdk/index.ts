// SPDX-License-Identifier: Apache-2.0

import type {
	JsonValue,
	ResearchResult,
	ResearchRpcMethod,
	ResearchRpcRequest,
	ResearchSdkCapability,
} from "@research-agent/contracts";
import { ResearchRpcRequestSchema } from "@research-agent/contracts/sdk-rpc";
import { Compile } from "typebox/compile";
import { canonicalizeJson } from "../contracts/canonical-json.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { doctorProject } from "../project/doctor.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { readRecord } from "../project/records.ts";
import { validateProject } from "../project/validate.ts";

export const RESEARCH_AGENT_SDK_VERSION = "2.0.0" as const;
export const RESEARCH_SDK_METHODS = [
	"system.capabilities",
	"projects.list",
	"project.open",
	"project.validate",
	"project.doctor",
	"records.list",
	"records.read",
] as const satisfies readonly ResearchRpcMethod[];

const RequestValidator = Compile(ResearchRpcRequestSchema);

export interface ResearchSdk {
	invoke(request: ResearchRpcRequest): Promise<ResearchResult<JsonValue>>;
}

function rawProjectId(manifest: JsonValue): string | null {
	return manifest !== null &&
		typeof manifest === "object" &&
		!Array.isArray(manifest) &&
		typeof manifest.projectId === "string"
		? manifest.projectId
		: null;
}

function projectSummary(opened: Awaited<ReturnType<typeof openProject>>): JsonValue {
	const manifest = opened.manifest;
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new TypeError("Research project manifest is not an object");
	}
	return canonicalizeJson({
		projectId: rawProjectId(manifest),
		root: opened.root,
		title: typeof manifest.title === "string" ? manifest.title : null,
		schemaVersion:
			typeof manifest.schemaVersion === "string"
				? manifest.schemaVersion
				: opened.compatibility === "current"
					? RESEARCH_SCHEMA_VERSION
					: opened.schemaVersion,
		revision: typeof manifest.revision === "number" ? manifest.revision : null,
		mode: opened.mode,
		compatibility: opened.compatibility,
	});
}

function sdkFailure(error: unknown): ResearchResult<JsonValue> {
	const message = error instanceof Error ? error.message : String(error);
	const notFound = message.startsWith("NOT_FOUND:") || message.startsWith("Project is not configured:");
	return failureResult(
		"PERMANENT_FAILURE",
		notFound ? "SDK_NOT_FOUND" : "SDK_REQUEST_FAILED",
		notFound ? "not_found" : error instanceof TypeError ? "validation" : "runtime",
		message,
		null,
	);
}

export async function createResearchSdk(projectRoots: readonly string[]): Promise<ResearchSdk> {
	const projects = new Map<string, string>();
	for (const root of projectRoots) {
		const opened = await openProject(root);
		const projectId = rawProjectId(opened.manifest);
		if (projectId === null) throw new TypeError(`Project at ${opened.root} has no project ID`);
		const existing = projects.get(projectId);
		if (existing !== undefined && existing !== opened.root) {
			throw new TypeError(`Duplicate configured project ID: ${projectId}`);
		}
		projects.set(projectId, opened.root);
	}

	const configuredProject = (projectId: string): string => {
		const root = projects.get(projectId);
		if (root === undefined) throw new Error(`Project is not configured: ${projectId}`);
		return root;
	};

	return {
		async invoke(request) {
			if (!RequestValidator.Check(request)) {
				return failureResult(
					"PERMANENT_FAILURE",
					"SDK_REQUEST_INVALID",
					"validation",
					"SDK request does not satisfy RPC contract v1",
					null,
				);
			}
			try {
				switch (request.method) {
					case "system.capabilities": {
						const capabilities: ResearchSdkCapability = {
							format: "pi-research-sdk-capabilities",
							version: 1,
							packageVersion: RESEARCH_AGENT_SDK_VERSION,
							projectSchemaVersion: RESEARCH_SCHEMA_VERSION,
							methods: [...RESEARCH_SDK_METHODS],
							access: "configured-projects",
							mutations: "pi-governed-surfaces-only",
							experimental: ["model-routing-heuristics", "realtime-collaboration", "ui-widgets"],
						};
						return successResult(canonicalizeJson(capabilities), null);
					}
					case "projects.list": {
						const summaries = [];
						for (const root of projects.values()) summaries.push(projectSummary(await openProject(root)));
						return successResult(canonicalizeJson(summaries), null);
					}
					case "project.open": {
						const root = configuredProject(request.params.projectId);
						const opened = await openProject(root);
						return successResult(
							canonicalizeJson({ summary: projectSummary(opened), manifest: opened.manifest }),
							null,
						);
					}
					case "project.validate": {
						const root = configuredProject(request.params.projectId);
						return successResult(canonicalizeJson(await validateProject(root)), null);
					}
					case "project.doctor": {
						const root = configuredProject(request.params.projectId);
						return successResult(canonicalizeJson(await doctorProject(root)), null);
					}
					case "records.list": {
						const root = configuredProject(request.params.projectId);
						const opened = await openProject(root);
						if (opened.compatibility !== "current") throw new TypeError("Project records are read-only");
						return successResult(
							canonicalizeJson(await listProjectRecordIds(root, opened.manifest, request.params.kind)),
							null,
						);
					}
					case "records.read": {
						const root = configuredProject(request.params.projectId);
						const opened = await openProject(root);
						if (opened.compatibility !== "current") throw new TypeError("Project records are read-only");
						const record = await readRecord(root, request.params.kind, request.params.id);
						if (!record.ok) return record;
						return successResult(canonicalizeJson(record.value), null);
					}
				}
			} catch (error) {
				return sdkFailure(error);
			}
		},
	};
}
