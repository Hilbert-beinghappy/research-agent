// SPDX-License-Identifier: Apache-2.0

import type {
	FileRef,
	HashValue,
	IdentifierScheme,
	JsonValue,
	Money,
	ResearchResult,
	SourceIdentifier,
} from "../../contracts/schemas.ts";
import type { HttpReceipt, HttpRequestIntent } from "../../security/broker-http.ts";

export interface AdapterCapabilitySnapshot {
	adapterId: string;
	adapterVersion: string;
	contractVersion: string;
	capabilities: string[];
	supportsPagination: boolean;
	supportsResumeCursor: boolean;
	mayCostMoney: boolean;
	maySendDataExternally: boolean;
	requiresCredentials: boolean;
	supportedIdentifiers: IdentifierScheme[];
	limits: JsonValue;
	generatedAt: string;
}

export interface AdapterContext {
	projectId: string;
	taskId: string;
	operationId: string;
	policySnapshotHash: HashValue;
	signal: AbortSignal;
	brokers: {
		requestHttp(request: HttpRequestIntent): Promise<ResearchResult<HttpReceipt>>;
	};
}

export interface SourceSearchRequest {
	queryText: string;
	filters: JsonValue;
	pageSize: number;
	cursor: JsonValue;
	maxResults: number;
	maxCost: Money | null;
}

export interface SourceSearchPage {
	candidates: JsonValue[];
	nextCursor: JsonValue;
	exhausted: boolean;
	rawResponse: FileRef;
	actualCost: Money;
}

export interface SourceAdapter {
	capabilities(): Promise<AdapterCapabilitySnapshot>;
	healthCheck(context: AdapterContext): Promise<ResearchResult<JsonValue>>;
	search(request: SourceSearchRequest, context: AdapterContext): Promise<ResearchResult<SourceSearchPage>>;
	lookup(identifier: SourceIdentifier, context: AdapterContext): Promise<ResearchResult<JsonValue>>;
}
