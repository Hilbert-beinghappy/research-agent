// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { HashValue } from "../contracts/schemas.ts";

export { hashBytes, hashCanonicalJson, verifyBytes } from "../contracts/integrity.ts";

export async function hashFile(path: string): Promise<HashValue> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return { algorithm: "sha256", value: hash.digest("hex") };
}
