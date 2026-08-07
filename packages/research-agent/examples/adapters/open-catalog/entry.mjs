// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const request = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		let value;
		if (request.method === "capabilities") {
			value = {
				adapterId: "example-open-catalog",
				adapterVersion: "1.0.0",
				adapterKind: "source",
				contractVersion: "1",
				capabilities: ["search"],
				supportsPagination: false,
				supportsResumeCursor: false,
				mayCostMoney: false,
				maySendDataExternally: false,
				requiresCredentials: false,
				supportedIdentifiers: ["doi"],
				limits: { fixture: true },
				generatedAt: "2026-08-07T00:00:00.000Z",
			};
		} else if (request.method === "search") {
			const raw = `${JSON.stringify({ query: request.payload.queryText, records: [] })}\n`;
			await writeFile(join(process.cwd(), "raw-response.json"), raw);
			value = {
				candidates: [],
				nextCursor: null,
				exhausted: true,
				rawResponse: {
					path: "raw-response.json",
					hash: null,
					mediaType: "application/json",
					bytes: Buffer.byteLength(raw),
				},
				actualCost: { amount: 0, currency: "USD" },
			};
		} else {
			process.stdout.write(
				`${JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: `${request.messageId}:result`, type: "result", requestId: request.messageId, ok: false, value: null, error: { code: "METHOD_NOT_SUPPORTED", message: request.method, retryable: false, details: null } })}\n`,
			);
			continue;
		}
		process.stdout.write(
			`${JSON.stringify({ protocol: "pi-research-adapter-jsonl", version: 1, messageId: `${request.messageId}:result`, type: "result", requestId: request.messageId, ok: true, value, error: null })}\n`,
		);
	}
});
