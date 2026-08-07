// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

let buffer = "";
let pending = null;

function result(requestId, ok, value, error = null) {
	process.stdout.write(
		`${JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: `${requestId}:result`, type: "result", requestId, ok, value, error })}\n`,
	);
}

async function sourcePage(requestId, queryText, brokerValue) {
	const raw = `${JSON.stringify({ queryText, brokerValue })}\n`;
	await writeFile(join(process.cwd(), "raw-response.json"), raw);
	result(requestId, true, {
		candidates: brokerValue === null ? [] : [brokerValue],
		nextCursor: null,
		exhausted: true,
		rawResponse: {
			path: "raw-response.json",
			hash: null,
			mediaType: "application/json",
			bytes: Buffer.byteLength(raw),
		},
		actualCost: { amount: 0, currency: "USD" },
	});
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const message = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		if (message.type === "broker_response" && pending !== null) {
			const request = pending;
			pending = null;
			if (!message.ok) result(request.messageId, false, null, message.error);
			else await sourcePage(request.messageId, request.payload.queryText, message.value);
			continue;
		}
		if (message.method === "capabilities") {
			result(message.messageId, true, {
				adapterId: "community-http-source",
				adapterVersion: "1.0.0",
				adapterKind: "source",
				contractVersion: "1",
				capabilities: ["search"],
				supportsPagination: false,
				supportsResumeCursor: false,
				mayCostMoney: false,
				maySendDataExternally: true,
				requiresCredentials: false,
				supportedIdentifiers: ["doi"],
				limits: { pageSize: 1 },
				generatedAt: "2026-08-07T00:00:00.000Z",
			});
			continue;
		}
		if (message.method !== "search") {
			result(message.messageId, false, null, {
				code: "METHOD_NOT_SUPPORTED",
				message: message.method,
				retryable: false,
				details: null,
			});
			continue;
		}
		if (message.payload.queryText === "conformance fixture") {
			await sourcePage(message.messageId, message.payload.queryText, null);
			continue;
		}
		pending = message;
		process.stdout.write(
			`${JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: `${message.messageId}:http`, type: "broker_request", requestId: message.messageId, broker: "http", payload: { method: "GET", url: `https://api.openalex.org/works?search=${encodeURIComponent(message.payload.queryText)}` } })}\n`,
		);
	}
});
