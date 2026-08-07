// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	ResearchRpcRequestSchema,
	ResearchRpcResponseSchema,
	ResearchSdkCapabilitySchema,
} from "@research-agent/contracts/sdk-rpc";
import { AdapterProtocolMessageSchema } from "../src/contracts/adapter-protocol.ts";
import {
	AdapterPackageManifestSchema,
	CollaborationChangeSetSchema,
	ExchangeBundleManifestSchema,
	JsonResearchResultSchema,
	ModelRouteDecisionSchema,
	PersistedRecordSchema,
	ProjectBackupManifestSchema,
	ProjectCatalogSchema,
	RESEARCH_SCHEMA_VERSION,
} from "../src/contracts/schemas.ts";

const schemaDir = fileURLToPath(new URL(`../schemas/v${RESEARCH_SCHEMA_VERSION.slice(0, 3)}/`, import.meta.url));
const v2SchemaDir = fileURLToPath(new URL("../schemas/v2.0/", import.meta.url));
const jsonSchema = "https://json-schema.org/draft/2020-12/schema";
const schemaLabel = `v${RESEARCH_SCHEMA_VERSION.slice(0, 3)}`;

await mkdir(schemaDir, { recursive: true });
await mkdir(v2SchemaDir, { recursive: true });
await Promise.all([
	writeFile(
		`${schemaDir}persisted-record.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: `Pi Research Agent persisted record ${schemaLabel}`, ...PersistedRecordSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}research-result.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: `Pi Research Agent result ${schemaLabel}`, ...JsonResearchResultSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}project-catalog.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: `Pi Research Agent project catalog ${schemaLabel}`, ...ProjectCatalogSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}project-backup.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: `Pi Research Agent project backup ${schemaLabel}`, ...ProjectBackupManifestSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}adapter-package.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: `Pi Research Agent adapter package ${schemaLabel}`, ...AdapterPackageManifestSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}adapter-protocol.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent adapter JSONL protocol v1", ...AdapterProtocolMessageSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}exchange-bundle.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent exchange bundle v1", ...ExchangeBundleManifestSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}collaboration-change-set.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent collaboration change set v1", ...CollaborationChangeSetSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}model-route-decision.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent model route decision v1", ...ModelRouteDecisionSchema }, null, 2)}\n`,
	),
	writeFile(
		`${v2SchemaDir}research-rpc-request.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent RPC request v1", ...ResearchRpcRequestSchema }, null, 2)}\n`,
	),
	writeFile(
		`${v2SchemaDir}research-rpc-response.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent RPC response v1", ...ResearchRpcResponseSchema }, null, 2)}\n`,
	),
	writeFile(
		`${v2SchemaDir}research-sdk-capabilities.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent SDK capabilities v1", ...ResearchSdkCapabilitySchema }, null, 2)}\n`,
	),
]);
