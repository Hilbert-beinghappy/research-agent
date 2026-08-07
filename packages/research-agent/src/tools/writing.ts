// SPDX-License-Identifier: Apache-2.0

import { citationStatusCheck, currentCitation, locatedEvidence, sourceIntegrityCheck } from "../artifacts/gates.ts";
import type {
	ApprovalRecord,
	BibliographyEntry,
	ClaimOccurrence,
	ClaimRecord,
	DisclosureRecord,
	ManuscriptRecord,
	RecordKind,
	RecordRef,
	ResearchResult,
	ReviewFinding,
	RevisionDecision,
	SectionRecord,
	SemanticProvenance,
	SubmissionGateCheck,
	SubmissionGateReport,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashBytes, hashCanonicalJson } from "../kernel/integrity.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import {
	listProjectRecordIds,
	type ProjectRecord,
	projectRecordId,
	projectRecordRevision,
} from "../project/record-index.ts";
import { createRecord, createRecords, readRecord } from "../project/records.ts";

export interface ManuscriptOccurrenceDraft {
	claimId: string;
	text: string;
	charStart: number;
	charEnd: number;
	core: boolean;
	citationKeys: string[];
	evidenceIds: string[];
}

export interface ManuscriptSectionDraft {
	sectionKey: string;
	title: string;
	order: number;
	content: string;
	occurrences: ManuscriptOccurrenceDraft[];
}

export interface CreateManuscriptRevisionRequest {
	title: string;
	paperType: ManuscriptRecord["paperType"];
	abstract: string | null;
	bibliography: BibliographyEntry[];
	methodRecords: RecordRef[];
	sections: ManuscriptSectionDraft[];
	supersedesManuscriptId: string | null;
	authoring: ManuscriptRecord["authoring"];
	expectedManifestRevision: number;
	operationId: string;
}

export interface ManuscriptBundle {
	manuscript: ManuscriptRecord;
	sections: SectionRecord[];
	occurrences: ClaimOccurrence[];
}

export interface ManuscriptRevisionDiff {
	fromManuscriptId: string;
	toManuscriptId: string;
	added: string[];
	removed: string[];
	changed: Array<{
		sectionKey: string;
		beforeHash: string;
		afterHash: string;
		beforeContent: string;
		afterContent: string;
	}>;
}

export interface ReviewFindingDraft {
	reviewerRole: ReviewFinding["reviewerRole"];
	findingType: ReviewFinding["findingType"];
	severity: ReviewFinding["severity"];
	title: string;
	message: string;
	sectionId: string | null;
	claimOccurrenceId: string | null;
}

export interface ModelReviewProvenance {
	provider: string;
	modelId: string;
	thinkingLevel: string | null;
}

export interface SubmissionGateEvaluation {
	checks: SubmissionGateCheck[];
	coreClaimOccurrenceCoverage: number;
	citationVerificationCoverage: number;
	openP0ReviewFindingCount: number;
	passed: boolean;
}

type RecordOfKind<Kind extends RecordKind> = Extract<ProjectRecord, { kind: Kind }>;

function audit(operationId: string, now: string) {
	return {
		createdAt: now,
		updatedAt: now,
		revision: 0,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

function propagatedFailure<Value>(result: Extract<ResearchResult<unknown>, { ok: false }>): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, error.operationId, error.details);
}

async function requiredRecord(projectRoot: string, kind: RecordKind, id: string): Promise<ProjectRecord> {
	const result = await readRecord(projectRoot, kind, id);
	if (!result.ok) throw new TypeError(result.errors[0].message);
	return result.value;
}

async function recordsOfKind<Kind extends RecordKind>(projectRoot: string, kind: Kind): Promise<RecordOfKind<Kind>[]> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const records: RecordOfKind<Kind>[] = [];
	// ponytail: O(n) file scan; add a derived writing index only after project benchmarks require one.
	for (const id of await listProjectRecordIds(opened.root, opened.manifest, kind)) {
		const record = await requiredRecord(opened.root, kind, id);
		if (record.kind !== kind) throw new TypeError(`Invalid ${kind} record ${id}`);
		records.push(record as RecordOfKind<Kind>);
	}
	return records;
}

function ref(record: ProjectRecord): RecordRef {
	return { kind: record.kind, id: projectRecordId(record), revision: projectRecordRevision(record) };
}

function gateCheck(
	code: string,
	status: SubmissionGateCheck["status"],
	message: string,
	records: readonly ProjectRecord[] = [],
): SubmissionGateCheck {
	return { code, status, message, recordRefs: records.map(ref) };
}

export function countManuscriptWords(value: string): number {
	const han = value.match(/\p{Script=Han}/gu)?.length ?? 0;
	const other = value.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length;
	return han + (other ?? 0);
}

export function extractCitationKeys(value: string): string[] {
	return [
		...new Set(
			[...value.matchAll(/@([\p{L}\p{N}_.:/+-]+)/gu)].map((match) => match[1]).filter((key) => key !== undefined),
		),
	].sort();
}

export function manuscriptContentHash(request: {
	title: string;
	paperType: ManuscriptRecord["paperType"];
	abstract: string | null;
	bibliography: readonly BibliographyEntry[];
	methodRecords: readonly RecordRef[];
	sections: readonly ManuscriptSectionDraft[];
}) {
	return hashCanonicalJson({
		title: request.title,
		paperType: request.paperType,
		abstract: request.abstract,
		bibliography: [...request.bibliography].sort((left, right) => left.citationKey.localeCompare(right.citationKey)),
		methodRecords: [...request.methodRecords].sort((left, right) =>
			`${left.kind}:${left.id}:${left.revision}`.localeCompare(`${right.kind}:${right.id}:${right.revision}`),
		),
		sections: [...request.sections]
			.sort((left, right) => left.order - right.order)
			.map((section) => ({
				sectionKey: section.sectionKey,
				title: section.title,
				order: section.order,
				content: section.content,
				occurrences: section.occurrences.map((occurrence) => ({ ...occurrence })),
			})),
	});
}

export async function loadManuscriptBundle(
	projectRoot: string,
	manuscriptId: string,
): Promise<ResearchResult<ManuscriptBundle>> {
	try {
		const manuscript = await requiredRecord(projectRoot, "manuscript", manuscriptId);
		if (manuscript.kind !== "manuscript") throw new TypeError(`Invalid manuscript ${manuscriptId}`);
		const sections = await Promise.all(
			manuscript.sectionIds.map(async (sectionId) => {
				const section = await requiredRecord(projectRoot, "section", sectionId);
				if (section.kind !== "section" || section.manuscriptId !== manuscriptId) {
					throw new TypeError(`Section ${sectionId} is not part of manuscript ${manuscriptId}`);
				}
				return section;
			}),
		);
		const occurrences = await Promise.all(
			manuscript.claimOccurrenceIds.map(async (claimOccurrenceId) => {
				const occurrence = await requiredRecord(projectRoot, "claim_occurrence", claimOccurrenceId);
				if (occurrence.kind !== "claim_occurrence" || occurrence.manuscriptId !== manuscriptId) {
					throw new TypeError(`Claim occurrence ${claimOccurrenceId} is not part of manuscript ${manuscriptId}`);
				}
				return occurrence;
			}),
		);
		return successResult(
			{
				manuscript,
				sections: sections.sort((left, right) => left.order - right.order),
				occurrences,
			},
			null,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"MANUSCRIPT_LOAD_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Manuscript could not be loaded",
			null,
		);
	}
}

export async function createManuscriptRevision(
	projectRoot: string,
	request: CreateManuscriptRevisionRequest,
): Promise<ResearchResult<ManuscriptBundle>> {
	try {
		const opened = await openProject(projectRoot, request.expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		if (request.sections.length === 0) throw new TypeError("Manuscript requires at least one section");
		const sectionsByOrder = [...request.sections].sort((left, right) => left.order - right.order);
		if (
			new Set(sectionsByOrder.map(({ sectionKey }) => sectionKey)).size !== sectionsByOrder.length ||
			sectionsByOrder.some(({ order }, index) => order !== index)
		) {
			throw new TypeError("Manuscript sections require unique keys and contiguous zero-based order");
		}
		if (new Set(request.bibliography.map(({ citationKey }) => citationKey)).size !== request.bibliography.length) {
			throw new TypeError("Bibliography citation keys must be unique");
		}
		for (const entry of request.bibliography) await requiredRecord(opened.root, "source", entry.sourceId);
		for (const methodRef of request.methodRecords) {
			if (methodRef.kind !== "analysis_run" && methodRef.kind !== "theme_synthesis") {
				throw new TypeError("Method records must reference an AnalysisRun or ThemeSynthesis");
			}
			const methodRecord = await requiredRecord(opened.root, methodRef.kind, methodRef.id);
			if (projectRecordRevision(methodRecord) !== methodRef.revision) {
				throw new TypeError(`Method record ${methodRef.kind} ${methodRef.id} revision is stale`);
			}
		}

		let manuscriptSeriesId = `manuscript-series-${createOpaqueId("manuscript")}`;
		let version = 1;
		if (request.supersedesManuscriptId !== null) {
			const previous = await requiredRecord(opened.root, "manuscript", request.supersedesManuscriptId);
			if (previous.kind !== "manuscript") throw new TypeError("Superseded manuscript is invalid");
			if (previous.paperType !== request.paperType)
				throw new TypeError("Manuscript revisions must retain paper type");
			manuscriptSeriesId = previous.manuscriptSeriesId;
			version = previous.version + 1;
		}

		const manuscriptId = createOpaqueId("manuscript");
		const now = new Date().toISOString();
		const sections: SectionRecord[] = sectionsByOrder.map((section) => ({
			kind: "section",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			sectionId: createOpaqueId("section"),
			manuscriptId,
			sectionKey: section.sectionKey,
			title: section.title,
			order: section.order,
			content: section.content,
			contentHash: hashBytes(section.content),
			wordCount: countManuscriptWords(section.content),
			audit: audit(request.operationId, now),
		}));
		const claims = new Map<string, ClaimRecord>();
		const occurrences: ClaimOccurrence[] = [];
		for (const [sectionIndex, sectionDraft] of sectionsByOrder.entries()) {
			const section = sections[sectionIndex];
			if (section === undefined) throw new TypeError("Manuscript section indexing failed");
			for (const occurrenceDraft of sectionDraft.occurrences) {
				if (
					occurrenceDraft.charEnd <= occurrenceDraft.charStart ||
					sectionDraft.content.slice(occurrenceDraft.charStart, occurrenceDraft.charEnd) !== occurrenceDraft.text
				) {
					throw new TypeError(`Claim occurrence does not match section ${sectionDraft.sectionKey}`);
				}
				let claim = claims.get(occurrenceDraft.claimId);
				if (claim === undefined) {
					const record = await requiredRecord(opened.root, "claim", occurrenceDraft.claimId);
					if (record.kind !== "claim") throw new TypeError(`Invalid claim ${occurrenceDraft.claimId}`);
					claim = record;
					claims.set(claim.claimId, claim);
				}
				for (const evidenceId of occurrenceDraft.evidenceIds) {
					const evidence = await requiredRecord(opened.root, "evidence", evidenceId);
					if (
						evidence.kind !== "evidence" ||
						!claim.evidenceLinks.some((link) => link.evidenceId === evidenceId)
					) {
						throw new TypeError(`Evidence ${evidenceId} is not linked to claim ${claim.claimId}`);
					}
				}
				occurrences.push({
					kind: "claim_occurrence",
					schemaVersion: RESEARCH_SCHEMA_VERSION,
					claimOccurrenceId: createOpaqueId("claim_occurrence"),
					manuscriptId,
					sectionId: section.sectionId,
					claimId: occurrenceDraft.claimId,
					text: occurrenceDraft.text,
					charStart: occurrenceDraft.charStart,
					charEnd: occurrenceDraft.charEnd,
					anchorHash: hashBytes(occurrenceDraft.text),
					core: occurrenceDraft.core,
					citationKeys: [...occurrenceDraft.citationKeys],
					evidenceIds: [...occurrenceDraft.evidenceIds],
					audit: audit(request.operationId, now),
				});
			}
		}
		const manuscript: ManuscriptRecord = {
			kind: "manuscript",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			manuscriptId,
			manuscriptSeriesId,
			version,
			paperType: request.paperType,
			title: request.title,
			abstract: request.abstract,
			sectionIds: sections.map(({ sectionId }) => sectionId),
			claimOccurrenceIds: occurrences.map(({ claimOccurrenceId }) => claimOccurrenceId),
			bibliography: request.bibliography.map((entry) => ({ ...entry })),
			methodRecords: request.methodRecords.map((entry) => ({ ...entry })),
			supersedesManuscriptId: request.supersedesManuscriptId,
			authoring: { ...request.authoring },
			contentHash: manuscriptContentHash(request),
			createdAt: now,
			audit: audit(request.operationId, now),
		};
		const created = await createRecords(opened.root, [manuscript, ...sections, ...occurrences], {
			expectedManifestRevision: opened.manifest.revision,
			operationId: request.operationId,
		});
		return created.ok
			? successResult({ manuscript, sections, occurrences }, request.operationId)
			: propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"MANUSCRIPT_CREATE_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Manuscript revision could not be created",
			request.operationId,
		);
	}
}

export async function diffManuscriptRevisions(
	projectRoot: string,
	fromManuscriptId: string,
	toManuscriptId: string,
): Promise<ResearchResult<ManuscriptRevisionDiff>> {
	const [from, to] = await Promise.all([
		loadManuscriptBundle(projectRoot, fromManuscriptId),
		loadManuscriptBundle(projectRoot, toManuscriptId),
	]);
	if (!from.ok) return propagatedFailure(from);
	if (!to.ok) return propagatedFailure(to);
	if (from.value.manuscript.manuscriptSeriesId !== to.value.manuscript.manuscriptSeriesId) {
		return failureResult(
			"PERMANENT_FAILURE",
			"MANUSCRIPT_SERIES_MISMATCH",
			"validation",
			"Manuscript diff requires revisions from the same series",
			null,
		);
	}
	const before = new Map(from.value.sections.map((section) => [section.sectionKey, section]));
	const after = new Map(to.value.sections.map((section) => [section.sectionKey, section]));
	return successResult(
		{
			fromManuscriptId,
			toManuscriptId,
			added: [...after.keys()].filter((key) => !before.has(key)).sort(),
			removed: [...before.keys()].filter((key) => !after.has(key)).sort(),
			changed: [...before]
				.filter(([key, section]) => after.get(key)?.contentHash.value !== section.contentHash.value)
				.map(([sectionKey, section]) => ({
					sectionKey,
					beforeHash: section.contentHash.value,
					afterHash: after.get(sectionKey)?.contentHash.value ?? "",
					beforeContent: section.content,
					afterContent: after.get(sectionKey)?.content ?? "",
				}))
				.sort((left, right) => left.sectionKey.localeCompare(right.sectionKey)),
		},
		null,
	);
}

export function reviewFindingFingerprint(manuscriptId: string, draft: ReviewFindingDraft) {
	return hashCanonicalJson({ manuscriptId, ...draft });
}

export async function recordReviewFindings(
	projectRoot: string,
	manuscriptId: string,
	drafts: ReviewFindingDraft[],
	source: ReviewFinding["source"],
	model: ModelReviewProvenance | null,
	expectedManifestRevision: number,
	operationId: string,
): Promise<ResearchResult<ReviewFinding[]>> {
	try {
		const opened = await openProject(projectRoot, expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const bundle = await loadManuscriptBundle(opened.root, manuscriptId);
		if (!bundle.ok) return propagatedFailure(bundle);
		if ((source === "model") !== (model !== null)) throw new TypeError("Review model provenance is inconsistent");
		const sections = new Set(bundle.value.manuscript.sectionIds);
		const occurrences = new Set(bundle.value.manuscript.claimOccurrenceIds);
		for (const draft of drafts) {
			if (draft.sectionId !== null && !sections.has(draft.sectionId)) {
				throw new TypeError(`Review section ${draft.sectionId} is outside the manuscript`);
			}
			if (draft.claimOccurrenceId !== null && !occurrences.has(draft.claimOccurrenceId)) {
				throw new TypeError(`Review claim occurrence ${draft.claimOccurrenceId} is outside the manuscript`);
			}
			if ((source === "deterministic") !== (draft.findingType === "deterministic_violation")) {
				throw new TypeError("Only deterministic checks can record deterministic violations");
			}
		}
		const existing = await recordsOfKind(opened.root, "review_finding");
		const existingByFingerprint = new Map(
			existing
				.filter((finding) => finding.manuscriptId === manuscriptId)
				.map((finding) => [finding.fingerprint.value, finding]),
		);
		const now = new Date().toISOString();
		const findings: ReviewFinding[] = [];
		for (const draft of drafts) {
			const fingerprint = reviewFindingFingerprint(manuscriptId, draft);
			const duplicate = existingByFingerprint.get(fingerprint.value);
			if (duplicate !== undefined) {
				findings.push(duplicate);
				continue;
			}
			const finding: ReviewFinding = {
				kind: "review_finding",
				schemaVersion: RESEARCH_SCHEMA_VERSION,
				reviewFindingId: createOpaqueId("review_finding"),
				manuscriptId,
				...draft,
				fingerprint,
				source,
				model: model === null ? null : { ...model },
				createdAt: now,
				audit: audit(operationId, now),
			};
			existingByFingerprint.set(fingerprint.value, finding);
			findings.push(finding);
		}
		const fresh = [
			...new Map(
				findings
					.filter((finding) => finding.audit.createdByOperationId === operationId)
					.map((finding) => [finding.reviewFindingId, finding]),
			).values(),
		];
		if (fresh.length > 0) {
			const created = await createRecords(opened.root, fresh, {
				expectedManifestRevision: opened.manifest.revision,
				operationId,
			});
			if (!created.ok) return propagatedFailure(created);
		}
		return successResult(
			[...new Map(findings.map((finding) => [finding.reviewFindingId, finding])).values()],
			operationId,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"REVIEW_FINDING_RECORD_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Review findings could not be recorded",
			operationId,
		);
	}
}

export async function recordRevisionDecision(
	projectRoot: string,
	request: {
		fromManuscriptId: string | null;
		toManuscriptId: string;
		reviewFindingId: string | null;
		decision: RevisionDecision["decision"];
		rationale: string;
		expectedManifestRevision: number;
		operationId: string;
	},
): Promise<ResearchResult<RevisionDecision>> {
	try {
		const opened = await openProject(projectRoot, request.expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const target = await requiredRecord(opened.root, "manuscript", request.toManuscriptId);
		if (target.kind !== "manuscript") throw new TypeError("Revision target is not a manuscript");
		if (request.fromManuscriptId !== null) {
			const source = await requiredRecord(opened.root, "manuscript", request.fromManuscriptId);
			if (source.kind !== "manuscript" || source.manuscriptSeriesId !== target.manuscriptSeriesId) {
				throw new TypeError("Revision decision manuscripts must belong to the same series");
			}
		}
		const findingDecision = ["accept", "reject", "defer"].includes(request.decision);
		if (findingDecision !== (request.reviewFindingId !== null)) {
			throw new TypeError("Review dispositions require one review finding");
		}
		if (request.reviewFindingId !== null) {
			const finding = await requiredRecord(opened.root, "review_finding", request.reviewFindingId);
			if (finding.kind !== "review_finding" || finding.manuscriptId !== target.manuscriptId) {
				throw new TypeError("Review finding does not belong to the target manuscript");
			}
		}
		const now = new Date().toISOString();
		const decision: RevisionDecision = {
			kind: "revision_decision",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			revisionDecisionId: createOpaqueId("revision_decision"),
			manuscriptSeriesId: target.manuscriptSeriesId,
			fromManuscriptId: request.fromManuscriptId,
			toManuscriptId: target.manuscriptId,
			reviewFindingId: request.reviewFindingId,
			decision: request.decision,
			rationale: request.rationale,
			decidedAt: now,
			decidedBy: "user",
			audit: audit(request.operationId, now),
		};
		const created = await createRecord(opened.root, decision, {
			expectedManifestRevision: opened.manifest.revision,
			operationId: request.operationId,
		});
		return created.ok ? successResult(decision, request.operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"REVISION_DECISION_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Revision decision could not be recorded",
			request.operationId,
		);
	}
}

export async function createDisclosure(
	projectRoot: string,
	request: {
		manuscriptId: string;
		aiUse: string;
		modelIds: string[];
		humanResponsibilities: string[];
		limitations: string[];
		unautomatedDecisions: string[];
		expectedManifestRevision: number;
		operationId: string;
	},
): Promise<ResearchResult<DisclosureRecord>> {
	try {
		const opened = await openProject(projectRoot, request.expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		await requiredRecord(opened.root, "manuscript", request.manuscriptId);
		const now = new Date().toISOString();
		const disclosure: DisclosureRecord = {
			kind: "disclosure",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			disclosureId: createOpaqueId("disclosure"),
			manuscriptId: request.manuscriptId,
			aiUse: request.aiUse,
			modelIds: [...new Set(request.modelIds)],
			humanResponsibilities: [...request.humanResponsibilities],
			limitations: [...request.limitations],
			unautomatedDecisions: [...request.unautomatedDecisions],
			status: "confirmed",
			confirmation: { decision: "confirmed", decidedAt: now, decidedBy: "user", note: null },
			createdAt: now,
			audit: audit(request.operationId, now),
		};
		const created = await createRecord(opened.root, disclosure, {
			expectedManifestRevision: opened.manifest.revision,
			operationId: request.operationId,
		});
		return created.ok ? successResult(disclosure, request.operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"DISCLOSURE_CREATE_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Disclosure could not be created",
			request.operationId,
		);
	}
}

async function validSubmissionApproval(
	projectRoot: string,
	approvalId: string,
	manuscriptId: string,
): Promise<ApprovalRecord | null> {
	const record = await requiredRecord(projectRoot, "approval", approvalId);
	return record.kind === "approval" &&
		record.decision === "approved" &&
		record.actionClass === "publish_or_submit" &&
		record.actionName === "research.manuscript.mark_submission_candidate" &&
		record.dataEgress.recordRefs.some(({ kind, id }) => kind === "manuscript" && id === manuscriptId)
		? record
		: null;
}

function hasKnownSemanticProvenance(provenance: SemanticProvenance | undefined): boolean {
	return provenance !== undefined && provenance.method !== "deterministic" && provenance.method !== "unknown_legacy";
}

export async function evaluateSubmissionGate(
	projectRoot: string,
	manuscriptId: string,
	approvalId: string | null,
): Promise<ResearchResult<SubmissionGateEvaluation>> {
	try {
		const bundleResult = await loadManuscriptBundle(projectRoot, manuscriptId);
		if (!bundleResult.ok) return propagatedFailure(bundleResult);
		const bundle = bundleResult.value;
		const sections = new Map(bundle.sections.map((section) => [section.sectionId, section]));
		const bibliography = new Map(bundle.manuscript.bibliography.map((entry) => [entry.citationKey, entry]));
		const sources = new Map<string, RecordOfKind<"source">>();
		for (const entry of bibliography.values()) {
			const source = await requiredRecord(projectRoot, "source", entry.sourceId);
			if (source.kind !== "source") throw new TypeError(`Invalid bibliography source ${entry.sourceId}`);
			sources.set(source.sourceId, source);
		}
		const allCitations = await recordsOfKind(projectRoot, "citation_verification");
		const checks: SubmissionGateCheck[] = [];
		const manuscriptText = bundle.sections.map(({ content }) => content).join("\n");
		const markedCitationKeys = new Set(extractCitationKeys(manuscriptText));
		const unknownMarkers = [...markedCitationKeys].filter((key) => !bibliography.has(key));
		checks.push(
			gateCheck(
				"citation_key_closure",
				unknownMarkers.length === 0 ? "passed" : "failed",
				unknownMarkers.length === 0
					? "Every Markdown citation key resolves to the bibliography"
					: `Unknown citation keys: ${unknownMarkers.join(", ")}`,
				[bundle.manuscript],
			),
		);

		let coreCount = 0;
		let mappedCoreCount = 0;
		let occurrenceIntegrity = true;
		let declaredCitationIntegrity = true;
		let semanticProvenanceIntegrity = true;
		const semanticProvenanceRecords = new Map<string, ProjectRecord>();
		const usedSourceIds = new Set<string>();
		const causalClaims: ClaimRecord[] = [];
		for (const occurrence of bundle.occurrences) {
			const section = sections.get(occurrence.sectionId);
			const claim = await requiredRecord(projectRoot, "claim", occurrence.claimId);
			if (section === undefined || claim.kind !== "claim") {
				occurrenceIntegrity = false;
				continue;
			}
			semanticProvenanceRecords.set(`${claim.kind}:${projectRecordId(claim)}`, claim);
			if (!hasKnownSemanticProvenance(claim.semanticProvenance?.claim)) {
				semanticProvenanceIntegrity = false;
			}
			if (
				section.content.slice(occurrence.charStart, occurrence.charEnd) !== occurrence.text ||
				hashBytes(occurrence.text).value !== occurrence.anchorHash.value
			) {
				occurrenceIntegrity = false;
			}
			if (occurrence.citationKeys.some((key) => !bibliography.has(key) || !markedCitationKeys.has(key))) {
				declaredCitationIntegrity = false;
			}
			const citedSourceIds = new Set(
				occurrence.citationKeys
					.map((key) => bibliography.get(key)?.sourceId)
					.filter((id): id is string => id !== undefined),
			);
			for (const sourceId of citedSourceIds) usedSourceIds.add(sourceId);
			const supportingEvidence = [];
			for (const evidenceId of occurrence.evidenceIds) {
				const evidence = await requiredRecord(projectRoot, "evidence", evidenceId);
				if (evidence.kind === "evidence") {
					semanticProvenanceRecords.set(`${evidence.kind}:${projectRecordId(evidence)}`, evidence);
					const linkIndex = claim.evidenceLinks.findIndex((link) => link.evidenceId === evidenceId);
					if (
						!hasKnownSemanticProvenance(evidence.extraction) ||
						linkIndex < 0 ||
						!hasKnownSemanticProvenance(claim.semanticProvenance?.evidenceLinks[linkIndex])
					) {
						semanticProvenanceIntegrity = false;
					}
				}
				if (
					evidence.kind === "evidence" &&
					claim.evidenceLinks.some(
						(link) =>
							link.evidenceId === evidenceId && (link.relation === "supports" || link.relation === "qualifies"),
					) &&
					locatedEvidence(evidence)
				) {
					supportingEvidence.push(evidence);
				}
			}
			if (occurrence.core) {
				coreCount += 1;
				const mapped =
					supportingEvidence.length > 0 &&
					supportingEvidence.some((evidence) => citedSourceIds.has(evidence.sourceId)) &&
					["supported", "partially_supported", "mixed"].includes(claim.supportStatus);
				if (mapped) mappedCoreCount += 1;
				if (claim.claimType === "causal") causalClaims.push(claim);
			}
		}
		const coreCoverage = coreCount === 0 ? 1 : mappedCoreCount / coreCount;
		checks.push(
			gateCheck(
				"semantic_provenance",
				semanticProvenanceIntegrity ? "passed" : "failed",
				semanticProvenanceIntegrity
					? "Every manuscript claim and evidence interpretation has an auditable semantic source"
					: "One or more manuscript claims or evidence interpretations have missing or unknown semantic provenance",
				[...semanticProvenanceRecords.values()],
			),
			gateCheck(
				"claim_occurrence_integrity",
				occurrenceIntegrity ? "passed" : "failed",
				occurrenceIntegrity
					? "Every ClaimOccurrence matches its immutable section locator and anchor"
					: "One or more ClaimOccurrences no longer match their section locator or anchor",
				[bundle.manuscript, ...bundle.sections, ...bundle.occurrences],
			),
			gateCheck(
				"declared_citations",
				declaredCitationIntegrity ? "passed" : "failed",
				declaredCitationIntegrity
					? "Every declared claim citation is present in manuscript text and bibliography"
					: "A declared claim citation is missing from manuscript text or bibliography",
				[bundle.manuscript, ...bundle.occurrences],
			),
			gateCheck(
				"core_claim_evidence",
				coreCoverage === 1 ? "passed" : "failed",
				`${mappedCoreCount}/${coreCount} core ClaimOccurrences map to located supporting evidence and its cited source`,
				[bundle.manuscript, ...bundle.occurrences.filter(({ core }) => core)],
			),
		);

		let verifiedSourceCount = 0;
		for (const sourceId of [...usedSourceIds].sort()) {
			const source = sources.get(sourceId);
			if (source === undefined) continue;
			const metadataCheck = sourceIntegrityCheck(source);
			const citationCheck = citationStatusCheck(source, await currentCitation(projectRoot, source, allCitations));
			checks.push(
				{
					code: metadataCheck.name,
					status: metadataCheck.status,
					message: metadataCheck.message,
					recordRefs: metadataCheck.recordRefs,
				},
				{
					code: citationCheck.name,
					status: citationCheck.status,
					message: citationCheck.message,
					recordRefs: citationCheck.recordRefs,
				},
			);
			if (metadataCheck.status !== "failed" && citationCheck.status !== "failed") verifiedSourceCount += 1;
		}
		const citationCoverage = usedSourceIds.size === 0 ? 1 : verifiedSourceCount / usedSourceIds.size;
		checks.push(
			gateCheck(
				"citation_verification_coverage",
				citationCoverage === 1 ? "passed" : "failed",
				`${verifiedSourceCount}/${usedSourceIds.size} cited sources have current formal verification`,
				[bundle.manuscript],
			),
		);

		const methodRecords: ProjectRecord[] = [];
		for (const methodRef of bundle.manuscript.methodRecords) {
			const method = await requiredRecord(projectRoot, methodRef.kind, methodRef.id);
			if (projectRecordRevision(method) !== methodRef.revision)
				throw new TypeError("Manuscript method snapshot is stale");
			methodRecords.push(method);
		}
		const needsQuantitative =
			bundle.manuscript.paperType === "quantitative" || bundle.manuscript.paperType === "mixed_methods";
		const needsQualitative =
			bundle.manuscript.paperType === "qualitative" || bundle.manuscript.paperType === "mixed_methods";
		const successfulRuns = methodRecords.filter(
			(record) => record.kind === "analysis_run" && record.status === "succeeded",
		);
		const confirmedThemes = methodRecords.filter(
			(record) => record.kind === "theme_synthesis" && record.status === "confirmed",
		);
		checks.push(
			gateCheck(
				"method_results",
				(!needsQuantitative || successfulRuns.length > 0) && (!needsQualitative || confirmedThemes.length > 0)
					? "passed"
					: "failed",
				"Declared paper type must reference successful quantitative runs and/or confirmed qualitative synthesis",
				methodRecords,
			),
		);
		if (causalClaims.length > 0 && needsQuantitative) {
			let causalRun = false;
			for (const run of successfulRuns) {
				if (run.kind !== "analysis_run") continue;
				const specification = await requiredRecord(
					projectRoot,
					"analysis_specification",
					run.analysisSpecificationId,
				);
				if (
					specification.kind === "analysis_specification" &&
					specification.status === "confirmed" &&
					specification.claimMode === "causal"
				) {
					causalRun = true;
				}
			}
			checks.push(
				gateCheck(
					"causal_claim_boundary",
					causalRun ? "passed" : "failed",
					causalRun
						? "Core causal claims reference a successful run from a confirmed causal specification"
						: "Core causal claims lack a successful run from a confirmed causal specification",
					causalClaims,
				),
			);
		}

		const disclosures = (await recordsOfKind(projectRoot, "disclosure")).filter(
			(record) => record.manuscriptId === manuscriptId && record.status === "confirmed",
		);
		checks.push(
			gateCheck(
				"ai_disclosure",
				disclosures.length > 0 ? "passed" : "failed",
				disclosures.length > 0
					? "A user-confirmed AI disclosure is attached to this manuscript revision"
					: "A user-confirmed AI disclosure is required",
				disclosures,
			),
		);

		const findings = (await recordsOfKind(projectRoot, "review_finding")).filter(
			(finding) => finding.manuscriptId === manuscriptId && finding.severity === "P0",
		);
		const decisions = await recordsOfKind(projectRoot, "revision_decision");
		let openP0 = 0;
		for (const finding of findings) {
			const latest = decisions
				.filter((decision) => decision.reviewFindingId === finding.reviewFindingId)
				.sort(
					(left, right) =>
						Date.parse(right.decidedAt) - Date.parse(left.decidedAt) ||
						right.revisionDecisionId.localeCompare(left.revisionDecisionId),
				)[0];
			if (finding.findingType === "deterministic_violation" || latest?.decision !== "reject") openP0 += 1;
		}
		checks.push(
			gateCheck(
				"open_p0_review_findings",
				openP0 === 0 ? "passed" : "failed",
				openP0 === 0 ? "No unresolved P0 review findings remain" : `${openP0} unresolved P0 review findings remain`,
				findings,
			),
		);

		let approval: ApprovalRecord | null = null;
		if (approvalId !== null) approval = await validSubmissionApproval(projectRoot, approvalId, manuscriptId);
		checks.push(
			gateCheck(
				"publish_approval",
				approval !== null ? "passed" : approvalId === null ? "warning" : "failed",
				approval !== null
					? "User approved the publish-or-submit action"
					: approvalId === null
						? "Publish-or-submit requires explicit user approval"
						: "Approval is not a valid approved publish-or-submit action",
				approval === null ? [] : [approval],
			),
		);

		const hasFailure = checks.some(({ status }) => status === "failed");
		const hasWarning = checks.some(({ status }) => status === "warning");
		return successResult(
			{
				checks,
				coreClaimOccurrenceCoverage: coreCoverage,
				citationVerificationCoverage: citationCoverage,
				openP0ReviewFindingCount: openP0,
				passed: !hasFailure && (!hasWarning || approval !== null),
			},
			null,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"SUBMISSION_GATE_EVALUATION_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Submission gate could not be evaluated",
			null,
		);
	}
}

export async function createSubmissionGateReport(
	projectRoot: string,
	manuscriptId: string,
	approvalId: string | null,
	expectedManifestRevision: number,
	operationId: string,
): Promise<ResearchResult<SubmissionGateReport>> {
	try {
		const opened = await openProject(projectRoot, expectedManifestRevision);
		if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
		const evaluation = await evaluateSubmissionGate(opened.root, manuscriptId, approvalId);
		if (!evaluation.ok) return propagatedFailure(evaluation);
		const acceptedApprovalId = evaluation.value.checks.some(
			({ code, status }) => code === "publish_approval" && status === "passed",
		)
			? approvalId
			: null;
		const now = new Date().toISOString();
		const report: SubmissionGateReport = {
			kind: "submission_gate_report",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			submissionGateReportId: createOpaqueId("submission_gate_report"),
			manuscriptId,
			passed: evaluation.value.passed,
			publishability: evaluation.value.passed
				? "submission_candidate"
				: evaluation.value.checks.some(({ status }) => status === "failed")
					? "blocked"
					: "evidence_checked",
			checks: evaluation.value.checks,
			coreClaimOccurrenceCoverage: evaluation.value.coreClaimOccurrenceCoverage,
			citationVerificationCoverage: evaluation.value.citationVerificationCoverage,
			openP0ReviewFindingCount: evaluation.value.openP0ReviewFindingCount,
			warningsAccepted: acceptedApprovalId !== null,
			approvalId: acceptedApprovalId,
			checkedAt: now,
			audit: audit(operationId, now),
		};
		const created = await createRecord(opened.root, report, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		return created.ok ? successResult(report, operationId) : propagatedFailure(created);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"SUBMISSION_GATE_RECORD_FAILED",
			error instanceof TypeError ? "validation" : "runtime",
			error instanceof Error ? error.message : "Submission gate report could not be recorded",
			operationId,
		);
	}
}

export async function renderManuscriptMarkdown(
	projectRoot: string,
	manuscriptId: string,
): Promise<ResearchResult<string>> {
	const bundle = await loadManuscriptBundle(projectRoot, manuscriptId);
	if (!bundle.ok) return propagatedFailure(bundle);
	const lines = [`# ${bundle.value.manuscript.title}`, ""];
	if (bundle.value.manuscript.abstract !== null) {
		lines.push("## Abstract", "", bundle.value.manuscript.abstract, "");
	}
	for (const section of bundle.value.sections) lines.push(`## ${section.title}`, "", section.content, "");
	if (bundle.value.manuscript.bibliography.length > 0) {
		lines.push("## References", "");
		for (const entry of [...bundle.value.manuscript.bibliography].sort((left, right) =>
			left.citationKey.localeCompare(right.citationKey),
		)) {
			lines.push(`- [@${entry.citationKey}] — ${entry.sourceId}`);
		}
		lines.push("");
	}
	return successResult(`${lines.join("\n")}\n`, null);
}
