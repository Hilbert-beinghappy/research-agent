// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AdapterProtocolMessageSchema } from "../src/adapter-protocol.ts";
import {
	AdapterCapabilitySnapshotV1Schema,
	AnalysisRuntimeRequestV1Schema,
	AnalysisRuntimeResultV1Schema,
	ArtifactAdapterRequestV1Schema,
	ArtifactAdapterResultV1Schema,
	SourceSearchPageV1Schema,
	SourceSearchRequestV1Schema,
} from "../src/adapters.ts";
import {
	AdapterPackageManifestSchema,
	CollaborationChangeSetSchema,
	ExchangeBundleManifestSchema,
	JsonResearchResultSchema,
	ModelRouteDecisionSchema,
	PersistedRecordSchema,
} from "../src/schemas.ts";

const directory = fileURLToPath(new URL("../schemas/v1.5/", import.meta.url));
const jsonSchema = "https://json-schema.org/draft/2020-12/schema";
const schemas = [
	["persisted-record", "Pi Research Agent persisted record v1.5", PersistedRecordSchema],
	["research-result", "Pi Research Agent result v1", JsonResearchResultSchema],
	["adapter-package", "Pi Research Agent adapter package v1", AdapterPackageManifestSchema],
	["adapter-protocol", "Pi Research Agent adapter JSONL protocol v1", AdapterProtocolMessageSchema],
	["adapter-capability", "Pi Research Agent adapter capability v1", AdapterCapabilitySnapshotV1Schema],
	["source-search-request", "Pi Research Agent source search request v1", SourceSearchRequestV1Schema],
	["source-search-page", "Pi Research Agent source search page v1", SourceSearchPageV1Schema],
	["analysis-runtime-request", "Pi Research Agent analysis runtime request v1", AnalysisRuntimeRequestV1Schema],
	["analysis-runtime-result", "Pi Research Agent analysis runtime result v1", AnalysisRuntimeResultV1Schema],
	["artifact-adapter-request", "Pi Research Agent artifact adapter request v1", ArtifactAdapterRequestV1Schema],
	["artifact-adapter-result", "Pi Research Agent artifact adapter result v1", ArtifactAdapterResultV1Schema],
	["exchange-bundle", "Pi Research Agent exchange bundle v1", ExchangeBundleManifestSchema],
	["collaboration-change-set", "Pi Research Agent collaboration change set v1", CollaborationChangeSetSchema],
	["model-route-decision", "Pi Research Agent model route decision v1", ModelRouteDecisionSchema],
] as const;

await mkdir(directory, { recursive: true });
await Promise.all(
	schemas.map(([name, title, schema]) =>
		writeFile(
			`${directory}${name}.schema.json`,
			`${JSON.stringify({ $schema: jsonSchema, title, ...schema }, null, 2)}\n`,
		),
	),
);
