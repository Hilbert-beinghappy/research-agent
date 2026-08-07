// SPDX-License-Identifier: Apache-2.0

import { type Static, Type } from "typebox";
import { JsonValueSchema } from "./schemas.ts";

const MessageBase = {
	protocol: Type.Literal("pi-research-adapter-jsonl"),
	version: Type.Literal(1),
	messageId: Type.String({ minLength: 1 }),
};

export const AdapterProtocolErrorSchema = Type.Object(
	{
		code: Type.String({ minLength: 1 }),
		message: Type.String({ minLength: 1 }),
		retryable: Type.Boolean(),
		details: JsonValueSchema,
	},
	{ additionalProperties: false },
);
export type AdapterProtocolError = Static<typeof AdapterProtocolErrorSchema>;

export const AdapterProtocolRequestSchema = Type.Object(
	{
		...MessageBase,
		type: Type.Literal("request"),
		method: Type.String({ minLength: 1 }),
		payload: JsonValueSchema,
	},
	{ additionalProperties: false },
);
export type AdapterProtocolRequest = Static<typeof AdapterProtocolRequestSchema>;

export const AdapterProtocolBrokerRequestSchema = Type.Object(
	{
		...MessageBase,
		type: Type.Literal("broker_request"),
		requestId: Type.String({ minLength: 1 }),
		broker: Type.Union([
			Type.Literal("http"),
			Type.Literal("credential"),
			Type.Literal("project_read"),
			Type.Literal("staged_output"),
		]),
		payload: JsonValueSchema,
	},
	{ additionalProperties: false },
);
export type AdapterProtocolBrokerRequest = Static<typeof AdapterProtocolBrokerRequestSchema>;

export const AdapterProtocolBrokerResponseSchema = Type.Object(
	{
		...MessageBase,
		type: Type.Literal("broker_response"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Boolean(),
		value: JsonValueSchema,
		error: Type.Union([AdapterProtocolErrorSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);
export type AdapterProtocolBrokerResponse = Static<typeof AdapterProtocolBrokerResponseSchema>;

export const AdapterProtocolResultSchema = Type.Object(
	{
		...MessageBase,
		type: Type.Literal("result"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Boolean(),
		value: JsonValueSchema,
		error: Type.Union([AdapterProtocolErrorSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);
export type AdapterProtocolResult = Static<typeof AdapterProtocolResultSchema>;

export const AdapterProtocolMessageSchema = Type.Union([
	AdapterProtocolRequestSchema,
	AdapterProtocolBrokerRequestSchema,
	AdapterProtocolBrokerResponseSchema,
	AdapterProtocolResultSchema,
]);
export type AdapterProtocolMessage = Static<typeof AdapterProtocolMessageSchema>;
