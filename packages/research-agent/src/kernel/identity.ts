// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { RecordKind } from "../contracts/schemas.ts";

export const ID_STRATEGY = "prefixed-uuid-v4" as const;

export type OpaqueIdKind = RecordKind | "project";

const prefixes: Record<OpaqueIdKind, string> = {
	project: "prj",
	source: "src",
	document: "doc",
	evidence: "ev",
	claim: "clm",
	citation_verification: "ver",
	task: "task",
	analysis_run: "run",
	artifact: "art",
	approval: "approval",
	operation: "op",
};

export function createOpaqueId(kind: OpaqueIdKind): string {
	return `${prefixes[kind]}_${randomUUID()}`;
}

export function isOpaqueId(value: string, kind: OpaqueIdKind): boolean {
	return new RegExp(`^${prefixes[kind]}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(
		value,
	);
}
