// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JsonResearchResultSchema, PersistedRecordSchema, RESEARCH_SCHEMA_VERSION } from "../src/contracts/schemas.ts";

const schemaDir = fileURLToPath(new URL(`../schemas/v${RESEARCH_SCHEMA_VERSION.slice(0, 3)}/`, import.meta.url));
const jsonSchema = "https://json-schema.org/draft/2020-12/schema";

await mkdir(schemaDir, { recursive: true });
await Promise.all([
	writeFile(
		`${schemaDir}persisted-record.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent persisted record v0.1", ...PersistedRecordSchema }, null, 2)}\n`,
	),
	writeFile(
		`${schemaDir}research-result.schema.json`,
		`${JSON.stringify({ $schema: jsonSchema, title: "Pi Research Agent result v0.1", ...JsonResearchResultSchema }, null, 2)}\n`,
	),
]);
