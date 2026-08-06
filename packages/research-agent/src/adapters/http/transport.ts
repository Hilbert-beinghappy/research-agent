// SPDX-License-Identifier: Apache-2.0

export type HttpMethod = "GET" | "HEAD" | "POST";

export interface HttpTransportRequest {
	method: HttpMethod;
	url: string;
	headers: Record<string, string>;
	body: string | null;
	responseBody: "text" | "base64";
	maxResponseBytes: number;
	signal: AbortSignal;
}

export interface HttpTransportResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
	bodyBytes: number;
}

export type HttpTransport = (request: HttpTransportRequest) => Promise<HttpTransportResponse>;

function responseTooLarge(maxResponseBytes: number): Error {
	return Object.assign(new Error(`HTTP response exceeds ${maxResponseBytes} bytes`), { code: "RESPONSE_TOO_LARGE" });
}

async function readResponseBytes(response: Response, maxResponseBytes: number): Promise<Uint8Array> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) throw responseTooLarge(maxResponseBytes);
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > maxResponseBytes) {
			const error = responseTooLarge(maxResponseBytes);
			await reader.cancel().catch(() => undefined);
			throw error;
		}
		chunks.push(chunk.value);
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export async function fetchHttpTransport(request: HttpTransportRequest): Promise<HttpTransportResponse> {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body ?? undefined,
		redirect: "manual",
		signal: request.signal,
	});
	const bytes = await readResponseBytes(response, request.maxResponseBytes);
	return {
		status: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		body: request.responseBody === "base64" ? Buffer.from(bytes).toString("base64") : new TextDecoder().decode(bytes),
		bodyBytes: bytes.byteLength,
	};
}

export interface RecordedHttpExchange {
	request: Pick<HttpTransportRequest, "method" | "url" | "body">;
	response:
		| (Pick<HttpTransportResponse, "status" | "body"> & {
				headers?: Record<string, string>;
				bodyBytes?: number;
		  })
		| { errorCode: string };
}

export function createRecordedHttpTransport(exchanges: readonly RecordedHttpExchange[]): HttpTransport {
	let nextExchange = 0;
	return async (request) => {
		request.signal.throwIfAborted();
		const exchange = exchanges[nextExchange];
		if (exchange === undefined) throw new Error("Recorded HTTP fixture is exhausted");
		nextExchange += 1;
		if (
			exchange.request.method !== request.method ||
			exchange.request.url !== request.url ||
			exchange.request.body !== request.body
		) {
			throw new Error(`Recorded HTTP request mismatch at exchange ${nextExchange}`);
		}
		if ("errorCode" in exchange.response) {
			throw Object.assign(new Error("Recorded HTTP transport failure"), { code: exchange.response.errorCode });
		}
		const bodyBytes =
			exchange.response.bodyBytes ??
			(request.responseBody === "base64"
				? Buffer.from(exchange.response.body, "base64").byteLength
				: Buffer.byteLength(exchange.response.body));
		if (bodyBytes > request.maxResponseBytes) throw responseTooLarge(request.maxResponseBytes);
		return {
			status: exchange.response.status,
			headers: exchange.response.headers ?? {},
			body: exchange.response.body,
			bodyBytes,
		};
	};
}
