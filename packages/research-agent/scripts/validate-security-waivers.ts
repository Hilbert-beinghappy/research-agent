// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../docs/security-waivers.json", import.meta.url));
const allowedKeys = new Set(["advisoryId", "expiresAt", "owner", "riskExplanation"]);

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.waivers)) {
	throw new TypeError("Security waiver manifest must contain version 1 and a waivers array");
}

const advisoryIds = new Set<string>();
for (const [index, waiver] of parsed.waivers.entries()) {
	if (!object(waiver) || Object.keys(waiver).some((key) => !allowedKeys.has(key))) {
		throw new TypeError(`Security waiver ${index} has an invalid shape`);
	}
	const { advisoryId, expiresAt, owner, riskExplanation } = waiver;
	if (typeof advisoryId !== "string" || !/^(?:GHSA-[a-z0-9-]+|CVE-\d{4}-\d{4,})$/u.test(advisoryId)) {
		throw new TypeError(`Security waiver ${index} requires a GHSA or CVE advisory ID`);
	}
	if (advisoryIds.has(advisoryId)) throw new TypeError(`Duplicate security waiver: ${advisoryId}`);
	advisoryIds.add(advisoryId);
	if (typeof riskExplanation !== "string" || riskExplanation.trim().length < 20) {
		throw new TypeError(`Security waiver ${advisoryId} requires a substantive risk explanation`);
	}
	if (typeof owner !== "string" || owner.trim().length === 0) {
		throw new TypeError(`Security waiver ${advisoryId} requires an owner`);
	}
	if (
		typeof expiresAt !== "string" ||
		!Number.isFinite(Date.parse(expiresAt)) ||
		Date.parse(expiresAt) <= Date.now()
	) {
		throw new TypeError(`Security waiver ${advisoryId} is invalid or expired`);
	}
}

process.stdout.write(`Validated ${parsed.waivers.length} active security waiver(s).\n`);
