// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import type { HashValue } from "../contracts/schemas.ts";

export function hashBytes(value: string | Uint8Array): HashValue {
	return { algorithm: "sha256", value: createHash("sha256").update(value).digest("hex") };
}

export function hashCanonicalJson(value: unknown): HashValue {
	return hashBytes(canonicalStringify(value));
}

export async function hashFile(path: string): Promise<HashValue> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return { algorithm: "sha256", value: hash.digest("hex") };
}

export function verifyBytes(value: string | Uint8Array, expected: HashValue): boolean {
	return expected.algorithm === "sha256" && hashBytes(value).value === expected.value;
}
