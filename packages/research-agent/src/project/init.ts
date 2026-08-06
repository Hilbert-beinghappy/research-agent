// SPDX-License-Identifier: Apache-2.0

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import { RESEARCH_SCHEMA_VERSION, type ResearchProjectManifest } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import {
	INITIAL_RECORD_SETS,
	PROJECT_DIRECTORIES,
	PROJECT_LAYOUT_DIRECTORIES,
	PROJECT_MANIFEST_PATH,
} from "./layout.ts";
import { type OpenedProject, openProject } from "./open.ts";

export type ResearchDomain = "management" | "public-administration";

export interface InitializeProjectInput {
	title: string;
	domain?: ResearchDomain;
}

const DOMAIN_LABELS: Record<ResearchDomain, string> = {
	management: "Management",
	"public-administration": "Public Administration",
};

export async function initializeProject(projectRoot: string, input: InitializeProjectInput): Promise<OpenedProject> {
	const title = input.title.trim();
	if (title.length === 0) throw new TypeError("Project title must not be empty");
	const domain = input.domain ?? "public-administration";
	await mkdir(projectRoot, { recursive: true });
	const entries = await readdir(projectRoot);
	if (entries.includes(PROJECT_MANIFEST_PATH)) {
		const existing = await openProject(projectRoot);
		if (
			existing.compatibility !== "current" ||
			existing.manifest.title !== title ||
			existing.manifest.domain.id !== domain
		) {
			throw new Error("Project already exists with different initialization parameters");
		}
		return existing;
	}
	if (entries.length > 0) throw new Error("Cannot initialize a research project in a non-empty directory");

	for (const path of PROJECT_LAYOUT_DIRECTORIES) {
		await mkdir(await resolveProjectPath(projectRoot, path), { recursive: true });
	}
	await writeFile(
		join(projectRoot, "README.md"),
		`# ${title}\n\nCanonical research state is stored in \`${PROJECT_MANIFEST_PATH}\` and \`.research/records/\`.\n`,
		{ flag: "wx" },
	);

	const now = new Date().toISOString();
	const manifest: ResearchProjectManifest = {
		kind: "research_project_manifest",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		projectId: createOpaqueId("project"),
		title,
		domain: {
			id: domain,
			label: DOMAIN_LABELS[domain],
			templatePackage: null,
			templateVersion: null,
		},
		researchQuestions: [],
		currentStage: "topic_exploration",
		projectStatus: "active",
		policy: {
			sensitivity: "public",
			defaultNetworkDecision: "allow",
			modelEgressAllowed: true,
			allowedModelProviders: [],
			allowedDataClassesForModelEgress: [],
			budgetHardLimit: null,
			actionRules: [],
			unknownThirdPartyCode: "deny",
			retainRawProviderPayloads: true,
			rawPayloadRetentionDays: null,
		},
		directories: { ...PROJECT_DIRECTORIES },
		recordSets: INITIAL_RECORD_SETS.map((recordSet) => ({ ...recordSet })),
		activeTaskIds: [],
		lastCommittedOperationId: null,
		lastSessionLink: null,
		createdAt: now,
		updatedAt: now,
		revision: 0,
	};
	await writeFile(join(projectRoot, PROJECT_MANIFEST_PATH), `${canonicalStringify(manifest)}\n`, { flag: "wx" });
	return openProject(projectRoot, 0);
}
