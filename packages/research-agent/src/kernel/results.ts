// SPDX-License-Identifier: Apache-2.0

import type { JsonValue, ResearchError, ResearchResult } from "../contracts/schemas.ts";

export type FailureStatus =
	| "RETRYABLE_FAILURE"
	| "PERMANENT_FAILURE"
	| "PERMISSION_BLOCKED"
	| "EXTERNAL_SERVICE_FAILURE"
	| "DATA_CONFLICT";

export function successResult<Value>(value: Value, operationId: string | null): ResearchResult<Value> {
	return { ok: true, status: "SUCCESS", value, errors: [], meta: { operationId, taskId: null, warnings: [] } };
}

export function partialSuccessResult<Value>(
	value: Value,
	code: string,
	category: ResearchError["category"],
	message: string,
	operationId: string | null,
	details: JsonValue = null,
): ResearchResult<Value> {
	return {
		ok: true,
		status: "PARTIAL_SUCCESS",
		value,
		errors: [
			{
				code,
				category,
				message,
				retryable: false,
				source: "research-agent",
				operationId,
				taskId: null,
				details,
				occurredAt: new Date().toISOString(),
				causeCode: null,
			},
		],
		meta: { operationId, taskId: null, warnings: [message] },
	};
}

export function failureResult<Value>(
	status: FailureStatus,
	code: string,
	category: ResearchError["category"],
	message: string,
	operationId: string | null,
	details: JsonValue = null,
): ResearchResult<Value> {
	return {
		ok: false,
		status,
		value: null,
		errors: [
			{
				code,
				category,
				message,
				retryable: status === "RETRYABLE_FAILURE",
				source: "research-agent",
				operationId,
				taskId: null,
				details,
				occurredAt: new Date().toISOString(),
				causeCode: null,
			},
		],
		meta: { operationId, taskId: null, warnings: [] },
	};
}
