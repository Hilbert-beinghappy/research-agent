// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify } from "../../../../src/contracts/canonical-json.ts";
import { memoryProfileRoot } from "../../../../src/memory/layout.ts";
import { appendMemoryItem, createMemoryProfile, openMemoryProfile } from "../../../../src/memory/store.ts";
import {
	exportEncryptedMemoryTransfer,
	importEncryptedMemoryTransfer,
	type MemoryTransferError,
	verifyEncryptedMemoryTransfer,
} from "../../../../src/memory/transfer.ts";
import { itemDraft } from "../../../integration/memory/security/retrieval-fixtures.ts";

interface MutableBundle {
	format: string;
	version: number;
	kdf: { saltBase64: string };
	wrappedDek: { nonceBase64: string };
	encryptedManifest: { nonceBase64: string };
	entries: Array<{ path: string; ciphertextBase64: string }>;
	[key: string]: unknown;
}

let temporaryDirectory: string;
let profileRoot: string;
let bundlePath: string;
const profileId = "profile-crypto";
const semanticNeedle = "zz-Secret";
const passphraseNeedle = "correct horse transfer secret";

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-transfer-crypto-"));
	profileRoot = join(temporaryDirectory, "source-profile");
	bundlePath = join(temporaryDirectory, "profile.doro-memory");
	const created = await createMemoryProfile(profileRoot, { profileId });
	if (created.mode !== "read-write") throw new Error("expected writable profile");
	await appendMemoryItem(
		profileRoot,
		itemDraft(profileId, "memory-language", {
			category: "writing",
			key: "language",
			value: semanticNeedle,
			allowedEffects: ["formatting"],
		}),
		{ expectedProfileRevision: 0 },
	);
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function exportedBundle(path = bundlePath): Promise<MutableBundle> {
	await exportEncryptedMemoryTransfer(profileRoot, path, Buffer.from(passphraseNeedle));
	return JSON.parse(await readFile(path, "utf8")) as MutableBundle;
}

async function rejectionCode(action: Promise<unknown>): Promise<{ code: string; text: string }> {
	try {
		await action;
		throw new Error("expected transfer rejection");
	} catch (error) {
		const transfer = error as MemoryTransferError;
		return { code: transfer.code, text: String(error) };
	}
}

describe("Personal Memory transfer secret and authentication boundary", () => {
	it("keeps passphrases, keys, profile metadata, and plaintext outside the transfer artifact", async () => {
		const bundle = await exportedBundle();
		const artifact = await readFile(bundlePath, "utf8");
		expect(bundle).toMatchObject({
			format: "doro-memory-transfer",
			version: 1,
			cipher: "AES-256-GCM",
			kdf: { name: "scrypt", N: 131_072, r: 8, p: 1 },
		});
		expect(artifact).not.toContain(passphraseNeedle);
		expect(artifact).not.toContain(semanticNeedle);
		expect(artifact).not.toContain(profileId);
		expect(artifact).not.toContain("profile.json");
		await expect(verifyEncryptedMemoryTransfer(bundlePath, Buffer.from(passphraseNeedle))).resolves.toMatchObject({
			snapshot: { profileId, profileRevision: 1 },
			fileCount: 2,
		});

		const doroHome = join(temporaryDirectory, "target-home");
		const imported = await importEncryptedMemoryTransfer(doroHome, bundlePath, Buffer.from(passphraseNeedle));
		expect(imported).toMatchObject({ outcome: "imported", profileId, manifestRecorded: true });
		const opened = await openMemoryProfile(memoryProfileRoot(doroHome, profileId));
		if (opened.mode !== "read-write") throw new Error("expected imported writable profile");
		expect(opened.activeItems.map(({ value }) => value)).toContain(semanticNeedle);
		const persisted = await readFile(join(memoryProfileRoot(doroHome, profileId), "profile.json"), "utf8");
		expect(persisted).not.toContain(passphraseNeedle);
	});

	it("returns one authentication failure for a wrong passphrase or ciphertext/tag tampering", async () => {
		const bundle = await exportedBundle();
		const wrong = await rejectionCode(verifyEncryptedMemoryTransfer(bundlePath, Buffer.from("wrong passphrase")));
		bundle.entries[0]!.ciphertextBase64 =
			`${bundle.entries[0]!.ciphertextBase64[0] === "A" ? "B" : "A"}${bundle.entries[0]!.ciphertextBase64.slice(1)}`;
		const tamperedPath = join(temporaryDirectory, "tampered.doro-memory");
		await writeFile(tamperedPath, `${canonicalStringify(bundle)}\n`);
		const tampered = await rejectionCode(verifyEncryptedMemoryTransfer(tamperedPath, Buffer.from(passphraseNeedle)));
		expect(wrong.code).toBe("MEMORY_TRANSFER_AUTHENTICATION_FAILED");
		expect(tampered).toEqual(wrong);
		expect(wrong.text).not.toContain(passphraseNeedle);
		expect(wrong.text).not.toContain(semanticNeedle);
	});

	it("uses fresh salt and nonces and rejects unauthenticated format extensions", async () => {
		const first = await exportedBundle();
		const secondPath = join(temporaryDirectory, "second.doro-memory");
		const second = await exportedBundle(secondPath);
		const firstRandomValues = [
			first.kdf.saltBase64,
			first.wrappedDek.nonceBase64,
			first.encryptedManifest.nonceBase64,
		];
		const secondRandomValues = [
			second.kdf.saltBase64,
			second.wrappedDek.nonceBase64,
			second.encryptedManifest.nonceBase64,
		];
		expect(new Set(firstRandomValues).size).toBe(firstRandomValues.length);
		expect(secondRandomValues.every((value) => !firstRandomValues.includes(value))).toBe(true);

		first.compression = { algorithm: "zip", expandedBytes: Number.MAX_SAFE_INTEGER };
		const extendedPath = join(temporaryDirectory, "extended.doro-memory");
		await writeFile(extendedPath, `${canonicalStringify(first)}\n`);
		await expect(verifyEncryptedMemoryTransfer(extendedPath, Buffer.from(passphraseNeedle))).rejects.toMatchObject({
			code: "MEMORY_TRANSFER_INVALID_BUNDLE",
		});
	});
});
