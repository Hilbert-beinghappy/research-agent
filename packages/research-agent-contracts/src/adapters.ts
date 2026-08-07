// SPDX-License-Identifier: Apache-2.0

import { type Static, Type } from "typebox";
import type { JsonValue, ResearchResult, SourceIdentifier } from "./schemas.ts";
import { AdapterKindSchema, FileRefSchema, IdentifierSchemeSchema, JsonValueSchema, MoneySchema } from "./schemas.ts";

export const AdapterCapabilitySnapshotV1Schema = Type.Object(
	{
		adapterId: Type.String({ minLength: 1 }),
		adapterVersion: Type.String({ minLength: 1 }),
		adapterKind: AdapterKindSchema,
		contractVersion: Type.Literal("1"),
		capabilities: Type.Array(Type.String({ minLength: 1 })),
		supportsPagination: Type.Boolean(),
		supportsResumeCursor: Type.Boolean(),
		mayCostMoney: Type.Boolean(),
		maySendDataExternally: Type.Boolean(),
		requiresCredentials: Type.Boolean(),
		supportedIdentifiers: Type.Array(IdentifierSchemeSchema),
		limits: JsonValueSchema,
		generatedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type AdapterCapabilitySnapshotV1 = Static<typeof AdapterCapabilitySnapshotV1Schema>;

export const SourceSearchRequestV1Schema = Type.Object(
	{
		queryText: Type.String({ minLength: 1 }),
		filters: JsonValueSchema,
		pageSize: Type.Integer({ minimum: 1 }),
		cursor: JsonValueSchema,
		maxResults: Type.Integer({ minimum: 1 }),
		maxCost: Type.Union([MoneySchema, Type.Null()]),
	},
	{ additionalProperties: false },
);
export type SourceSearchRequestV1 = Static<typeof SourceSearchRequestV1Schema>;

export const SourceSearchPageV1Schema = Type.Object(
	{
		candidates: Type.Array(JsonValueSchema),
		nextCursor: JsonValueSchema,
		exhausted: Type.Boolean(),
		rawResponse: FileRefSchema,
		actualCost: MoneySchema,
	},
	{ additionalProperties: false },
);
export type SourceSearchPageV1 = Static<typeof SourceSearchPageV1Schema>;

export interface SourceAdapterV1<Context> {
	capabilities(): Promise<AdapterCapabilitySnapshotV1>;
	healthCheck(context: Context): Promise<ResearchResult<JsonValue>>;
	search(request: SourceSearchRequestV1, context: Context): Promise<ResearchResult<SourceSearchPageV1>>;
	lookup(identifier: SourceIdentifier, context: Context): Promise<ResearchResult<JsonValue>>;
}

export const AnalysisRuntimeRequestV1Schema = Type.Object(
	{
		runtime: Type.String({ minLength: 1 }),
		script: FileRefSchema,
		inputs: Type.Array(FileRefSchema),
		parameters: JsonValueSchema,
		randomSeed: Type.Union([Type.Integer(), Type.Null()]),
	},
	{ additionalProperties: false },
);
export type AnalysisRuntimeRequestV1 = Static<typeof AnalysisRuntimeRequestV1Schema>;

export const AnalysisRuntimeResultV1Schema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("succeeded"),
			Type.Literal("failed"),
			Type.Literal("aborted"),
			Type.Literal("non_converged"),
		]),
		outputs: Type.Array(FileRefSchema),
		logs: Type.Array(FileRefSchema),
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
	},
	{ additionalProperties: false },
);
export type AnalysisRuntimeResultV1 = Static<typeof AnalysisRuntimeResultV1Schema>;

export interface AnalysisRuntimeAdapterV1<Context> {
	capabilities(): Promise<AdapterCapabilitySnapshotV1>;
	execute(request: AnalysisRuntimeRequestV1, context: Context): Promise<ResearchResult<AnalysisRuntimeResultV1>>;
}

export const ArtifactAdapterRequestV1Schema = Type.Object(
	{
		artifactKind: Type.String({ minLength: 1 }),
		title: Type.String({ minLength: 1 }),
		sourceRecords: Type.Array(JsonValueSchema),
		sourceFiles: Type.Array(FileRefSchema),
		options: JsonValueSchema,
	},
	{ additionalProperties: false },
);
export type ArtifactAdapterRequestV1 = Static<typeof ArtifactAdapterRequestV1Schema>;

export const ArtifactAdapterResultV1Schema = Type.Object(
	{
		outputFile: FileRefSchema,
		warnings: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);
export type ArtifactAdapterResultV1 = Static<typeof ArtifactAdapterResultV1Schema>;

export interface ArtifactAdapterV1<Context> {
	capabilities(): Promise<AdapterCapabilitySnapshotV1>;
	render(request: ArtifactAdapterRequestV1, context: Context): Promise<ResearchResult<ArtifactAdapterResultV1>>;
}
