// SPDX-License-Identifier: Apache-2.0

import { Compile } from "typebox/compile";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import {
	type CrossProjectSourceRef,
	type ProjectCatalog,
	ProjectCatalogSchema,
	type SourceRecord,
} from "../contracts/schemas.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { readRecord } from "../project/records.ts";

export interface CatalogProjectInput {
	root: string;
	locator: string;
}

const ProjectCatalogValidator = Compile(ProjectCatalogSchema);

export async function buildProjectCatalog(inputs: readonly CatalogProjectInput[]): Promise<ProjectCatalog> {
	if (inputs.length === 0) throw new TypeError("Project catalog requires at least one project");
	if (new Set(inputs.map(({ locator }) => locator)).size !== inputs.length) {
		throw new TypeError("Project catalog locators must be unique");
	}
	const sources: CrossProjectSourceRef[] = [];
	for (const input of inputs) {
		const opened = await openProject(input.root);
		if (opened.compatibility !== "current")
			throw new TypeError(`Catalog project ${input.locator} requires migration`);
		for (const sourceId of await listProjectRecordIds(opened.root, opened.manifest, "source")) {
			const stored = await readRecord(opened.root, "source", sourceId);
			if (!stored.ok || stored.value.kind !== "source") throw new TypeError(`Invalid source ${sourceId}`);
			const source: SourceRecord = stored.value;
			if (source.dedupKeys.strongIdentifier === null) continue;
			sources.push({
				strongIdentifier: source.dedupKeys.strongIdentifier,
				projectId: opened.manifest.projectId,
				projectLocator: input.locator,
				sourceId,
				title: source.title,
				publicationYear:
					source.issuedDate === null || !/^\d{4}/u.test(source.issuedDate)
						? null
						: Number(source.issuedDate.slice(0, 4)),
			});
		}
	}
	sources.sort((left, right) =>
		`${left.strongIdentifier}:${left.projectId}:${left.sourceId}`.localeCompare(
			`${right.strongIdentifier}:${right.projectId}:${right.sourceId}`,
		),
	);
	const groups = new Map<string, CrossProjectSourceRef[]>();
	for (const source of sources)
		groups.set(source.strongIdentifier, [...(groups.get(source.strongIdentifier) ?? []), source]);
	const duplicates = [...groups]
		.filter(([, refs]) => new Set(refs.map(({ projectId }) => projectId)).size > 1)
		.map(([strongIdentifier, refs]) => ({ strongIdentifier, refs }))
		.sort((left, right) => left.strongIdentifier.localeCompare(right.strongIdentifier));
	return {
		format: "pi-research-project-catalog",
		version: 1,
		generatedAt: new Date().toISOString(),
		projectCount: inputs.length,
		sourceCount: sources.length,
		sources,
		duplicates,
		catalogHash: hashCanonicalJson({ sources, duplicates }),
	};
}

export function queryProjectCatalog(catalog: ProjectCatalog, strongIdentifier: string): CrossProjectSourceRef[] {
	// ponytail: 10k-entry linear scan is below the v0.5 gate; add an index only after measurement says otherwise.
	return catalog.sources.filter((source) => source.strongIdentifier === strongIdentifier);
}

export function serializeProjectCatalog(catalog: ProjectCatalog): string {
	return `${canonicalStringify(catalog)}\n`;
}

export function parseProjectCatalog(value: string): ProjectCatalog {
	const parsed = canonicalizeJson(JSON.parse(value));
	if (!ProjectCatalogValidator.Check(parsed)) throw new TypeError("Project catalog does not satisfy its schema");
	if (
		hashCanonicalJson({ sources: parsed.sources, duplicates: parsed.duplicates }).value !== parsed.catalogHash.value
	) {
		throw new TypeError("Project catalog hash does not match its contents");
	}
	return parsed;
}
