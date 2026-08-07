// SPDX-License-Identifier: Apache-2.0

import type {
	AdapterCapabilitySnapshotV1,
	SourceAdapterV1,
	SourceSearchPageV1,
	SourceSearchRequestV1,
} from "@research-agent/contracts/adapters";
import type { HashValue, ResearchResult } from "../../contracts/schemas.ts";
import type { HttpReceipt, HttpRequestIntent } from "../../security/broker-http.ts";

export type AdapterCapabilitySnapshot = AdapterCapabilitySnapshotV1;

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

export type SourceSearchRequest = SourceSearchRequestV1;

export type SourceSearchPage = SourceSearchPageV1;

export type SourceAdapter = SourceAdapterV1<AdapterContext>;
