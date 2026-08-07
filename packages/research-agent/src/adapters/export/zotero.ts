// SPDX-License-Identifier: Apache-2.0

import { canonicalizeJson, canonicalStringify } from "../../contracts/canonical-json.ts";
import type { AdapterExportProfile, JsonValue, SourceRecord } from "../../contracts/schemas.ts";
import { hashCanonicalJson } from "../../kernel/integrity.ts";
import type { HttpRequestIntent } from "../../security/broker-http.ts";
import type { AdapterCapabilitySnapshot } from "../source/contract.ts";

export const ZOTERO_API_ADAPTER_VERSION = "0.5.0";

export interface ZoteroWriteResult {
	source: SourceRecord;
	externalItemId: string | null;
	externalVersion: number | null;
	error: { code: string; message: string } | null;
}

export function zoteroApiCapabilities(): AdapterCapabilitySnapshot {
	return {
		adapterId: "zotero-api",
		adapterVersion: ZOTERO_API_ADAPTER_VERSION,
		adapterKind: "artifact",
		contractVersion: "1",
		capabilities: ["export_sources", "batch_create", "idempotent_write_token", "partial_reconciliation"],
		supportsPagination: false,
		supportsResumeCursor: false,
		mayCostMoney: false,
		maySendDataExternally: true,
		requiresCredentials: true,
		supportedIdentifiers: ["doi", "isbn", "issn", "url"],
		limits: { maxBatchItems: 50, apiVersion: 3, deletesSupported: false },
		generatedAt: new Date().toISOString(),
	};
}

function zoteroType(sourceType: string): string {
	switch (sourceType) {
		case "journal-article":
			return "journalArticle";
		case "book":
			return "book";
		case "book-chapter":
			return "bookSection";
		case "conference-paper":
			return "conferencePaper";
		case "thesis":
			return "thesis";
		case "report":
			return "report";
		default:
			return "document";
	}
}

function identifier(source: SourceRecord, scheme: SourceRecord["identifiers"][number]["scheme"]): string {
	return source.identifiers.find((value) => value.scheme === scheme)?.normalizedValue ?? "";
}

function zoteroItem(source: SourceRecord): { [key: string]: JsonValue } {
	return {
		itemType: zoteroType(source.sourceType),
		title: source.title,
		creators: source.contributors.map((contributor): { [key: string]: JsonValue } =>
			contributor.literal !== null
				? { creatorType: "author", name: contributor.literal }
				: {
						creatorType: "author",
						firstName: contributor.given ?? "",
						lastName: contributor.family ?? "",
					},
		),
		date: source.issuedDate ?? "",
		publicationTitle: source.containerTitle ?? "",
		publisher: source.publisher ?? "",
		language: source.language ?? "",
		DOI: identifier(source, "doi"),
		ISBN: identifier(source, "isbn"),
		ISSN: identifier(source, "issn"),
		url: identifier(source, "url"),
		abstractNote: source.abstractRights === "display_allowed" ? (source.abstractText ?? "") : "",
		extra: `Pi-Research-Source-ID: ${source.sourceId}`,
		tags: [],
		collections: [],
		relations: {},
	};
}

export function createZoteroWriteIntent(
	profile: AdapterExportProfile,
	sources: readonly SourceRecord[],
	operationId: string,
): HttpRequestIntent {
	if (
		profile.format !== "zotero-api" ||
		profile.destination.kind !== "zotero_library" ||
		profile.credentialAlias === null
	) {
		throw new TypeError("Zotero write requires an enabled Zotero API profile");
	}
	if (!profile.enabled) throw new TypeError("Zotero export profile is disabled");
	if (sources.length < 1 || sources.length > 50) throw new TypeError("Zotero writes require 1 to 50 sources");
	const idempotencyKey = hashCanonicalJson({
		operationId,
		profileId: profile.adapterExportProfileId,
		sources: sources.map(({ sourceId, audit }) => ({ sourceId, revision: audit.revision })),
	}).value;
	return {
		method: "POST",
		url: `https://api.zotero.org/${profile.destination.libraryType}/${encodeURIComponent(profile.destination.libraryId)}/items`,
		headers: {
			"Content-Type": "application/json",
			"Zotero-API-Version": "3",
			"Zotero-Write-Token": idempotencyKey.slice(0, 32),
		},
		body: canonicalStringify(sources.map(zoteroItem)),
		credential: {
			alias: profile.credentialAlias,
			placement: { kind: "header", name: "Zotero-API-Key", prefix: "" },
		},
		dataClasses: ["public_bibliographic_metadata"],
		paid: false,
		estimatedCost: { amount: 0, currency: "USD" },
		costPerRequest: { amount: 0, currency: "USD" },
		maxAttempts: 1,
		idempotencyKey,
		responseBody: "text",
		maxResponseBytes: 2_000_000,
	};
}

function object(value: JsonValue, label: string): { [key: string]: JsonValue } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
	return value;
}

function successfulItem(
	value: JsonValue,
	fallbackVersion: number | null,
): { key: string; version: number | null } | null {
	if (value === null) return null;
	if (typeof value === "string") return { key: value, version: fallbackVersion };
	const item = object(value, "Zotero successful item");
	const data = item.data === undefined ? item : object(item.data, "Zotero successful item data");
	return typeof data.key === "string"
		? { key: data.key, version: typeof data.version === "number" ? data.version : fallbackVersion }
		: null;
}

export function parseZoteroWriteResponse(
	body: string,
	sources: readonly SourceRecord[],
	lastModifiedVersion: string | undefined,
): ZoteroWriteResult[] {
	const parsed = object(canonicalizeJson(JSON.parse(body)), "Zotero write response");
	const successful = object(parsed.successful ?? parsed.success ?? {}, "Zotero successful writes");
	const unchanged = object(parsed.unchanged ?? {}, "Zotero unchanged writes");
	const failed = object(parsed.failed ?? {}, "Zotero failed writes");
	const fallbackVersion = lastModifiedVersion === undefined ? null : Number(lastModifiedVersion);
	return sources.map((source, index) => {
		const key = String(index);
		const saved = successfulItem(
			successful[key] ?? unchanged[key] ?? null,
			Number.isInteger(fallbackVersion) ? fallbackVersion : null,
		);
		if (saved !== null && saved.version !== null) {
			return { source, externalItemId: saved.key, externalVersion: saved.version, error: null };
		}
		const failure = failed[key] === undefined ? null : object(failed[key], "Zotero failed write");
		return {
			source,
			externalItemId: null,
			externalVersion: null,
			error: {
				code: typeof failure?.code === "number" ? `ZOTERO_${failure.code}` : "ZOTERO_WRITE_RESULT_INCOMPLETE",
				message:
					typeof failure?.message === "string"
						? failure.message
						: "Zotero did not return an item key and version for this source",
			},
		};
	});
}
