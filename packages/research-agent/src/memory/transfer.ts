// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	DataClass,
	MemoryDeletionTombstoneV1,
	MemoryItemV1,
	MemoryPreferenceRefs,
	ResearcherProfileV1,
} from "@research-agent/contracts/memory";
import type { EncryptedTransferEnvelopeV1, MemorySnapshotManifestV1 } from "@research-agent/contracts/memory-transfer";
import {
	validateEncryptedTransferEnvelopeV1,
	validateMemorySnapshotManifestV1,
} from "@research-agent/contracts/memory-validators";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import { hashBytes, hashCanonicalJson } from "../contracts/integrity.ts";
import { validatePortablePathSet, validateProjectRelativePath } from "../kernel/paths.ts";
import { atomicWriteFile, syncParentDirectory } from "../project/atomic-write.ts";
import { withWriterLease } from "../project/writer-lock.ts";
import {
	MEMORY_LAYOUT_DIRECTORIES,
	MEMORY_PROFILE_PATH,
	MEMORY_TRANSFER_LOCK_PATH,
	MEMORY_WRITER_LOCK_PATH,
	memoryMonthPath,
	memoryProfileRoot,
	resolveMemoryPath,
	validateMemoryIdentifier,
	validateMemoryLayout,
} from "./layout.ts";
import {
	appendMemoryRecord,
	type CanonicalMemoryState,
	deletionFeedbackMatchesTombstone,
	loadCanonicalMemoryState,
	memoryItemRootHash,
	openMemoryProfile,
} from "./store.ts";
import { listPendingMemoryTransactionsAtRoot, parseMemoryProfile, readMemoryProfileFile } from "./transactions.ts";

const KDF_N = 131_072;
const KDF_R = 8;
const KDF_P = 1;
const KDF_MAX_MEMORY = 256 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_PASSPHRASE_BYTES = 4096;
const AUTHENTICATION_FAILURE = "MEMORY_TRANSFER_AUTHENTICATION_FAILED";
const MANIFEST_PATH = "manifest.bin";
const INCLUDED_CLASSES: MemorySnapshotManifestV1["includedClasses"] = [
	"profile",
	"policy",
	"signals",
	"items",
	"feedback",
	"receipts",
	"audit",
];
const EXCLUDED_CLASSES: MemorySnapshotManifestV1["excluded"] = [
	"session_content",
	"project_content",
	"restricted_sources",
	"credentials",
	"keys",
	"cache",
	"pending_transactions",
];
const BUNDLE_KEYS = [
	"cipher",
	"ciphertextRootHash",
	"encryptedManifest",
	"entries",
	"format",
	"kdf",
	"version",
	"wrappedDek",
] as const;
const INNER_MANIFEST_KEYS = ["entries", "format", "snapshot", "version"] as const;
const INNER_ENTRY_KEYS = [
	"ciphertextHash",
	"ciphertextPath",
	"dataClass",
	"nonceBase64",
	"plaintextHash",
	"plaintextPath",
	"size",
] as const;
const BUNDLE_ENTRY_KEYS = ["ciphertextBase64", "path"] as const;
const TRANSFER_DIRECTORY = ".memory-transfer";
const TRANSFER_JOURNAL_DIRECTORY = `${TRANSFER_DIRECTORY}/journals`;
const TRANSFER_LOCK_DIRECTORY = `${TRANSFER_DIRECTORY}/locks`;

export type MemoryTransferErrorCode =
	| "MEMORY_TRANSFER_AUTHENTICATION_FAILED"
	| "MEMORY_TRANSFER_CONFLICT"
	| "MEMORY_TRANSFER_IMPORT_FAILED"
	| "MEMORY_TRANSFER_IN_PROGRESS"
	| "MEMORY_TRANSFER_INTERRUPTED"
	| "MEMORY_TRANSFER_INVALID_BUNDLE"
	| "MEMORY_TRANSFER_RECOVERY_REQUIRED"
	| "MEMORY_TRANSFER_UNSUPPORTED";

export class MemoryTransferError extends Error {
	readonly code: MemoryTransferErrorCode;

	constructor(code: MemoryTransferErrorCode) {
		super(code);
		this.name = "MemoryTransferError";
		this.code = code;
	}
}

interface PortableFile {
	path: string;
	bytes: Buffer;
	dataClass: DataClass;
}

interface PortableState {
	profile: ResearcherProfileV1;
	files: PortableFile[];
}

interface BundleEntry {
	path: string;
	ciphertextBase64: string;
}

interface ParsedBundleEntry extends BundleEntry {
	bytes: Buffer;
	ciphertextHash: `sha256:${string}`;
}

interface TransferBundleV1 extends EncryptedTransferEnvelopeV1 {
	entries: BundleEntry[];
}

interface InnerManifestEntry {
	plaintextPath: string;
	ciphertextPath: string;
	nonceBase64: string;
	ciphertextHash: `sha256:${string}`;
	plaintextHash: `sha256:${string}`;
	size: number;
	dataClass: DataClass;
}

interface InnerManifestV1 {
	format: "doro-memory-transfer-manifest";
	version: 1;
	snapshot: MemorySnapshotManifestV1;
	entries: InnerManifestEntry[];
}

interface DecryptedTransfer {
	snapshot: MemorySnapshotManifestV1;
	profile: ResearcherProfileV1;
	files: Map<string, Buffer>;
}

interface LocalRecordFile {
	path: string;
	bytes: Buffer;
}

interface CapturedLocalState {
	profile: ResearcherProfileV1;
	state: CanonicalMemoryState;
	portable: PortableState;
	records: LocalRecordFile[];
}

type ExchangePhase = "preparing" | "barrier" | "staged" | "backed_up" | "installed" | "committed";

interface ExchangeJournalV1 {
	format: "doro-memory-import-journal";
	version: 1;
	profileId: string;
	token: string;
	targetName: string;
	stagingName: string;
	backupName: string;
	hadTarget: boolean;
	phase: ExchangePhase;
	createdAt: string;
}

interface ExchangePaths {
	journalPath: string;
	target: string;
	staging: string;
	backup: string;
}

export interface ExportEncryptedMemoryTransferOptions {
	snapshotId?: string;
	createdAt?: string;
}

export interface ImportEncryptedMemoryTransferOptions {
	/** Deterministic fault injection used by the required crash/rollback tests. */
	faultAfterPhase?: "staged" | "backed_up";
}

export interface ExportEncryptedMemoryTransferResult {
	destination: string;
	bytes: number;
	snapshot: MemorySnapshotManifestV1;
}

export interface ImportEncryptedMemoryTransferResult {
	outcome: "imported" | "idempotent";
	profileRoot: string;
	profileId: string;
	profileRevision: number;
	snapshotId: string;
	manifestRecorded: boolean;
}

function transferError(code: MemoryTransferErrorCode): MemoryTransferError {
	return new MemoryTransferError(code);
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
	return `sha256:${hashBytes(value).value}`;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalBytes(value: unknown): Buffer {
	return Buffer.from(canonicalStringify(value), "utf8");
}

function recordBytes(value: unknown): Buffer {
	return Buffer.from(`${canonicalStringify(value)}\n`, "utf8");
}

function clearBuffers(values: Iterable<Uint8Array>): void {
	for (const value of values) value.fill(0);
}

function decodeBase64(value: string, maximumBytes: number): Buffer {
	if (
		value.length === 0 ||
		value.length > Math.ceil(maximumBytes / 3) * 4 + 4 ||
		!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
	) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.byteLength > maximumBytes || decoded.toString("base64") !== value) {
		decoded.fill(0);
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	return decoded;
}

function validatePassphrase(passphrase: Uint8Array): Buffer {
	if (passphrase.byteLength === 0 || passphrase.byteLength > MAX_PASSPHRASE_BYTES) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	return Buffer.from(passphrase);
}

async function deriveKek(passphrase: Uint8Array, salt: Uint8Array): Promise<Buffer> {
	const secret = validatePassphrase(passphrase);
	try {
		return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
			scrypt(secret, salt, 32, { N: KDF_N, r: KDF_R, p: KDF_P, maxmem: KDF_MAX_MEMORY }, (error, derivedKey) => {
				if (error !== null) rejectPromise(error);
				else resolvePromise(Buffer.from(derivedKey));
			});
		});
	} finally {
		secret.fill(0);
	}
}

function encryptDetached(
	key: Uint8Array,
	nonce: Uint8Array,
	plaintext: Uint8Array,
	aad: Uint8Array,
): { ciphertext: Buffer; tag: Buffer } {
	const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
	cipher.setAAD(aad);
	return {
		ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
		tag: cipher.getAuthTag(),
	};
}

function decryptDetached(
	key: Uint8Array,
	nonce: Uint8Array,
	ciphertext: Uint8Array,
	tag: Uint8Array,
	aad: Uint8Array,
): Buffer {
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		throw transferError(AUTHENTICATION_FAILURE);
	}
}

function encryptPacked(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
	const encrypted = encryptDetached(key, nonce, plaintext, aad);
	return Buffer.concat([encrypted.tag, encrypted.ciphertext]);
}

function decryptPacked(key: Uint8Array, nonce: Uint8Array, packed: Uint8Array, aad: Uint8Array): Buffer {
	if (packed.byteLength < 16) throw transferError(AUTHENTICATION_FAILURE);
	return decryptDetached(key, nonce, packed.subarray(16), packed.subarray(0, 16), aad);
}

function keyAad(): Buffer {
	return canonicalBytes({ format: "doro-memory-transfer-key-aad", version: 1 });
}

function manifestAad(path: string): Buffer {
	return canonicalBytes({ format: "doro-memory-transfer-manifest-aad", version: 1, ciphertextPath: path });
}

function contentAad(path: string, plaintextHash: string): Buffer {
	return canonicalBytes({
		format: "doro-memory-transfer-entry-aad",
		version: 1,
		ciphertextPath: path,
		plaintextHash,
	});
}

function uniqueNonce(used: Set<string>): Buffer {
	for (;;) {
		const nonce = randomBytes(12);
		const encoded = nonce.toString("base64");
		if (!used.has(encoded)) {
			used.add(encoded);
			return nonce;
		}
		nonce.fill(0);
	}
}

function preferenceRefs(items: readonly MemoryItemV1[]): MemoryPreferenceRefs {
	const latest = new Map<string, MemoryItemV1>();
	for (const item of items) {
		const current = latest.get(item.memoryId);
		if (current === undefined || item.revision > current.revision) latest.set(item.memoryId, item);
	}
	const active = [...latest.values()]
		.filter(({ status }) => status === "active")
		.sort(
			(left, right) => left.category.localeCompare(right.category) || left.memoryId.localeCompare(right.memoryId),
		);
	return Object.fromEntries(
		[...new Set(active.map(({ category }) => category))].map((category) => [
			category,
			active.filter((item) => item.category === category).map(({ memoryId, revision }) => ({ memoryId, revision })),
		]),
	) as MemoryPreferenceRefs;
}

function portableState(profile: ResearcherProfileV1, state: CanonicalMemoryState): PortableState {
	const histories = new Map<string, MemoryItemV1[]>();
	for (const item of state.items) {
		const history = histories.get(item.memoryId) ?? [];
		history.push(item);
		histories.set(item.memoryId, history);
	}
	const transferableMemoryIds = new Set(
		[...histories]
			.filter(([, history]) =>
				history.every(({ dataClass, scope }) => dataClass !== "restricted" && scope.level !== "project"),
			)
			.map(([memoryId]) => memoryId),
	);
	const items = state.items.filter(({ memoryId }) => transferableMemoryIds.has(memoryId));
	const signals = state.signals.filter(
		({ dataClass, scopeCandidate, sourceRefs }) =>
			dataClass !== "restricted" &&
			scopeCandidate.level !== "project" &&
			sourceRefs.every((ref) => ref.dataClass !== "restricted"),
	);
	const portableDeletionFeedback = state.feedback.filter(
		(record) =>
			record.sourceRef.dataClass !== "restricted" &&
			state.tombstones.some((tombstone) => deletionFeedbackMatchesTombstone(record, tombstone)),
	);
	const portableDeletionFeedbackIds = new Set(portableDeletionFeedback.map(({ feedbackId }) => feedbackId));
	const feedback = state.feedback.filter(
		({ feedbackId, target, sourceRef }) =>
			portableDeletionFeedbackIds.has(feedbackId) ||
			(transferableMemoryIds.has(target.memoryId) && sourceRef.dataClass !== "restricted"),
	);
	const portableDeletionMemoryIds = new Set(portableDeletionFeedback.map(({ target }) => target.memoryId));
	const tombstones = state.tombstones.filter(({ memoryId }) => portableDeletionMemoryIds.has(memoryId));
	if (tombstones.length !== state.tombstones.length) throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	const receipts = state.receipts.filter(
		({ itemRefs, sessionRef, taskRef, operationRef, artifactRef }) =>
			itemRefs.every(({ memoryId }) => transferableMemoryIds.has(memoryId)) &&
			[sessionRef, taskRef, operationRef, artifactRef].every(
				(ref) => ref === null || ref.dataClass !== "restricted",
			),
	);
	const portableProfile: ResearcherProfileV1 = {
		...profile,
		preferenceRefs: preferenceRefs(items),
		currentItemRootHash: memoryItemRootHash(items),
	};
	const files: PortableFile[] = [
		{ path: MEMORY_PROFILE_PATH, bytes: recordBytes(portableProfile), dataClass: "internal" },
	];
	for (const record of signals) {
		files.push({
			path: `signals/${memoryMonthPath(record.createdAt)}/${record.signalId}.json`,
			bytes: recordBytes(record),
			dataClass: record.dataClass,
		});
	}
	for (const record of items) {
		files.push({
			path: `items/${record.category}/${record.memoryId}/${record.revision}.json`,
			bytes: recordBytes(record),
			dataClass: record.dataClass,
		});
	}
	for (const record of feedback) {
		files.push({
			path: `feedback/${memoryMonthPath(record.requestedAt)}/${record.feedbackId}.json`,
			bytes: recordBytes(record),
			dataClass: "internal",
		});
	}
	for (const record of receipts) {
		files.push({
			path: `receipts/${memoryMonthPath(record.appliedAt)}/${record.receiptId}.json`,
			bytes: recordBytes(record),
			dataClass: "internal",
		});
	}
	for (const record of tombstones) {
		files.push({
			path: `tombstones/${record.memoryId}.json`,
			bytes: recordBytes(record),
			dataClass: "internal",
		});
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	validatePortablePathSet(files.map(({ path }) => path));
	if (files.length > MAX_FILES || files.some(({ bytes }) => bytes.byteLength > MAX_ENTRY_BYTES)) {
		clearBuffers(files.map(({ bytes }) => bytes));
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const total = files.reduce((sum, { bytes }) => sum + bytes.byteLength, 0);
	if (total > MAX_PLAINTEXT_BYTES) {
		clearBuffers(files.map(({ bytes }) => bytes));
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	return { profile: portableProfile, files };
}

function localRecordFiles(state: CanonicalMemoryState): LocalRecordFile[] {
	const records: LocalRecordFile[] = [];
	const add = (path: string, value: unknown): void => {
		records.push({ path, bytes: recordBytes(value) });
	};
	for (const record of state.signals)
		add(`signals/${memoryMonthPath(record.createdAt)}/${record.signalId}.json`, record);
	for (const record of state.candidates) add(`candidates/${record.candidateId}.json`, record);
	for (const record of state.items) add(`items/${record.category}/${record.memoryId}/${record.revision}.json`, record);
	for (const record of state.feedback)
		add(`feedback/${memoryMonthPath(record.requestedAt)}/${record.feedbackId}.json`, record);
	for (const record of state.receipts)
		add(`receipts/${memoryMonthPath(record.appliedAt)}/${record.receiptId}.json`, record);
	for (const record of state.tombstones) add(`tombstones/${record.memoryId}.json`, record);
	for (const record of state.transferManifests) add(`transfer-manifests/${record.snapshotId}.json`, record);
	return records.sort((left, right) => left.path.localeCompare(right.path));
}

function snapshotFor(portable: PortableState, snapshotId: string, createdAt: string): MemorySnapshotManifestV1 {
	const files = portable.files.map(({ path, bytes, dataClass }) => ({
		path,
		size: bytes.byteLength,
		plaintextHash: sha256(bytes),
		dataClass,
	}));
	const snapshot: MemorySnapshotManifestV1 = {
		format: "doro-memory-snapshot",
		schemaVersion: "1.0.0",
		snapshotId,
		profileId: portable.profile.profileId,
		profileRevision: portable.profile.revision,
		createdAt,
		includedClasses: [...INCLUDED_CLASSES],
		excluded: [...EXCLUDED_CLASSES],
		files,
		rootHash: `sha256:${hashCanonicalJson(files).value}`,
		sourceLineage: { profileId: portable.profile.profileId, baseRevision: 0 },
	};
	const validation = validateMemorySnapshotManifestV1(snapshot);
	if (!validation.ok) throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	return validation.value;
}

export function dryRunMemoryTransferSnapshot(
	profile: ResearcherProfileV1,
	state: CanonicalMemoryState,
	createdAt: string,
): MemorySnapshotManifestV1 {
	const portable = portableState(profile, state);
	try {
		return snapshotFor(portable, "snapshot_deletion_verification_preview", createdAt);
	} finally {
		clearBuffers(portable.files.map(({ bytes }) => bytes));
	}
}

async function createBundle(
	portable: PortableState,
	snapshot: MemorySnapshotManifestV1,
	passphrase: Uint8Array,
): Promise<Buffer> {
	const salt = randomBytes(16);
	const dek = randomBytes(32);
	const usedNonces = new Set<string>();
	const wrappedNonce = uniqueNonce(usedNonces);
	let kek: Buffer | null = null;
	const temporary: Buffer[] = [salt, dek, wrappedNonce];
	try {
		kek = await deriveKek(passphrase, salt);
		const wrapped = encryptDetached(kek, wrappedNonce, dek, keyAad());
		temporary.push(wrapped.ciphertext, wrapped.tag);
		const innerEntries: InnerManifestEntry[] = [];
		const bundleEntries: ParsedBundleEntry[] = [];
		for (const [index, file] of portable.files.entries()) {
			const ciphertextPath = `content/${String(index).padStart(8, "0")}.bin`;
			const plaintextHash = sha256(file.bytes);
			const nonce = uniqueNonce(usedNonces);
			const packed = encryptPacked(dek, nonce, file.bytes, contentAad(ciphertextPath, plaintextHash));
			temporary.push(nonce, packed);
			const ciphertextHash = sha256(packed);
			innerEntries.push({
				plaintextPath: file.path,
				ciphertextPath,
				nonceBase64: nonce.toString("base64"),
				ciphertextHash,
				plaintextHash,
				size: file.bytes.byteLength,
				dataClass: file.dataClass,
			});
			bundleEntries.push({
				path: ciphertextPath,
				ciphertextBase64: packed.toString("base64"),
				bytes: packed,
				ciphertextHash,
			});
		}
		const innerManifest: InnerManifestV1 = {
			format: "doro-memory-transfer-manifest",
			version: 1,
			snapshot,
			entries: innerEntries,
		};
		const manifestPlaintext = canonicalBytes(innerManifest);
		if (manifestPlaintext.byteLength > MAX_MANIFEST_BYTES) throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		const manifestNonce = uniqueNonce(usedNonces);
		const manifestCiphertext = encryptPacked(dek, manifestNonce, manifestPlaintext, manifestAad(MANIFEST_PATH));
		temporary.push(manifestPlaintext, manifestNonce, manifestCiphertext);
		const manifestHash = sha256(manifestCiphertext);
		bundleEntries.push({
			path: MANIFEST_PATH,
			ciphertextBase64: manifestCiphertext.toString("base64"),
			bytes: manifestCiphertext,
			ciphertextHash: manifestHash,
		});
		bundleEntries.sort((left, right) => left.path.localeCompare(right.path));
		const envelope: EncryptedTransferEnvelopeV1 = {
			format: "doro-memory-transfer",
			version: 1,
			cipher: "AES-256-GCM",
			kdf: {
				name: "scrypt",
				N: KDF_N,
				r: KDF_R,
				p: KDF_P,
				saltBase64: salt.toString("base64"),
			},
			wrappedDek: {
				nonceBase64: wrappedNonce.toString("base64"),
				ciphertextBase64: wrapped.ciphertext.toString("base64"),
				tagBase64: wrapped.tag.toString("base64"),
			},
			encryptedManifest: {
				nonceBase64: manifestNonce.toString("base64"),
				path: MANIFEST_PATH,
				ciphertextHash: manifestHash,
			},
			ciphertextRootHash: `sha256:${
				hashCanonicalJson(bundleEntries.map(({ path, ciphertextHash }) => ({ path, ciphertextHash }))).value
			}`,
		};
		if (!validateEncryptedTransferEnvelopeV1(envelope).ok) throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		const bundle: TransferBundleV1 = {
			...envelope,
			entries: bundleEntries.map(({ path, ciphertextBase64 }) => ({ path, ciphertextBase64 })),
		};
		const bytes = Buffer.from(`${canonicalStringify(bundle)}\n`, "utf8");
		if (bytes.byteLength > MAX_BUNDLE_BYTES) {
			bytes.fill(0);
			throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		}
		return bytes;
	} finally {
		if (kek !== null) kek.fill(0);
		clearBuffers(temporary);
	}
}

async function canonicalDestination(profileRoot: string, destination: string): Promise<string> {
	const absolute = resolve(destination);
	const parent = await realpath(dirname(absolute));
	const target = join(parent, basename(absolute));
	const fromProfile = relative(profileRoot, target);
	if (
		fromProfile === "" ||
		(!fromProfile.startsWith(`..${sep}`) && fromProfile !== ".." && !isAbsolute(fromProfile))
	) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	return target;
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
	const handle = await open(path, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncParentDirectory(path);
}

export async function exportEncryptedMemoryTransfer(
	profileRoot: string,
	destination: string,
	passphrase: Uint8Array,
	options: ExportEncryptedMemoryTransferOptions = {},
): Promise<ExportEncryptedMemoryTransferResult> {
	const canonicalRoot = await validateMemoryLayout(profileRoot);
	const target = await canonicalDestination(canonicalRoot, destination);
	const exported = await withWriterLease(canonicalRoot, MEMORY_WRITER_LOCK_PATH, "MEMORY", async () => {
		if ((await listPendingMemoryTransactionsAtRoot(canonicalRoot)).length > 0)
			throw transferError("MEMORY_TRANSFER_IN_PROGRESS");
		try {
			await lstat(await resolveMemoryPath(canonicalRoot, MEMORY_TRANSFER_LOCK_PATH, { allowMissing: true }));
			throw transferError("MEMORY_TRANSFER_IN_PROGRESS");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const profile = await readMemoryProfileFile(canonicalRoot);
		const state = await loadCanonicalMemoryState(canonicalRoot, profile);
		const portable = portableState(profile, state);
		let bytes: Buffer | null = null;
		try {
			const snapshot = snapshotFor(
				portable,
				validateMemoryIdentifier(options.snapshotId ?? `snapshot_${randomUUID()}`, "snapshotId"),
				options.createdAt ?? new Date().toISOString(),
			);
			bytes = await createBundle(portable, snapshot, passphrase);
			await writeExclusive(target, bytes);
			return { snapshot, bundleBytes: bytes.byteLength };
		} finally {
			if (bytes !== null) bytes.fill(0);
			clearBuffers(portable.files.map(({ bytes: fileBytes }) => fileBytes));
		}
	});
	try {
		await appendMemoryRecord(profileRoot, exported.snapshot, {
			expectedProfileRevision: exported.snapshot.profileRevision,
		});
	} catch {
		await rm(target, { force: true });
		await syncParentDirectory(target);
		throw transferError("MEMORY_TRANSFER_IMPORT_FAILED");
	}
	return { destination: target, bytes: exported.bundleBytes, snapshot: exported.snapshot };
}

function parseBundleText(bytes: Buffer): { envelope: EncryptedTransferEnvelopeV1; entries: ParsedBundleEntry[] } {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_BUNDLE_BYTES)
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	let text: string;
	let raw: unknown;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		raw = canonicalizeJson(JSON.parse(text));
	} catch {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	if (text !== `${canonicalStringify(raw)}\n` || !isRecord(raw) || !exactKeys(raw, BUNDLE_KEYS)) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const envelopeValue = {
		format: raw.format,
		version: raw.version,
		cipher: raw.cipher,
		kdf: raw.kdf,
		wrappedDek: raw.wrappedDek,
		encryptedManifest: raw.encryptedManifest,
		ciphertextRootHash: raw.ciphertextRootHash,
	};
	const envelopeValidation = validateEncryptedTransferEnvelopeV1(envelopeValue);
	if (!envelopeValidation.ok) {
		if (raw.version !== 1 || raw.format !== "doro-memory-transfer")
			throw transferError("MEMORY_TRANSFER_UNSUPPORTED");
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const envelope = envelopeValidation.value;
	if (envelope.encryptedManifest.path !== MANIFEST_PATH || !Array.isArray(raw.entries)) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	if (raw.entries.length < 2 || raw.entries.length > MAX_FILES + 1) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const entries: ParsedBundleEntry[] = raw.entries.map((value) => {
		if (
			!isRecord(value) ||
			!exactKeys(value, BUNDLE_ENTRY_KEYS) ||
			typeof value.path !== "string" ||
			typeof value.ciphertextBase64 !== "string"
		) {
			throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		}
		const bytes = decodeBase64(value.ciphertextBase64, MAX_ENTRY_BYTES + 16);
		return {
			path: value.path,
			ciphertextBase64: value.ciphertextBase64,
			bytes,
			ciphertextHash: sha256(bytes),
		};
	});
	try {
		validatePortablePathSet(entries.map(({ path }) => path));
	} catch {
		clearBuffers(entries.map(({ bytes: entryBytes }) => entryBytes));
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	if (
		entries.some(({ path }) => path !== MANIFEST_PATH && !/^content\/[0-9]{8}\.bin$/u.test(path)) ||
		entries.some(({ path }, index) => index > 0 && path <= (entries[index - 1]?.path ?? ""))
	) {
		clearBuffers(entries.map(({ bytes: entryBytes }) => entryBytes));
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const manifest = entries.find(({ path }) => path === MANIFEST_PATH);
	const calculatedRoot = `sha256:${
		hashCanonicalJson(entries.map(({ path, ciphertextHash }) => ({ path, ciphertextHash }))).value
	}`;
	if (
		manifest === undefined ||
		manifest.ciphertextHash !== envelope.encryptedManifest.ciphertextHash ||
		calculatedRoot !== envelope.ciphertextRootHash
	) {
		clearBuffers(entries.map(({ bytes: entryBytes }) => entryBytes));
		throw transferError(AUTHENTICATION_FAILURE);
	}
	return { envelope, entries };
}

async function readBundle(
	path: string,
): Promise<{ envelope: EncryptedTransferEnvelopeV1; entries: ParsedBundleEntry[] }> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_BUNDLE_BYTES) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	return parseBundleText(await readFile(path));
}

function parseInnerManifest(bytes: Buffer): InnerManifestV1 {
	let raw: unknown;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		raw = canonicalizeJson(JSON.parse(text));
	} catch {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	if (
		text !== canonicalStringify(raw) ||
		!isRecord(raw) ||
		!exactKeys(raw, INNER_MANIFEST_KEYS) ||
		raw.format !== "doro-memory-transfer-manifest" ||
		raw.version !== 1 ||
		!Array.isArray(raw.entries)
	) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const snapshotValidation = validateMemorySnapshotManifestV1(raw.snapshot);
	if (!snapshotValidation.ok || raw.entries.length !== snapshotValidation.value.files.length) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const entries: InnerManifestEntry[] = raw.entries.map((value) => {
		if (!isRecord(value) || !exactKeys(value, INNER_ENTRY_KEYS))
			throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		const validDataClass = value.dataClass === "public" || value.dataClass === "internal";
		if (
			typeof value.plaintextPath !== "string" ||
			typeof value.ciphertextPath !== "string" ||
			typeof value.nonceBase64 !== "string" ||
			typeof value.ciphertextHash !== "string" ||
			typeof value.plaintextHash !== "string" ||
			typeof value.size !== "number" ||
			!Number.isInteger(value.size) ||
			value.size < 0 ||
			value.size > MAX_ENTRY_BYTES ||
			!validDataClass ||
			!/^sha256:[a-f0-9]{64}$/u.test(value.ciphertextHash) ||
			!/^sha256:[a-f0-9]{64}$/u.test(value.plaintextHash)
		) {
			throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		}
		const nonce = decodeBase64(value.nonceBase64, 12);
		if (nonce.byteLength !== 12) {
			nonce.fill(0);
			throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		}
		nonce.fill(0);
		return {
			plaintextPath: value.plaintextPath,
			ciphertextPath: value.ciphertextPath,
			nonceBase64: value.nonceBase64,
			ciphertextHash: value.ciphertextHash as `sha256:${string}`,
			plaintextHash: value.plaintextHash as `sha256:${string}`,
			size: value.size,
			dataClass: value.dataClass as DataClass,
		};
	});
	try {
		validatePortablePathSet(entries.map(({ plaintextPath }) => plaintextPath));
		validatePortablePathSet(entries.map(({ ciphertextPath }) => ciphertextPath));
	} catch {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	if (
		entries.some(({ plaintextPath }) => !isPortableMemoryPath(plaintextPath)) ||
		entries.some(({ ciphertextPath }) => !/^content\/[0-9]{8}\.bin$/u.test(ciphertextPath)) ||
		entries.some(
			({ ciphertextPath }, index) => index > 0 && ciphertextPath <= (entries[index - 1]?.ciphertextPath ?? ""),
		)
	) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	const projectedFiles = entries
		.map(({ plaintextPath: path, size, plaintextHash, dataClass }) => ({ path, size, plaintextHash, dataClass }))
		.sort((left, right) => left.path.localeCompare(right.path));
	const snapshotFiles = [...snapshotValidation.value.files].sort((left, right) => left.path.localeCompare(right.path));
	if (
		canonicalStringify(projectedFiles) !== canonicalStringify(snapshotFiles) ||
		`sha256:${hashCanonicalJson(snapshotFiles).value}` !== snapshotValidation.value.rootHash
	) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	return {
		format: "doro-memory-transfer-manifest",
		version: 1,
		snapshot: snapshotValidation.value,
		entries,
	};
}

function isPortableMemoryPath(path: string): boolean {
	try {
		validateProjectRelativePath(path);
	} catch {
		return false;
	}
	return (
		path === MEMORY_PROFILE_PATH ||
		/^(?:signals|items|feedback|receipts|tombstones)\/(?:[^/]+\/)*[^/]+\.json$/u.test(path)
	);
}

function isCanonicalMemoryRecordPath(path: string): boolean {
	return isPortableMemoryPath(path) || /^(?:candidates|transfer-manifests)\/(?:[^/]+\/)*[^/]+\.json$/u.test(path);
}

async function decryptTransfer(path: string, passphrase: Uint8Array): Promise<DecryptedTransfer> {
	const parsed = await readBundle(path);
	const { envelope, entries } = parsed;
	const ciphertextByPath = new Map(entries.map((entry) => [entry.path, entry]));
	const salt = decodeBase64(envelope.kdf.saltBase64, 16);
	const wrappedNonce = decodeBase64(envelope.wrappedDek.nonceBase64, 12);
	const wrappedCiphertext = decodeBase64(envelope.wrappedDek.ciphertextBase64, 32);
	const wrappedTag = decodeBase64(envelope.wrappedDek.tagBase64, 16);
	const manifestNonce = decodeBase64(envelope.encryptedManifest.nonceBase64, 12);
	let kek: Buffer | null = null;
	let dek: Buffer | null = null;
	let manifestPlaintext: Buffer | null = null;
	const plaintextFiles = new Map<string, Buffer>();
	try {
		kek = await deriveKek(passphrase, salt);
		dek = decryptDetached(kek, wrappedNonce, wrappedCiphertext, wrappedTag, keyAad());
		if (dek.byteLength !== 32) throw transferError(AUTHENTICATION_FAILURE);
		const manifestCiphertext = ciphertextByPath.get(MANIFEST_PATH);
		if (manifestCiphertext === undefined) throw transferError(AUTHENTICATION_FAILURE);
		manifestPlaintext = decryptPacked(dek, manifestNonce, manifestCiphertext.bytes, manifestAad(MANIFEST_PATH));
		if (manifestPlaintext.byteLength > MAX_MANIFEST_BYTES) throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		const inner = parseInnerManifest(manifestPlaintext);
		const nonces = [
			envelope.wrappedDek.nonceBase64,
			envelope.encryptedManifest.nonceBase64,
			...inner.entries.map(({ nonceBase64 }) => nonceBase64),
		];
		if (new Set(nonces).size !== nonces.length) throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		const expectedOuterPaths = [MANIFEST_PATH, ...inner.entries.map(({ ciphertextPath }) => ciphertextPath)].sort();
		if (
			canonicalStringify(expectedOuterPaths) !== canonicalStringify(entries.map(({ path: entryPath }) => entryPath))
		) {
			throw transferError(AUTHENTICATION_FAILURE);
		}
		let totalPlaintext = 0;
		for (const descriptor of inner.entries) {
			const encrypted = ciphertextByPath.get(descriptor.ciphertextPath);
			if (encrypted === undefined || encrypted.ciphertextHash !== descriptor.ciphertextHash)
				throw transferError(AUTHENTICATION_FAILURE);
			const nonce = decodeBase64(descriptor.nonceBase64, 12);
			try {
				const plaintext = decryptPacked(
					dek,
					nonce,
					encrypted.bytes,
					contentAad(descriptor.ciphertextPath, descriptor.plaintextHash),
				);
				if (plaintext.byteLength !== descriptor.size || sha256(plaintext) !== descriptor.plaintextHash) {
					plaintext.fill(0);
					throw transferError(AUTHENTICATION_FAILURE);
				}
				totalPlaintext += plaintext.byteLength;
				if (totalPlaintext > MAX_PLAINTEXT_BYTES) {
					plaintext.fill(0);
					throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
				}
				plaintextFiles.set(descriptor.plaintextPath, plaintext);
			} finally {
				nonce.fill(0);
			}
		}
		const profileBytes = plaintextFiles.get(MEMORY_PROFILE_PATH);
		if (profileBytes === undefined) throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		let profile: ResearcherProfileV1;
		try {
			profile = parseMemoryProfile(
				new TextDecoder("utf-8", { fatal: true }).decode(profileBytes),
				MEMORY_PROFILE_PATH,
			);
		} catch {
			throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		}
		if (
			profile.profileId !== inner.snapshot.profileId ||
			profile.revision !== inner.snapshot.profileRevision ||
			inner.snapshot.sourceLineage.profileId !== profile.profileId
		) {
			throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
		}
		validateMemoryIdentifier(profile.profileId, "profileId");
		return { snapshot: inner.snapshot, profile, files: plaintextFiles };
	} catch (error) {
		clearBuffers(plaintextFiles.values());
		if (error instanceof MemoryTransferError) throw error;
		throw transferError(AUTHENTICATION_FAILURE);
	} finally {
		clearBuffers([salt, wrappedNonce, wrappedCiphertext, wrappedTag, manifestNonce]);
		clearBuffers(entries.map(({ bytes: entryBytes }) => entryBytes));
		if (manifestPlaintext !== null) manifestPlaintext.fill(0);
		if (kek !== null) kek.fill(0);
		if (dek !== null) dek.fill(0);
	}
}

export async function verifyEncryptedMemoryTransfer(
	bundlePath: string,
	passphrase: Uint8Array,
): Promise<{ snapshot: MemorySnapshotManifestV1; fileCount: number; plaintextBytes: number }> {
	const decrypted = await decryptTransfer(bundlePath, passphrase);
	try {
		return {
			snapshot: decrypted.snapshot,
			fileCount: decrypted.files.size,
			plaintextBytes: [...decrypted.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
		};
	} finally {
		clearBuffers(decrypted.files.values());
	}
}

async function ensureRealDirectory(root: string, path: string): Promise<string> {
	let current = root;
	for (const segment of validateProjectRelativePath(path).split("/")) {
		current = join(current, segment);
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink() || !stats.isDirectory()) throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(current, { mode: 0o700 });
		}
	}
	return current;
}

async function prepareTransferHome(doroHome: string): Promise<string> {
	await mkdir(doroHome, { recursive: true, mode: 0o700 });
	const home = await realpath(doroHome);
	await ensureRealDirectory(home, "profiles");
	await ensureRealDirectory(home, TRANSFER_JOURNAL_DIRECTORY);
	await ensureRealDirectory(home, TRANSFER_LOCK_DIRECTORY);
	return home;
}

function journalPath(home: string, profileId: string): string {
	return join(home, TRANSFER_JOURNAL_DIRECTORY, `${validateMemoryIdentifier(profileId, "profileId")}.json`);
}

function exchangePaths(home: string, journal: ExchangeJournalV1): ExchangePaths {
	const profiles = join(home, "profiles");
	return {
		journalPath: journalPath(home, journal.profileId),
		target: join(profiles, journal.targetName),
		staging: join(profiles, journal.stagingName),
		backup: join(profiles, journal.backupName),
	};
}

function validateJournal(raw: unknown, profileId: string): ExchangeJournalV1 {
	if (
		!isRecord(raw) ||
		!exactKeys(raw, [
			"backupName",
			"createdAt",
			"format",
			"hadTarget",
			"phase",
			"profileId",
			"stagingName",
			"targetName",
			"token",
			"version",
		]) ||
		raw.format !== "doro-memory-import-journal" ||
		raw.version !== 1 ||
		raw.profileId !== profileId ||
		raw.targetName !== profileId ||
		typeof raw.token !== "string" ||
		!/^[-a-f0-9]{36}$/u.test(raw.token) ||
		typeof raw.stagingName !== "string" ||
		typeof raw.backupName !== "string" ||
		raw.stagingName !== `.import-${raw.token}` ||
		raw.backupName !== `.backup-${raw.token}` ||
		typeof raw.hadTarget !== "boolean" ||
		!(["preparing", "barrier", "staged", "backed_up", "installed", "committed"] as unknown[]).includes(raw.phase) ||
		typeof raw.createdAt !== "string" ||
		!Number.isFinite(Date.parse(raw.createdAt))
	) {
		throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	}
	return raw as unknown as ExchangeJournalV1;
}

async function readJournal(home: string, profileId: string): Promise<ExchangeJournalV1 | null> {
	const path = journalPath(home, profileId);
	try {
		const stats = await lstat(path);
		if (stats.isSymbolicLink() || !stats.isFile()) throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		const text = await readFile(path, "utf8");
		const raw = canonicalizeJson(JSON.parse(text));
		if (text !== `${canonicalStringify(raw)}\n`) throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		return validateJournal(raw, profileId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof MemoryTransferError) throw error;
		throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	}
}

async function writeJournal(home: string, journal: ExchangeJournalV1): Promise<void> {
	await atomicWriteFile(journalPath(home, journal.profileId), `${canonicalStringify(journal)}\n`);
}

async function pathKind(path: string): Promise<"missing" | "directory" | "file"> {
	try {
		const stats = await lstat(path);
		if (stats.isSymbolicLink()) throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		return stats.isDirectory() ? "directory" : "file";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
}

async function removeOwnedDirectory(path: string, expectedName: string): Promise<void> {
	if (basename(path) !== expectedName) throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	const kind = await pathKind(path);
	if (kind === "file") throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	if (kind === "directory") {
		await rm(path, { recursive: true });
		await syncParentDirectory(path);
	}
}

async function renameDirectory(from: string, to: string): Promise<void> {
	if ((await pathKind(from)) !== "directory" || (await pathKind(to)) !== "missing")
		throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	await rename(from, to);
	await syncParentDirectory(to);
}

function barrierDocument(profileId: string, token: string, createdAt: string): string {
	return `${canonicalStringify({
		format: "doro-memory-transfer-barrier",
		version: 1,
		profileId,
		token,
		createdAt,
	})}\n`;
}

async function barrierOwnedBy(profileRoot: string, profileId: string, token: string): Promise<boolean> {
	if ((await pathKind(profileRoot)) !== "directory") return false;
	const path = join(profileRoot, ...MEMORY_TRANSFER_LOCK_PATH.split("/"));
	try {
		const stats = await lstat(path);
		if (stats.isSymbolicLink() || !stats.isFile()) throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		const text = await readFile(path, "utf8");
		const raw = canonicalizeJson(JSON.parse(text));
		if (
			text !== `${canonicalStringify(raw)}\n` ||
			!isRecord(raw) ||
			!exactKeys(raw, ["createdAt", "format", "profileId", "token", "version"]) ||
			raw.format !== "doro-memory-transfer-barrier" ||
			raw.version !== 1 ||
			raw.profileId !== profileId ||
			raw.token !== token
		) {
			throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		if (error instanceof MemoryTransferError) throw error;
		throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	}
}

async function removeBarrier(profileRoot: string, profileId: string, token: string): Promise<void> {
	if (!(await barrierOwnedBy(profileRoot, profileId, token))) return;
	const path = join(profileRoot, ...MEMORY_TRANSFER_LOCK_PATH.split("/"));
	await rm(path);
	await syncParentDirectory(path);
}

async function deleteJournal(path: string): Promise<void> {
	await rm(path, { force: true });
	await syncParentDirectory(path);
}

async function recoverExchangeUnlocked(home: string, profileId: string): Promise<"none" | "rolled_back" | "committed"> {
	const journal = await readJournal(home, profileId);
	if (journal === null) return "none";
	const paths = exchangePaths(home, journal);
	let targetKind = await pathKind(paths.target);
	let stagingKind = await pathKind(paths.staging);
	let backupKind = await pathKind(paths.backup);
	if ([targetKind, stagingKind, backupKind].includes("file")) throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	if (journal.phase === "committed" && targetKind !== "directory")
		throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	const newTargetCommitted =
		journal.phase === "committed" ||
		(journal.hadTarget && targetKind === "directory" && backupKind === "missing" && journal.phase === "installed") ||
		(!journal.hadTarget && targetKind === "directory" && stagingKind === "missing");
	if (newTargetCommitted) {
		if (journal.phase !== "committed" && !(await barrierOwnedBy(paths.target, profileId, journal.token))) {
			throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		}
		await removeOwnedDirectory(paths.staging, journal.stagingName);
		await removeOwnedDirectory(paths.backup, journal.backupName);
		await removeBarrier(paths.target, profileId, journal.token);
		await deleteJournal(paths.journalPath);
		return "committed";
	}
	if (journal.hadTarget && backupKind === "directory") {
		if (targetKind === "directory") {
			if (!(await barrierOwnedBy(paths.target, profileId, journal.token)))
				throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
			await removeOwnedDirectory(paths.staging, journal.stagingName);
			await renameDirectory(paths.target, paths.staging);
			stagingKind = "directory";
			targetKind = "missing";
		}
		if (targetKind !== "missing") throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		await renameDirectory(paths.backup, paths.target);
		backupKind = "missing";
		targetKind = "directory";
	}
	if (journal.hadTarget && targetKind !== "directory") throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	if (!journal.hadTarget && targetKind === "directory") {
		if (!(await barrierOwnedBy(paths.target, profileId, journal.token)))
			throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
		await removeOwnedDirectory(paths.target, journal.targetName);
		targetKind = "missing";
	}
	if (stagingKind === "directory") await removeOwnedDirectory(paths.staging, journal.stagingName);
	if (backupKind === "directory") await removeOwnedDirectory(paths.backup, journal.backupName);
	if (targetKind === "directory") await removeBarrier(paths.target, profileId, journal.token);
	await deleteJournal(paths.journalPath);
	return "rolled_back";
}

async function withTransferLease<Value>(home: string, profileId: string, action: () => Promise<Value>): Promise<Value> {
	return withWriterLease(home, `${TRANSFER_LOCK_DIRECTORY}/${profileId}.lock`, "MEMORY_TRANSFER", action);
}

export async function recoverMemoryTransferImport(
	doroHome: string,
	profileIdInput: string,
): Promise<"none" | "rolled_back" | "committed"> {
	const profileId = validateMemoryIdentifier(profileIdInput, "profileId");
	const home = await prepareTransferHome(doroHome);
	return withTransferLease(home, profileId, () => recoverExchangeUnlocked(home, profileId));
}

async function assertNoOrphanBarrier(target: string): Promise<void> {
	if ((await pathKind(target)) !== "directory") return;
	const barrier = join(target, ...MEMORY_TRANSFER_LOCK_PATH.split("/"));
	try {
		await lstat(barrier);
		throw transferError("MEMORY_TRANSFER_RECOVERY_REQUIRED");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function captureLocalAndCreateBarrier(target: string, journal: ExchangeJournalV1): Promise<CapturedLocalState> {
	const root = await validateMemoryLayout(target);
	return withWriterLease(root, MEMORY_WRITER_LOCK_PATH, "MEMORY", async () => {
		if ((await listPendingMemoryTransactionsAtRoot(root)).length > 0)
			throw transferError("MEMORY_TRANSFER_IN_PROGRESS");
		const profile = await readMemoryProfileFile(root);
		if (profile.profileId !== journal.profileId) throw transferError("MEMORY_TRANSFER_CONFLICT");
		const state = await loadCanonicalMemoryState(root, profile);
		const barrier = await resolveMemoryPath(root, MEMORY_TRANSFER_LOCK_PATH, { allowMissing: true });
		await writeExclusive(barrier, Buffer.from(barrierDocument(profile.profileId, journal.token, journal.createdAt)));
		return {
			profile,
			state,
			portable: portableState(profile, state),
			records: localRecordFiles(state),
		};
	});
}

async function writeStageFile(staging: string, path: string, bytes: Uint8Array): Promise<void> {
	if (!isCanonicalMemoryRecordPath(path)) throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	const target = join(staging, ...validateProjectRelativePath(path).split("/"));
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}

async function buildStagingProfile(staging: string, decrypted: DecryptedTransfer) {
	await mkdir(staging, { mode: 0o700 });
	for (const directory of MEMORY_LAYOUT_DIRECTORIES) {
		await mkdir(join(staging, ...directory.split("/")), { recursive: true, mode: 0o700 });
	}
	for (const [path, bytes] of [...decrypted.files].sort(([left], [right]) => left.localeCompare(right))) {
		await writeStageFile(staging, path, bytes);
	}
	const opened = await openMemoryProfile(staging);
	if (
		opened.mode !== "read-write" ||
		opened.profile.profileId !== decrypted.profile.profileId ||
		opened.profile.revision !== decrypted.profile.revision
	) {
		throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
	}
	return opened;
}

function profilePolicyView(profile: ResearcherProfileV1): unknown {
	return {
		format: profile.format,
		schemaVersion: profile.schemaVersion,
		profileId: profile.profileId,
		status: profile.status,
		learningPolicy: profile.learningPolicy,
		sensitivityPolicy: profile.sensitivityPolicy,
		retentionPolicy: profile.retentionPolicy,
		budgetPolicy: profile.budgetPolicy,
		createdAt: profile.createdAt,
		createdBy: profile.createdBy,
	};
}

function filesByPath(files: readonly PortableFile[]): Map<string, Buffer> {
	return new Map(files.filter(({ path }) => path !== MEMORY_PROFILE_PATH).map(({ path, bytes }) => [path, bytes]));
}

function mapsEqual(left: ReadonlyMap<string, Buffer>, right: ReadonlyMap<string, Buffer>): boolean {
	return (
		left.size === right.size &&
		[...left].every(([path, bytes]) => {
			const other = right.get(path);
			return other !== undefined && bytes.equals(other);
		})
	);
}

function coveredByTombstone(
	path: string,
	bytes: Uint8Array,
	tombstones: readonly MemoryDeletionTombstoneV1[],
): boolean {
	const pathHash = sha256(path);
	const recordHash = sha256(bytes);
	return tombstones.some(
		({ deletedPathHashes, deletedRecordHashes }) =>
			deletedPathHashes.includes(pathHash) || deletedRecordHashes.includes(recordHash),
	);
}

async function mergePreservedLocalState(
	staging: string,
	incoming: Awaited<ReturnType<typeof buildStagingProfile>>,
	decrypted: DecryptedTransfer,
	local: CapturedLocalState,
): Promise<void> {
	const localPortable = filesByPath(local.portable.files);
	const incomingPortable = new Map([...decrypted.files].filter(([path]) => path !== MEMORY_PROFILE_PATH));
	const localRecords = new Map(local.records.map(({ path, bytes }) => [path, bytes]));
	for (const tombstone of local.state.tombstones) {
		const feedback = local.state.feedback.find((record) => deletionFeedbackMatchesTombstone(record, tombstone));
		if (feedback === undefined) throw transferError("MEMORY_TRANSFER_CONFLICT");
		for (const path of [
			`tombstones/${tombstone.memoryId}.json`,
			`feedback/${memoryMonthPath(feedback.requestedAt)}/${feedback.feedbackId}.json`,
		]) {
			const localBytes = localRecords.get(path);
			const incomingBytes = incomingPortable.get(path);
			if (localBytes === undefined || incomingBytes === undefined || !incomingBytes.equals(localBytes)) {
				throw transferError("MEMORY_TRANSFER_CONFLICT");
			}
		}
	}
	for (const [path, bytes] of localPortable) {
		const incomingBytes = incomingPortable.get(path);
		if (incomingBytes?.equals(bytes)) continue;
		if (incomingBytes === undefined && coveredByTombstone(path, bytes, incoming.tombstones)) continue;
		throw transferError("MEMORY_TRANSFER_CONFLICT");
	}
	const portablePaths = new Set(localPortable.keys());
	const preservedItemPaths = new Set<string>();
	for (const record of local.records) {
		if (portablePaths.has(record.path) || coveredByTombstone(record.path, record.bytes, incoming.tombstones))
			continue;
		const incomingBytes = decrypted.files.get(record.path);
		if (incomingBytes !== undefined) {
			if (!incomingBytes.equals(record.bytes)) throw transferError("MEMORY_TRANSFER_CONFLICT");
			continue;
		}
		await writeStageFile(staging, record.path, record.bytes);
		if (record.path.startsWith("items/")) preservedItemPaths.add(record.path);
	}
	const preservedItems = local.state.items.filter(({ category, memoryId, revision }) =>
		preservedItemPaths.has(`items/${category}/${memoryId}/${revision}.json`),
	);
	const mergedItems = [...incoming.items, ...preservedItems];
	const profile: ResearcherProfileV1 = {
		...incoming.profile,
		preferenceRefs: preferenceRefs(mergedItems),
		currentItemRootHash: memoryItemRootHash(mergedItems),
	};
	await atomicWriteFile(join(staging, MEMORY_PROFILE_PATH), recordBytes(profile));
	const validated = await openMemoryProfile(staging);
	if (validated.mode !== "read-write") throw transferError("MEMORY_TRANSFER_CONFLICT");
}

async function placeBarrierInStage(staging: string, journal: ExchangeJournalV1): Promise<void> {
	await writeExclusive(
		join(staging, ...MEMORY_TRANSFER_LOCK_PATH.split("/")),
		Buffer.from(barrierDocument(journal.profileId, journal.token, journal.createdAt)),
	);
}

async function exchangeDecryptedTransfer(
	home: string,
	decrypted: DecryptedTransfer,
	options: ImportEncryptedMemoryTransferOptions,
): Promise<{ outcome: "imported" | "idempotent"; profileRoot: string; profileRevision: number }> {
	const profileId = decrypted.profile.profileId;
	return withTransferLease(home, profileId, async () => {
		await recoverExchangeUnlocked(home, profileId);
		const target = memoryProfileRoot(home, profileId);
		const targetKind = await pathKind(target);
		if (targetKind === "file") throw transferError("MEMORY_TRANSFER_CONFLICT");
		await assertNoOrphanBarrier(target);
		const token = randomUUID();
		let journal: ExchangeJournalV1 = {
			format: "doro-memory-import-journal",
			version: 1,
			profileId,
			token,
			targetName: profileId,
			stagingName: `.import-${token}`,
			backupName: `.backup-${token}`,
			hadTarget: targetKind === "directory",
			phase: "preparing",
			createdAt: new Date().toISOString(),
		};
		const paths = exchangePaths(home, journal);
		await writeJournal(home, journal);
		let local: CapturedLocalState | null = null;
		let installedRevision = decrypted.profile.revision;
		try {
			if (journal.hadTarget) {
				local = await captureLocalAndCreateBarrier(paths.target, journal);
				journal = { ...journal, phase: "barrier" };
				await writeJournal(home, journal);
			}
			const incoming = await buildStagingProfile(paths.staging, decrypted);
			if (local !== null) {
				const localPortableFiles = filesByPath(local.portable.files);
				const incomingPortableFiles = new Map(
					[...decrypted.files].filter(([path]) => path !== MEMORY_PROFILE_PATH),
				);
				const idempotent =
					mapsEqual(localPortableFiles, incomingPortableFiles) &&
					canonicalStringify(profilePolicyView(local.portable.profile)) ===
						canonicalStringify(profilePolicyView(decrypted.profile));
				if (idempotent) {
					await removeOwnedDirectory(paths.staging, journal.stagingName);
					await removeBarrier(paths.target, profileId, token);
					await deleteJournal(paths.journalPath);
					clearBuffers(local.portable.files.map(({ bytes }) => bytes));
					clearBuffers(local.records.map(({ bytes }) => bytes));
					return {
						outcome: "idempotent",
						profileRoot: paths.target,
						profileRevision: local.profile.revision,
					};
				}
				if (local.state.audit.length > 0) throw transferError("MEMORY_TRANSFER_CONFLICT");
				if (decrypted.profile.revision <= local.profile.revision) throw transferError("MEMORY_TRANSFER_CONFLICT");
				await mergePreservedLocalState(paths.staging, incoming, decrypted, local);
			}
			const staged = await openMemoryProfile(paths.staging, { rebuildCache: false });
			if (staged.mode !== "read-write") throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
			const stagedState = await loadCanonicalMemoryState(staged.root, staged.profile);
			if (!stagedState.transferManifests.some(({ snapshotId }) => snapshotId === decrypted.snapshot.snapshotId)) {
				await appendMemoryRecord(paths.staging, decrypted.snapshot, {
					expectedProfileRevision: staged.profile.revision,
				});
			}
			const finalStage = await openMemoryProfile(paths.staging);
			if (
				finalStage.mode !== "read-write" ||
				(finalStage.cacheStatus !== "valid" && finalStage.cacheStatus !== "rebuilt")
			) {
				throw transferError("MEMORY_TRANSFER_INVALID_BUNDLE");
			}
			installedRevision = finalStage.profile.revision;
			await placeBarrierInStage(paths.staging, journal);
			journal = { ...journal, phase: "staged" };
			await writeJournal(home, journal);
			if (options.faultAfterPhase === "staged") throw transferError("MEMORY_TRANSFER_INTERRUPTED");
			if (journal.hadTarget) {
				await renameDirectory(paths.target, paths.backup);
				journal = { ...journal, phase: "backed_up" };
				await writeJournal(home, journal);
				if (options.faultAfterPhase === "backed_up") throw transferError("MEMORY_TRANSFER_INTERRUPTED");
			}
			await renameDirectory(paths.staging, paths.target);
			journal = { ...journal, phase: "installed" };
			await writeJournal(home, journal);
			if (journal.hadTarget) await removeOwnedDirectory(paths.backup, journal.backupName);
			journal = { ...journal, phase: "committed" };
			await writeJournal(home, journal);
			await removeBarrier(paths.target, profileId, token);
			await deleteJournal(paths.journalPath);
			return {
				outcome: "imported",
				profileRoot: paths.target,
				profileRevision: installedRevision,
			};
		} catch (error) {
			const recovery = await recoverExchangeUnlocked(home, profileId);
			if (recovery === "committed") {
				return {
					outcome: "imported",
					profileRoot: paths.target,
					profileRevision: installedRevision,
				};
			}
			if (error instanceof MemoryTransferError) throw error;
			throw transferError("MEMORY_TRANSFER_IMPORT_FAILED");
		} finally {
			if (local !== null) {
				clearBuffers(local.portable.files.map(({ bytes }) => bytes));
				clearBuffers(local.records.map(({ bytes }) => bytes));
			}
		}
	});
}

async function recordImportedManifest(
	profileRoot: string,
	snapshot: MemorySnapshotManifestV1,
): Promise<{ recorded: boolean; revision: number }> {
	const opened = await openMemoryProfile(profileRoot, { rebuildCache: false });
	if (opened.mode !== "read-write") return { recorded: false, revision: snapshot.profileRevision };
	const state = await loadCanonicalMemoryState(opened.root, opened.profile);
	if (state.transferManifests.some(({ snapshotId }) => snapshotId === snapshot.snapshotId)) {
		return { recorded: true, revision: opened.profile.revision };
	}
	try {
		const appended = await appendMemoryRecord(profileRoot, snapshot, {
			expectedProfileRevision: opened.profile.revision,
		});
		return { recorded: true, revision: appended.profile.revision };
	} catch {
		return { recorded: false, revision: opened.profile.revision };
	}
}

export async function importEncryptedMemoryTransfer(
	doroHome: string,
	bundlePath: string,
	passphrase: Uint8Array,
	options: ImportEncryptedMemoryTransferOptions = {},
): Promise<ImportEncryptedMemoryTransferResult> {
	const decrypted = await decryptTransfer(bundlePath, passphrase);
	try {
		const home = await prepareTransferHome(doroHome);
		const exchange = await exchangeDecryptedTransfer(home, decrypted, options);
		const audit = await recordImportedManifest(exchange.profileRoot, decrypted.snapshot);
		return {
			outcome: exchange.outcome,
			profileRoot: exchange.profileRoot,
			profileId: decrypted.profile.profileId,
			profileRevision: audit.revision,
			snapshotId: decrypted.snapshot.snapshotId,
			manifestRecorded: audit.recorded,
		};
	} finally {
		clearBuffers(decrypted.files.values());
	}
}
