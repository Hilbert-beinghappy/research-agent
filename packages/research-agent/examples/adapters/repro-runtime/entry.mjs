// SPDX-License-Identifier: Apache-2.0

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const request = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		let value;
		if (request.method === "capabilities") {
			value = {
				adapterId: "example-repro-runtime",
				adapterVersion: "1.0.0",
				adapterKind: "analysis_runtime",
				contractVersion: "1",
				capabilities: ["execute"],
				supportsPagination: false,
				supportsResumeCursor: false,
				mayCostMoney: false,
				maySendDataExternally: false,
				requiresCredentials: false,
				supportedIdentifiers: [],
				limits: { fixture: true },
				generatedAt: "2026-08-07T00:00:00.000Z",
			};
		} else if (request.method === "execute") {
			value = { status: "succeeded", outputs: [], logs: [], exitCode: 0 };
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
