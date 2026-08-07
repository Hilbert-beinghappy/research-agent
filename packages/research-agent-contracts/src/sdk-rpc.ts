// SPDX-License-Identifier: Apache-2.0

import { type Static, Type } from "typebox";
import { JsonResearchResultSchema, RecordKindSchema } from "./schemas.ts";

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const ProjectParamsSchema = Type.Object({ projectId: NonEmptyStringSchema }, { additionalProperties: false });

export const ResearchRpcMethodSchema = Type.Union([
	Type.Literal("system.capabilities"),
	Type.Literal("projects.list"),
	Type.Literal("project.open"),
	Type.Literal("project.validate"),
	Type.Literal("project.doctor"),
	Type.Literal("records.list"),
	Type.Literal("records.read"),
]);
export type ResearchRpcMethod = Static<typeof ResearchRpcMethodSchema>;

const RpcRequestBase = {
	protocol: Type.Literal("pi-research-rpc"),
	version: Type.Literal(1),
	requestId: NonEmptyStringSchema,
};

export const ResearchRpcRequestSchema = Type.Union([
	Type.Object(
		{ ...RpcRequestBase, method: Type.Literal("system.capabilities"), params: Type.Null() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...RpcRequestBase, method: Type.Literal("projects.list"), params: Type.Null() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...RpcRequestBase, method: Type.Literal("project.open"), params: ProjectParamsSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...RpcRequestBase, method: Type.Literal("project.validate"), params: ProjectParamsSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...RpcRequestBase, method: Type.Literal("project.doctor"), params: ProjectParamsSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...RpcRequestBase,
			method: Type.Literal("records.list"),
			params: Type.Object(
				{ projectId: NonEmptyStringSchema, kind: RecordKindSchema },
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...RpcRequestBase,
			method: Type.Literal("records.read"),
			params: Type.Object(
				{ projectId: NonEmptyStringSchema, kind: RecordKindSchema, id: NonEmptyStringSchema },
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
]);
export type ResearchRpcRequest = Static<typeof ResearchRpcRequestSchema>;

export const ResearchRpcResponseSchema = Type.Object(
	{
		protocol: Type.Literal("pi-research-rpc"),
		version: Type.Literal(1),
		requestId: NonEmptyStringSchema,
		result: JsonResearchResultSchema,
	},
	{ additionalProperties: false },
);
export type ResearchRpcResponse = Static<typeof ResearchRpcResponseSchema>;

export const ResearchSdkCapabilitySchema = Type.Object(
	{
		format: Type.Literal("pi-research-sdk-capabilities"),
		version: Type.Literal(1),
		packageVersion: NonEmptyStringSchema,
		projectSchemaVersion: NonEmptyStringSchema,
		methods: Type.Array(ResearchRpcMethodSchema),
		access: Type.Literal("configured-projects"),
		mutations: Type.Literal("pi-governed-surfaces-only"),
		experimental: Type.Array(NonEmptyStringSchema),
	},
	{ additionalProperties: false },
);
export type ResearchSdkCapability = Static<typeof ResearchSdkCapabilitySchema>;
