import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnpaywallAdapter } from "../../src/adapters/document/unpaywall.ts";
import { createRecordedHttpTransport, type HttpTransport } from "../../src/adapters/http/transport.ts";
import type { AdapterContext } from "../../src/adapters/source/contract.ts";
import type { FileRef, SourceIdentifier } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../../src/kernel/integrity.ts";
import { failureResult, successResult } from "../../src/kernel/results.ts";
import type { HttpReceipt, HttpRequestIntent } from "../../src/security/broker-http.ts";

const fixtureDirectory = join(import.meta.dirname, "..", "fixtures", "unpaywall");

async function fixture(name: string): Promise<string> {
	return readFile(join(fixtureDirectory, name), "utf8");
}

function fileRef(path: string, body: string): FileRef {
	return {
		path,
		hash: hashBytes(body),
		mediaType: "application/json",
		bytes: Buffer.byteLength(body),
	};
}

function fixtureContext(transport: HttpTransport): {
	context: AdapterContext;
	intents: HttpRequestIntent[];
} {
	const operationId = createOpaqueId("operation");
	const intents: HttpRequestIntent[] = [];
	const signal = new AbortController().signal;
	let requestNumber = 0;
	const context: AdapterContext = {
		projectId: createOpaqueId("project"),
		taskId: createOpaqueId("task"),
		operationId,
		policySnapshotHash: hashCanonicalJson({}),
		signal,
		brokers: {
			requestHttp: async (intent) => {
				intents.push(intent);
				requestNumber += 1;
				const response = await transport({
					method: intent.method,
					url: intent.url,
					headers: intent.headers,
					body: intent.body,
					responseBody: intent.responseBody,
					maxResponseBytes: intent.maxResponseBytes,
					signal,
				});
				if (response.status < 200 || response.status >= 300) {
					throw new Error(`unexpected fixture status ${response.status}`);
				}
				return successResult<HttpReceipt>(
					{
						requestFile: fileRef(`.research/runs/${operationId}/request-${requestNumber}.json`, intent.url),
						responseFile: fileRef(`.research/runs/${operationId}/response-${requestNumber}.json`, response.body),
						statusCode: response.status,
						headers: response.headers,
						body: response.body,
						bodyEncoding: intent.responseBody,
						bodyBytes: response.bodyBytes,
						attempts: 1,
						networkRequests: 1,
						actualCost: intent.costPerRequest,
						approvalId: null,
					},
					operationId,
				);
			},
		},
	};
	return { context, intents };
}

function identifier(scheme: SourceIdentifier["scheme"], value: string): SourceIdentifier {
	return { scheme, value, normalizedValue: value, verified: false, verificationId: null };
}

function lookupUrl(doi: string): string {
	return `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`;
}

describe("Unpaywall document locator", () => {
	it("requires an email alias and a DOI without making a request", async () => {
		const adapter = new UnpaywallAdapter();
		const unconfigured = fixtureContext(async () => {
			throw new Error("unconfigured Unpaywall must not reach transport");
		});
		await expect(adapter.capabilities()).resolves.toMatchObject({
			adapterId: "unpaywall",
			capabilities: ["health", "doi-oa-location"],
			mayCostMoney: false,
			requiresCredentials: true,
			supportedIdentifiers: ["doi"],
			limits: { status: "degraded", apiVersion: "v2", emailRequired: true, dailyRequestLimit: 100_000 },
		});
		await expect(adapter.healthCheck(unconfigured.context)).resolves.toMatchObject({
			ok: true,
			value: { status: "degraded", reason: "UNPAYWALL_EMAIL_REQUIRED", serviceProbe: "not_available" },
		});
		await expect(
			adapter.locate(identifier("doi", "10.5555/governance.1"), unconfigured.context),
		).resolves.toMatchObject({
			ok: false,
			status: "PERMISSION_BLOCKED",
			errors: [{ code: "UNPAYWALL_EMAIL_REQUIRED" }],
		});
		expect(unconfigured.intents).toHaveLength(0);

		const configured = new UnpaywallAdapter("unpaywall-email");
		await expect(
			configured.locate(identifier("url", "https://example.org/paper"), unconfigured.context),
		).resolves.toMatchObject({
			ok: false,
			status: "PERMANENT_FAILURE",
			errors: [{ code: "UNPAYWALL_DOI_REQUIRED" }],
		});
		expect(unconfigured.intents).toHaveLength(0);
	});

	it("returns every OA location while keeping unknown licenses explicit", async () => {
		const doi = "10.5555/governance.1";
		const body = await fixture("oa-multiple.json");
		const replay = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: lookupUrl(doi), body: null },
					response: { status: 200, body },
				},
			]),
		);
		const result = await new UnpaywallAdapter("unpaywall-email").locate(identifier("doi", doi), replay.context);
		expect(result).toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				doi,
				isOpenAccess: true,
				oaStatus: "hybrid",
				accessStatus: "open_access",
				locations: [
					{ hostType: "publisher", version: "publishedVersion", isBest: true, licenseStatus: "known" },
					{
						hostType: "repository",
						version: "acceptedVersion",
						isBest: false,
						license: null,
						licenseStatus: "unknown",
					},
				],
				bestLocation: { hostType: "publisher", isBest: true, license: "cc-by" },
				actualCost: { amount: 0, currency: "USD" },
			},
		});
		expect(replay.intents).toHaveLength(1);
		expect(replay.intents[0]).toMatchObject({
			url: lookupUrl(doi),
			credential: { alias: "unpaywall-email", placement: { kind: "query", name: "email", prefix: "" } },
			paid: false,
			estimatedCost: null,
			costPerRequest: { amount: 0, currency: "USD" },
		});
		expect(replay.intents[0].url).not.toContain("email");
		expect(replay.intents[0].url).not.toContain("@");
	});

	it("reports a closed work without inventing an open location", async () => {
		const doi = "10.5555/closed.1";
		const replay = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: lookupUrl(doi), body: null },
					response: { status: 200, body: await fixture("closed.json") },
				},
			]),
		);
		await expect(
			new UnpaywallAdapter("unpaywall-email").locate(identifier("doi", doi), replay.context),
		).resolves.toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				isOpenAccess: false,
				oaStatus: "closed",
				accessStatus: "paywalled",
				locations: [],
				bestLocation: null,
			},
		});
		expect(replay.intents).toHaveLength(1);
	});

	it("preserves valid locations across malformed data, DOI conflicts, and service failures", async () => {
		const doi = "10.5555/partial.1";
		const partial = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: lookupUrl(doi), body: null },
					response: { status: 200, body: await fixture("partial.json") },
				},
			]),
		);
		await expect(
			new UnpaywallAdapter("unpaywall-email").locate(identifier("doi", doi), partial.context),
		).resolves.toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: {
				accessStatus: "open_access",
				locations: [{ hostType: "repository", licenseStatus: "unknown" }],
			},
			errors: [{ code: "UNPAYWALL_LOCATION_INVALID", details: { locationIndex: 1 } }],
		});

		const conflictDoi = "10.5555/different";
		const conflict = fixtureContext(
			createRecordedHttpTransport([
				{
					request: { method: "GET", url: lookupUrl(conflictDoi), body: null },
					response: { status: 200, body: await fixture("partial.json") },
				},
			]),
		);
		await expect(
			new UnpaywallAdapter("unpaywall-email").locate(identifier("doi", conflictDoi), conflict.context),
		).resolves.toMatchObject({
			ok: false,
			status: "DATA_CONFLICT",
			errors: [{ code: "UNPAYWALL_DOI_CONFLICT" }],
		});

		const service = fixtureContext(async () => {
			throw new Error("service failure should come from the broker result");
		});
		service.context.brokers.requestHttp = async (intent) => {
			service.intents.push(intent);
			return failureResult(
				"RETRYABLE_FAILURE",
				"HTTP_RETRYABLE_STATUS",
				"external_service",
				"Unpaywall returned a retryable service status",
				service.context.operationId,
			);
		};
		await expect(
			new UnpaywallAdapter("unpaywall-email").locate(identifier("doi", "10.5555/service.1"), service.context),
		).resolves.toMatchObject({
			ok: false,
			status: "RETRYABLE_FAILURE",
			errors: [{ code: "HTTP_RETRYABLE_STATUS", retryable: true }],
		});
		expect(service.intents).toHaveLength(1);
	});
});
