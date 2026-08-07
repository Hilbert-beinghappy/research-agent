import { describe, expect, expectTypeOf, it } from "vitest";
import type { AdapterContext, SourceAdapter, SourceSearchPage } from "../../../src/adapters/source/contract.ts";
import type { ResearchError, ResearchResult } from "../../../src/contracts/schemas.ts";
import { hashBytes } from "../../../src/kernel/integrity.ts";
import { failureResult, successResult } from "../../../src/kernel/results.ts";

const rawResponse = {
	path: ".research/runs/operation_fixture/raw.json",
	hash: hashBytes("fixture"),
	mediaType: "application/json",
	bytes: 7,
} as const;

function partialError(operationId: string): ResearchError {
	return {
		code: "SOURCE_PAGE_PARTIAL",
		category: "external_service",
		message: "One upstream partition failed",
		retryable: true,
		source: "source.fixture",
		operationId,
		taskId: "task_fixture",
		details: { partition: "secondary" },
		occurredAt: new Date().toISOString(),
		causeCode: null,
	};
}

const adapter: SourceAdapter = {
	async capabilities() {
		return {
			adapterId: "source.fixture",
			adapterVersion: "0.1.0",
			adapterKind: "source",
			contractVersion: "1",
			capabilities: ["search", "lookup"],
			supportsPagination: true,
			supportsResumeCursor: true,
			mayCostMoney: false,
			maySendDataExternally: true,
			requiresCredentials: false,
			supportedIdentifiers: ["doi"],
			limits: { pageSize: 100 },
			generatedAt: new Date().toISOString(),
		};
	},
	async healthCheck(context) {
		return successResult({ status: "ok" }, context.operationId);
	},
	async search(request, context) {
		if (request.queryText === "service failure") {
			return failureResult(
				"RETRYABLE_FAILURE",
				"SOURCE_UNAVAILABLE",
				"external_service",
				"Source service is unavailable",
				context.operationId,
			);
		}
		const page: SourceSearchPage = {
			candidates:
				request.queryText === "no matches" || request.cursor !== null
					? []
					: [{ title: "Algorithmic governance", identifier: "10.1234/fixture" }],
			nextCursor: request.cursor === null ? { cursor: "page-2" } : null,
			exhausted: request.cursor !== null || request.queryText === "no matches",
			rawResponse,
			actualCost: { amount: 0, currency: "USD" },
		};
		if (request.queryText !== "partial") return successResult(page, context.operationId);
		const error = partialError(context.operationId);
		const result: ResearchResult<SourceSearchPage> = {
			ok: true,
			status: "PARTIAL_SUCCESS",
			value: page,
			errors: [error],
			meta: { operationId: context.operationId, taskId: context.taskId, warnings: [error.message] },
		};
		return result;
	},
	async lookup(identifier, context) {
		return successResult(
			{ identifier: identifier.normalizedValue, rawResponse, actualCost: { amount: 0, currency: "USD" } },
			context.operationId,
		);
	},
};

function adapterContext(): AdapterContext {
	return {
		projectId: "project_fixture",
		taskId: "task_fixture",
		operationId: "operation_fixture",
		policySnapshotHash: hashBytes("policy"),
		signal: new AbortController().signal,
		brokers: {
			requestHttp: async () =>
				failureResult(
					"PERMISSION_BLOCKED",
					"FIXTURE_ONLY",
					"permission",
					"No live HTTP in source adapter contract tests",
					"operation_fixture",
				),
		},
	};
}

describe("SourceAdapter contract", () => {
	it("standardizes capabilities, cursor pages, empty results, lookup, and partial failures", async () => {
		const context = adapterContext();
		await expect(adapter.capabilities()).resolves.toMatchObject({
			adapterId: "source.fixture",
			adapterKind: "source",
			contractVersion: "1",
			capabilities: ["search", "lookup"],
			supportsPagination: true,
			supportsResumeCursor: true,
			supportedIdentifiers: ["doi"],
		});
		await expect(adapter.healthCheck(context)).resolves.toMatchObject({ ok: true, value: { status: "ok" } });

		const request = {
			queryText: "algorithmic governance",
			filters: { fromYear: 2020 },
			pageSize: 50,
			cursor: null,
			maxResults: 100,
			maxCost: { amount: 0, currency: "USD" },
		} as const;
		const firstPage = await adapter.search(request, context);
		expect(firstPage).toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: {
				candidates: [{ identifier: "10.1234/fixture" }],
				nextCursor: { cursor: "page-2" },
				exhausted: false,
				rawResponse,
			},
		});
		await expect(adapter.search({ ...request, queryText: "no matches" }, context)).resolves.toMatchObject({
			ok: true,
			status: "SUCCESS",
			value: { candidates: [], exhausted: true },
		});
		await expect(adapter.search({ ...request, queryText: "partial" }, context)).resolves.toMatchObject({
			ok: true,
			status: "PARTIAL_SUCCESS",
			errors: [{ code: "SOURCE_PAGE_PARTIAL", retryable: true }],
		});
		await expect(adapter.search({ ...request, queryText: "service failure" }, context)).resolves.toMatchObject({
			ok: false,
			status: "RETRYABLE_FAILURE",
			value: null,
		});
		await expect(
			adapter.lookup(
				{
					scheme: "doi",
					value: "https://doi.org/10.1234/FIXTURE",
					normalizedValue: "10.1234/fixture",
					verified: false,
					verificationId: null,
				},
				context,
			),
		).resolves.toMatchObject({ ok: true, value: { identifier: "10.1234/fixture", rawResponse } });
	});

	it("exposes only the governed HTTP broker to a source adapter", () => {
		expectTypeOf<keyof AdapterContext["brokers"]>().toEqualTypeOf<"requestHttp">();
		expect(Object.keys(adapterContext().brokers)).toEqual(["requestHttp"]);
		expect("projectRoot" in adapterContext()).toBe(false);
	});
});
