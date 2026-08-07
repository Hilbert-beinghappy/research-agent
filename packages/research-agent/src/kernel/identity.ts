// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { RecordKind } from "../contracts/schemas.ts";

export const ID_STRATEGY = "prefixed-uuid-v4" as const;

export type OpaqueIdKind = RecordKind | "project" | "backup" | "exchange_bundle" | "change_set";

const prefixes: Record<OpaqueIdKind, string> = {
	project: "prj",
	backup: "backup",
	exchange_bundle: "bundle",
	change_set: "changeset",
	source: "src",
	document: "doc",
	evidence: "ev",
	claim: "clm",
	citation_verification: "ver",
	research_question_version: "rqv",
	concept: "concept",
	theory_relation: "relation",
	design_decision: "decision",
	protocol: "protocol",
	dataset: "dataset",
	variable: "variable",
	analysis_specification: "spec",
	qualitative_material: "material",
	qualitative_segment: "segment",
	codebook_version: "codebook",
	model_suggestion: "suggestion",
	coding_decision: "coding",
	theme_synthesis: "theme",
	manuscript: "manuscript",
	section: "section",
	claim_occurrence: "occurrence",
	review_finding: "finding",
	revision_decision: "revision",
	disclosure: "disclosure",
	submission_gate_report: "gate",
	adapter_export_profile: "export-profile",
	external_item_link: "external-link",
	monitor_subscription: "monitor",
	monitor_run: "monitor-run",
	adapter_registration: "adapter-registration",
	exchange_record: "exchange",
	collaboration_merge: "merge",
	model_route_decision: "route",
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
