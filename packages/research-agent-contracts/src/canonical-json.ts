// SPDX-License-Identifier: Apache-2.0

import type { JsonValue } from "./schemas.ts";

function canonicalize(value: unknown, path: string): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
	if (typeof value !== "object") throw new TypeError(`${path} contains non-JSON value ${typeof value}`);

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} is not a plain JSON object`);

	const result: Record<string, JsonValue> = {};
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key === "symbol")) throw new TypeError(`${path} contains a symbol key`);
	for (const key of (keys as string[]).sort()) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
			throw new TypeError(`${path}.${key} is not an enumerable JSON value`);
		}
		result[key] = canonicalize(descriptor.value, `${path}.${key}`);
	}
	return result;
}

export function canonicalizeJson(value: unknown): JsonValue {
	return canonicalize(value, "$root");
}

export function canonicalStringify(value: unknown): string {
	return JSON.stringify(canonicalizeJson(value)) as string;
}
