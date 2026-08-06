// SPDX-License-Identifier: Apache-2.0

import type { UnpaywallAdapter, UnpaywallLocation, UnpaywallLookupResult } from "../adapters/document/unpaywall.ts";
import type { AdapterContext } from "../adapters/source/contract.ts";
import type { AccessStatus, FileRef, FullTextStatus, ResearchResult, SourceRecord } from "../contracts/schemas.ts";
import { failureResult } from "../kernel/results.ts";

export interface DocumentLocationCandidate {
	sourceId: string;
	adapterId: "unpaywall";
	url: string;
	kind: "direct_pdf" | "landing_page" | "unknown";
	accessStatus: AccessStatus;
	hostType: UnpaywallLocation["hostType"];
	version: UnpaywallLocation["version"];
	licenseExpression: string | null;
	licenseStatus: "known" | "unknown";
	isBest: boolean;
	rawRecord: FileRef;
}

export interface DocumentLocationResult {
	sourceId: string;
	adapterId: "unpaywall";
	accessStatus: AccessStatus;
	fullTextStatus: FullTextStatus;
	locations: DocumentLocationCandidate[];
	bestLocation: DocumentLocationCandidate | null;
	rawResponse: FileRef;
}

function fullTextStatus(accessStatus: AccessStatus, locations: readonly DocumentLocationCandidate[]): FullTextStatus {
	if (accessStatus === "paywalled") return "paywall_blocked";
	if (accessStatus === "authentication_required") return "authentication_blocked";
	return locations.length > 0 ? "located" : "unavailable";
}

export function normalizeUnpaywallLocations(sourceId: string, lookup: UnpaywallLookupResult): DocumentLocationResult {
	const locations = new Map<string, DocumentLocationCandidate>();
	const add = (location: UnpaywallLocation, url: string | null, kind: DocumentLocationCandidate["kind"]): void => {
		if (url === null || locations.has(url)) return;
		locations.set(url, {
			sourceId,
			adapterId: "unpaywall",
			url,
			kind,
			accessStatus: lookup.accessStatus,
			hostType: location.hostType,
			version: location.version,
			licenseExpression: location.license,
			licenseStatus: location.licenseStatus,
			isBest: location.isBest,
			rawRecord: lookup.rawResponse,
		});
	};
	for (const location of lookup.locations) {
		add(location, location.pdfUrl, "direct_pdf");
		add(location, location.landingPageUrl, "landing_page");
		add(location, location.url, "unknown");
	}
	const candidates = [...locations.values()];
	const bestLocation =
		candidates.find(({ isBest, kind }) => isBest && kind === "direct_pdf") ??
		candidates.find(({ isBest }) => isBest) ??
		candidates.find(({ kind }) => kind === "direct_pdf") ??
		candidates[0] ??
		null;
	return {
		sourceId,
		adapterId: "unpaywall",
		accessStatus: lookup.accessStatus,
		fullTextStatus: fullTextStatus(lookup.accessStatus, candidates),
		locations: candidates,
		bestLocation,
		rawResponse: lookup.rawResponse,
	};
}

export async function locateSourceDocument(
	source: SourceRecord,
	adapter: UnpaywallAdapter,
	context: AdapterContext,
): Promise<ResearchResult<DocumentLocationResult>> {
	const doi = source.identifiers.find(({ scheme }) => scheme === "doi");
	if (doi === undefined) {
		return failureResult(
			"PERMANENT_FAILURE",
			"DOCUMENT_DOI_REQUIRED",
			"validation",
			"Unpaywall document location requires a source DOI",
			context.operationId,
			{ sourceId: source.sourceId },
		);
	}
	const lookup = await adapter.locate(doi, context);
	if (!lookup.ok) return lookup;
	return { ...lookup, value: normalizeUnpaywallLocations(source.sourceId, lookup.value) };
}
