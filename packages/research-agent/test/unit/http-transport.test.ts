import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHttpTransport } from "../../src/adapters/http/transport.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("HTTP transport response bounds", () => {
	it("encodes binary bytes without text decoding", async () => {
		const bytes = new Uint8Array([0, 255, 1, 254]);
		vi.stubGlobal("fetch", async () => new Response(bytes, { headers: { "content-type": "application/pdf" } }));
		await expect(
			fetchHttpTransport({
				method: "GET",
				url: "https://example.test/document.pdf",
				headers: {},
				body: null,
				responseBody: "base64",
				maxResponseBytes: 4,
				signal: new AbortController().signal,
			}),
		).resolves.toMatchObject({ body: Buffer.from(bytes).toString("base64"), bodyBytes: 4 });
	});

	it("cancels a response stream after the configured byte limit", async () => {
		vi.stubGlobal("fetch", async () => new Response(new Uint8Array(17)));
		await expect(
			fetchHttpTransport({
				method: "GET",
				url: "https://example.test/large.pdf",
				headers: {},
				body: null,
				responseBody: "base64",
				maxResponseBytes: 16,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
	});
});
