// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { canonicalStringify } from "./canonical-json.ts";
import type { HashValue } from "./schemas.ts";

export function hashBytes(value: string | Uint8Array): HashValue {
	return { algorithm: "sha256", value: createHash("sha256").update(value).digest("hex") };
}

export function hashCanonicalJson(value: unknown): HashValue {
	return hashBytes(canonicalStringify(value));
}

export function verifyBytes(value: string | Uint8Array, expected: HashValue): boolean {
	return expected.algorithm === "sha256" && hashBytes(value).value === expected.value;
}
