// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import type { HashValue, RecordKind, ResearchProjectManifest } from "../contracts/schemas.ts";
import { isOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { DERIVED_RECORD_HASH_INDEX_DIRECTORY } from "./layout.ts";
import {
	applyRecordHashChanges,
	projectRecordSet,
	recordSetIndexFromHashes,
	scanProjectRecordHashes,
} from "./record-index.ts";
import { emitProjectTransactionTrace } from "./transaction-trace.ts";

interface DerivedRecordHashIndexV1 {
	format: "research-record-hash-index";
	version: 1;
	kind: RecordKind;
	basedOnManifestRevision: number;
	count: number;
	entries: Record<string, string>;
	contentHash: HashValue;
	generatedAt: string;
}

export interface PreparedDerivedRecordHashIndex {
	count: number;
	contentHash: HashValue | null;
	write: {
		path: string;
		content: string;
	};
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function derivedRecordHashIndexPath(kind: RecordKind): string {
	return `${DERIVED_RECORD_HASH_INDEX_DIRECTORY}/${kind}.json`;
}

function parsedHashValue(value: unknown): HashValue | null {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("algorithm" in value) ||
		!("value" in value) ||
		value.algorithm !== "sha256" ||
		typeof value.value !== "string" ||
		!SHA256_PATTERN.test(value.value)
	) {
		return null;
	}
	return { algorithm: "sha256", value: value.value };
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseDerivedRecordHashIndex(
	text: string,
	manifest: ResearchProjectManifest,
	kind: RecordKind,
): Map<string, HashValue> | null {
	let raw: ReturnType<typeof canonicalizeJson>;
	try {
		raw = canonicalizeJson(JSON.parse(text));
	} catch {
		return null;
	}
	if (
		raw === null ||
		typeof raw !== "object" ||
		Array.isArray(raw) ||
		raw.format !== "research-record-hash-index" ||
		raw.version !== 1 ||
		raw.kind !== kind ||
		raw.basedOnManifestRevision !== manifest.revision ||
		typeof raw.count !== "number" ||
		!Number.isInteger(raw.count) ||
		raw.count < 0 ||
		!isCanonicalTimestamp(raw.generatedAt) ||
		raw.entries === null ||
		typeof raw.entries !== "object" ||
		Array.isArray(raw.entries)
	) {
		return null;
	}
	const contentHash = parsedHashValue(raw.contentHash);
	if (contentHash === null) return null;
	const entries: Record<string, string> = {};
	const hashes = new Map<string, HashValue>();
	for (const [id, value] of Object.entries(raw.entries)) {
		if (!isOpaqueId(id, kind) || typeof value !== "string" || !SHA256_PATTERN.test(value)) return null;
		entries[id] = value;
		hashes.set(id, { algorithm: "sha256", value });
	}
	if (hashes.size !== raw.count || hashCanonicalJson(entries).value !== contentHash.value) return null;
	const recordSet = projectRecordSet(manifest, kind);
	const canonicalIndex = recordSetIndexFromHashes(hashes);
	if (canonicalIndex.count !== recordSet.count || canonicalIndex.contentHash?.value !== recordSet.contentHash?.value) {
		return null;
	}
	return hashes;
}

async function loadDerivedRecordHashes(
	projectRoot: string,
	manifest: ResearchProjectManifest,
	kind: RecordKind,
): Promise<Map<string, HashValue> | null> {
	if (process.env.RESEARCH_RECORD_INDEX_MODE === "scan") return null;
	try {
		const path = await resolveProjectPath(projectRoot, derivedRecordHashIndexPath(kind));
		return parseDerivedRecordHashIndex(await readFile(path, "utf8"), manifest, kind);
	} catch {
		return null;
	}
}

function indexDocument(
	kind: RecordKind,
	basedOnManifestRevision: number,
	hashes: ReadonlyMap<string, HashValue>,
): DerivedRecordHashIndexV1 {
	const entries = Object.fromEntries(
		[...hashes]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([id, hash]) => [id, hash.value]),
	);
	return {
		format: "research-record-hash-index",
		version: 1,
		kind,
		basedOnManifestRevision,
		count: hashes.size,
		entries,
		contentHash: hashCanonicalJson(entries),
		generatedAt: new Date().toISOString(),
	};
}

export async function prepareDerivedRecordHashIndex(
	projectRoot: string,
	manifest: ResearchProjectManifest,
	kind: RecordKind,
	changes: readonly { id: string; hash: HashValue | null }[],
): Promise<PreparedDerivedRecordHashIndex> {
	const recordSet = projectRecordSet(manifest, kind);
	const traceContext = { manifestRevision: manifest.revision, recordKind: kind, recordCount: recordSet.count };
	const started = performance.now();
	emitProjectTransactionTrace("record_index_hash", "started", traceContext);
	let fileHashCount = 0;
	try {
		let hashes = await loadDerivedRecordHashes(projectRoot, manifest, kind);
		if (hashes === null) {
			hashes = await scanProjectRecordHashes(projectRoot, manifest, kind);
			fileHashCount = hashes.size;
		}
		applyRecordHashChanges(hashes, changes);
		const recordSetIndex = recordSetIndexFromHashes(hashes);
		const document = indexDocument(kind, manifest.revision + 1, hashes);
		await mkdir(await resolveProjectPath(projectRoot, DERIVED_RECORD_HASH_INDEX_DIRECTORY), { recursive: true });
		emitProjectTransactionTrace(
			"record_index_hash",
			"completed",
			{ ...traceContext, recordCount: recordSetIndex.count, fileHashCount },
			performance.now() - started,
		);
		return {
			...recordSetIndex,
			write: {
				path: derivedRecordHashIndexPath(kind),
				content: `${canonicalStringify(document)}\n`,
			},
		};
	} catch (error) {
		emitProjectTransactionTrace(
			"record_index_hash",
			"failed",
			{ ...traceContext, fileHashCount },
			performance.now() - started,
			error,
		);
		throw error;
	}
}
