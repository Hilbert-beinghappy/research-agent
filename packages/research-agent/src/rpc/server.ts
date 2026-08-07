// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonValue, ResearchRpcRequest, ResearchRpcResponse } from "@research-agent/contracts";
import { ResearchRpcRequestSchema } from "@research-agent/contracts/sdk-rpc";
import { Compile } from "typebox/compile";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import { failureResult } from "../kernel/results.ts";
import type { ResearchSdk } from "../sdk/index.ts";

const RequestValidator = Compile(ResearchRpcRequestSchema);

export interface RunResearchRpcServerOptions {
	input: Readable;
	output: Writable;
	maxLineBytes?: number;
}

function requestId(value: unknown): string {
	return value !== null &&
		typeof value === "object" &&
		"requestId" in value &&
		typeof value.requestId === "string" &&
		value.requestId.length > 0
		? value.requestId
		: "invalid-request";
}

function invalidResponse(id: string, code: string, message: string): ResearchRpcResponse {
	return {
		protocol: "pi-research-rpc",
		version: 1,
		requestId: id,
		result: failureResult("PERMANENT_FAILURE", code, "validation", message, null),
	};
}

async function writeResponse(output: Writable, response: ResearchRpcResponse): Promise<void> {
	if (!output.write(`${canonicalStringify(response)}\n`)) await once(output, "drain");
}

export async function runResearchRpcServer(sdk: ResearchSdk, options: RunResearchRpcServerOptions): Promise<void> {
	const maxLineBytes = options.maxLineBytes ?? 1_048_576;
	if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
		throw new TypeError("RPC line limit must be a positive safe integer");
	}
	const lines = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of lines) {
		if (line.trim() === "") continue;
		if (Buffer.byteLength(line) > maxLineBytes) {
			await writeResponse(
				options.output,
				invalidResponse("invalid-request", "RPC_REQUEST_TOO_LARGE", "RPC request exceeded the line limit"),
			);
			continue;
		}
		let parsed: JsonValue;
		try {
			parsed = JSON.parse(line) as JsonValue;
		} catch {
			await writeResponse(
				options.output,
				invalidResponse("invalid-request", "RPC_JSON_INVALID", "RPC request is not valid JSON"),
			);
			continue;
		}
		if (!RequestValidator.Check(parsed)) {
			await writeResponse(
				options.output,
				invalidResponse(requestId(parsed), "RPC_REQUEST_INVALID", "RPC request does not satisfy contract v1"),
			);
			continue;
		}
		const request: ResearchRpcRequest = parsed;
		await writeResponse(options.output, {
			protocol: "pi-research-rpc",
			version: 1,
			requestId: request.requestId,
			result: await sdk.invoke(request),
		});
	}
}
