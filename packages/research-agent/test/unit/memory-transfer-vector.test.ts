// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, scrypt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";

interface TransferCryptoVector {
	format: "doro-memory-transfer-crypto-vector";
	version: 1;
	description: string;
	kdf: { name: "scrypt"; N: number; r: number; p: number; maxmem: number };
	cipher: "AES-256-GCM";
	input: {
		passphraseUtf8: string;
		saltHex: string;
		dekHex: string;
		nonceHex: string;
		aadBase64: string;
	};
	expected: { kekHex: string; ciphertextHex: string; tagHex: string };
}

async function deriveKey(vector: TransferCryptoVector): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(
			Buffer.from(vector.input.passphraseUtf8, "utf8"),
			Buffer.from(vector.input.saltHex, "hex"),
			32,
			{ N: vector.kdf.N, r: vector.kdf.r, p: vector.kdf.p, maxmem: vector.kdf.maxmem },
			(error, key) => {
				if (error !== null) reject(error);
				else resolve(Buffer.from(key));
			},
		);
	});
}

describe("Memory transfer v1 cross-platform crypto vector", () => {
	it("matches the fixed scrypt and AES-256-GCM known answer and decrypts it", async () => {
		const vector = JSON.parse(
			await readFile(new URL("../../evals/v3/memory-transfer-v1-crypto-vector.json", import.meta.url), "utf8"),
		) as TransferCryptoVector;
		expect(vector).toMatchObject({
			format: "doro-memory-transfer-crypto-vector",
			version: 1,
			kdf: { name: "scrypt", N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
			cipher: "AES-256-GCM",
		});
		const aad = Buffer.from(canonicalStringify({ format: "doro-memory-transfer-key-aad", version: 1 }), "utf8");
		expect(aad.toString("base64")).toBe(vector.input.aadBase64);
		const key = await deriveKey(vector);
		try {
			expect(key.toString("hex")).toBe(vector.expected.kekHex);
			const nonce = Buffer.from(vector.input.nonceHex, "hex");
			const plaintext = Buffer.from(vector.input.dekHex, "hex");
			const cipher = createCipheriv("aes-256-gcm", key, nonce, {
				authTagLength: 16,
			});
			cipher.setAAD(aad);
			const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
			const tag = cipher.getAuthTag();
			expect(ciphertext.toString("hex")).toBe(vector.expected.ciphertextHex);
			expect(tag.toString("hex")).toBe(vector.expected.tagHex);

			const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
				authTagLength: 16,
			});
			decipher.setAAD(aad);
			decipher.setAuthTag(tag);
			expect(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("hex")).toBe(
				vector.input.dekHex,
			);
		} finally {
			key.fill(0);
		}
	});
});
