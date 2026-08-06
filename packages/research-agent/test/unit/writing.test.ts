// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	ApprovalRecord,
	CitationVerification,
	ClaimRecord,
	EvidenceCard,
	OperationRecord,
	RecordRef,
	SourceRecord,
} from "../../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { hashBytes } from "../../src/kernel/integrity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord, createRecords, updateRecord } from "../../src/project/records.ts";
import { validateProject } from "../../src/project/validate.ts";
import { startOperation } from "../../src/tools/operations.ts";
import {
	createDisclosure,
	createManuscriptRevision,
	createSubmissionGateReport,
	diffManuscriptRevisions,
	evaluateSubmissionGate,
	recordReviewFindings,
	recordRevisionDecision,
} from "../../src/tools/writing.ts";

let temporaryDirectory: string;
let projectRoot: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-research-writing-"));
	projectRoot = join(temporaryDirectory, "project");
	await initializeProject(projectRoot, { title: "Auditable manuscript fixture" });
});

afterEach(async () => {
	await rm(temporaryDirectory, { recursive: true, force: true });
});

async function manifestRevision(): Promise<number> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	return opened.manifest.revision;
}

async function operation(name: string, inputs: RecordRef[] = []): Promise<OperationRecord> {
	const started = await startOperation(projectRoot, {
		operationKind: "tool",
		name,
		implementationVersion: "0.4.0",
		session: null,
		inputs,
	});
	if (!started.ok) throw new Error(started.errors[0].message);
	return started.value;
}

async function conceptualRevision(operationId: string, content: string, supersedesManuscriptId: string | null) {
	return createManuscriptRevision(projectRoot, {
		title: "Evidence-aware public management",
		paperType: "conceptual",
		abstract: null,
		bibliography: [],
		methodRecords: [],
		sections: [{ sectionKey: "introduction", title: "Introduction", order: 0, content, occurrences: [] }],
		supersedesManuscriptId,
		authoring: { origin: "human", provider: null, modelId: null },
		expectedManifestRevision: await manifestRevision(),
		operationId,
	});
}

function audit(operationId: string, now: string) {
	return {
		createdAt: now,
		updatedAt: now,
		revision: 0,
		createdByOperationId: operationId,
		updatedByOperationId: operationId,
	};
}

async function seedEvidence(): Promise<{
	source: SourceRecord;
	evidence: EvidenceCard;
	claim: ClaimRecord;
	verification: CitationVerification;
}> {
	const seed = await operation("fixture.seed");
	const now = new Date().toISOString();
	const sourceId = createOpaqueId("source");
	const evidenceId = createOpaqueId("evidence");
	const claimId = createOpaqueId("claim");
	const source: SourceRecord = {
		kind: "source",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		sourceId,
		identifiers: [
			{
				scheme: "doi",
				value: "10.5555/writing.1",
				normalizedValue: "10.5555/writing.1",
				verified: false,
				verificationId: null,
			},
		],
		title: "Evidence boundaries in public management",
		titleNormalized: "evidence boundaries in public management",
		contributors: [{ family: "Chen", given: "Lin", literal: null, orcid: null }],
		issuedDate: "2025",
		containerTitle: "Synthetic Public Administration",
		publisher: "Fixture Press",
		sourceType: "journal-article",
		language: "en",
		abstractText: null,
		abstractRights: "metadata_only",
		discovery: [
			{
				adapterId: "fixture",
				adapterVersion: "0.4.0",
				queryText: "evidence boundaries",
				queryHash: hashBytes("evidence boundaries"),
				discoveredAt: now,
				rank: 1,
				rawRecord: {
					path: ".research/runs/fixture/source.json",
					hash: hashBytes("{}\n"),
					mediaType: "application/json",
					bytes: 3,
				},
				requestOperationId: seed.operationId,
			},
		],
		dedupKeys: {
			doi: "10.5555/writing.1",
			strongIdentifier: "doi:10.5555/writing.1",
			normalizedTitleYearFirstAuthor: "evidence boundaries|2025|chen",
			contentHash: null,
		},
		duplicateStatus: "canonical",
		canonicalSourceId: null,
		metadataConflicts: [],
		publicationStatus: "normal",
		audit: audit(seed.operationId, now),
	};
	const claim: ClaimRecord = {
		kind: "claim",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		claimId,
		text: "Evidence boundaries improve auditability.",
		claimType: "methodological",
		scope: "Synthetic public-management fixture",
		evidenceLinks: [{ evidenceId, relation: "supports", assessment: "Located fixture evidence" }],
		supportStatus: "supported",
		conflictEvidenceIds: [],
		humanConfirmation: { status: "accepted", decidedAt: now, note: "Fixture review" },
		publishability: "evidence_checked",
		audit: audit(seed.operationId, now),
	};
	const evidence: EvidenceCard = {
		kind: "evidence",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		evidenceId,
		sourceId,
		documentId: "doc_fixture",
		evidenceLevel: "table_or_figure_located",
		locator: {
			locatorType: "table",
			pageStart: 1,
			pageEnd: 1,
			sectionPath: ["Results"],
			label: "Table 1",
			charStart: null,
			charEnd: null,
			anchorHash: hashBytes("table-1"),
		},
		excerpt: null,
		excerptExactMatch: null,
		paraphrase: "The fixture reports an auditable evidence boundary.",
		evidenceStatement: "The claim is supported within the synthetic fixture.",
		claimLinks: [{ claimId, relation: "supports", rationale: "Fixture link" }],
		extraction: {
			method: "deterministic",
			operationId: seed.operationId,
			modelProvider: null,
			modelId: null,
			promptHash: null,
		},
		confidence: { level: "high", basis: "Located fixture", limitations: [] },
		rights: { excerptAllowed: true, maxStoredWords: 100, publicExportAllowed: true },
		humanStatus: "accepted",
		validity: "active",
		supersedesEvidenceId: null,
		audit: audit(seed.operationId, now),
	};
	const seeded = await createRecords(projectRoot, [source, claim, evidence], {
		expectedManifestRevision: await manifestRevision(),
		operationId: seed.operationId,
	});
	if (!seeded.ok) throw new Error(seeded.errors[0].message);

	const citationOperation = await operation("fixture.verify", [
		{ kind: "source", id: sourceId, revision: source.audit.revision },
	]);
	const verificationId = createOpaqueId("citation_verification");
	const verification: CitationVerification = {
		kind: "citation_verification",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		verificationId,
		sourceId,
		citationKey: "chen2025",
		identifiers: source.identifiers.map((identifier) => ({
			...identifier,
			verified: true,
			verificationId,
		})),
		verificationSources: [
			{
				adapterId: "fixture",
				adapterVersion: "0.4.0",
				checkedAt: now,
				rawRecord: {
					path: ".research/runs/fixture/verification.json",
					hash: hashBytes("{}\n"),
					mediaType: "application/json",
					bytes: 3,
				},
				operationId: citationOperation.operationId,
			},
		],
		fieldChecks: [
			{
				field: "identifier",
				expected: "10.5555/writing.1",
				observed: "10.5555/writing.1",
				status: "match",
				sourceAdapterId: "fixture",
			},
		],
		publicationStatus: "normal",
		conflicts: [],
		finalStatus: "verified",
		verifiedAt: now,
		expiresAt: "2099-01-01T00:00:00.000Z",
		audit: audit(citationOperation.operationId, now),
	};
	const verified = await createRecord(projectRoot, verification, {
		expectedManifestRevision: await manifestRevision(),
		operationId: citationOperation.operationId,
	});
	if (!verified.ok) throw new Error(verified.errors[0].message);
	return { source, evidence, claim, verification };
}

async function evidenceClaimVariant(
	base: Awaited<ReturnType<typeof seedEvidence>>,
	label: string,
	source: SourceRecord,
	options: {
		evidenceLevel?: EvidenceCard["evidenceLevel"];
		claimType?: ClaimRecord["claimType"];
		supportStatus?: ClaimRecord["supportStatus"];
	} = {},
): Promise<{ source: SourceRecord; evidence: EvidenceCard; claim: ClaimRecord }> {
	const createdBy = await operation(`fixture.variant.${label}`);
	const now = new Date().toISOString();
	const evidenceId = createOpaqueId("evidence");
	const claimId = createOpaqueId("claim");
	const evidenceLevel = options.evidenceLevel ?? "table_or_figure_located";
	const located = ["fulltext_located", "table_or_figure_located", "dataset_or_appendix_located"].includes(
		evidenceLevel,
	);
	const evidence: EvidenceCard = {
		...base.evidence,
		evidenceId,
		sourceId: source.sourceId,
		documentId: located ? base.evidence.documentId : null,
		evidenceLevel,
		locator: located ? base.evidence.locator : null,
		excerpt: located ? null : `${label} abstract evidence`,
		excerptExactMatch: located ? null : true,
		claimLinks: [{ claimId, relation: "supports", rationale: `Injected ${label} link` }],
		audit: audit(createdBy.operationId, now),
	};
	const claim: ClaimRecord = {
		...base.claim,
		claimId,
		claimType: options.claimType ?? base.claim.claimType,
		supportStatus: options.supportStatus ?? base.claim.supportStatus,
		evidenceLinks: [{ evidenceId, relation: "supports", assessment: `Injected ${label} evidence` }],
		audit: audit(createdBy.operationId, now),
	};
	const created = await createRecords(projectRoot, [claim, evidence], {
		expectedManifestRevision: await manifestRevision(),
		operationId: createdBy.operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	return { source, evidence, claim };
}

async function sourceVariant(
	base: Awaited<ReturnType<typeof seedEvidence>>,
	label: string,
	changes: Pick<SourceRecord, "metadataConflicts" | "publicationStatus">,
): Promise<{ source: SourceRecord; evidence: EvidenceCard; claim: ClaimRecord }> {
	const createdBy = await operation(`fixture.source.${label}`);
	const now = new Date().toISOString();
	const sourceId = createOpaqueId("source");
	const doi = `10.5555/${label}`;
	const source: SourceRecord = {
		...base.source,
		sourceId,
		identifiers: [
			{
				...base.source.identifiers[0],
				value: doi,
				normalizedValue: doi,
				verified: false,
				verificationId: null,
			},
		],
		title: `${base.source.title} ${label}`,
		titleNormalized: `${base.source.titleNormalized} ${label}`,
		dedupKeys: {
			doi,
			strongIdentifier: `doi:${doi}`,
			normalizedTitleYearFirstAuthor: `${label}|2025|chen`,
			contentHash: null,
		},
		publicationStatus: changes.publicationStatus,
		metadataConflicts: changes.metadataConflicts,
		audit: audit(createdBy.operationId, now),
	};
	const created = await createRecord(projectRoot, source, {
		expectedManifestRevision: await manifestRevision(),
		operationId: createdBy.operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	return evidenceClaimVariant(base, label, source);
}

async function approval(operationId: string, manuscriptId: string): Promise<ApprovalRecord> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("Expected current project");
	const now = new Date().toISOString();
	const record: ApprovalRecord = {
		kind: "approval",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		approvalId: createOpaqueId("approval"),
		taskId: null,
		operationId,
		actionClass: "publish_or_submit",
		actionName: "research.manuscript.mark_submission_candidate",
		impactScope: ["manuscript submission candidate"],
		estimatedCost: null,
		dataEgress: {
			destination: null,
			dataClasses: [],
			fileRefs: [],
			recordRefs: [{ kind: "manuscript", id: manuscriptId, revision: 0 }],
		},
		overwriteRisk: { paths: [], destructive: false, recoverable: true },
		requestMessage: "Approve manuscript submission candidate",
		requestedAt: now,
		policySnapshotHash: hashBytes("fixture-policy"),
		decision: "approved",
		scope: "once",
		scopeTarget: {
			projectId: opened.manifest.projectId,
			sessionId: null,
			actionFingerprint: "fixture-submission",
			destinationPattern: null,
			pathPatterns: [],
			maxApprovedCost: null,
		},
		decidedAt: now,
		decidedBy: "user",
		expiresAt: null,
		note: "Synthetic user approval",
		audit: audit(operationId, now),
	};
	const created = await createRecord(projectRoot, record, {
		expectedManifestRevision: opened.manifest.revision,
		operationId,
	});
	if (!created.ok) throw new Error(created.errors[0].message);
	return record;
}

describe("manuscript writing contracts", () => {
	it("keeps immutable revisions, deterministic diffs, and deduplicated review findings", async () => {
		const writer = await operation("research.manuscript");
		const first = await conceptualRevision(writer.operationId, "First auditable draft.", null);
		if (!first.ok) throw new Error(first.errors[0].message);
		const second = await conceptualRevision(
			writer.operationId,
			"Second auditable draft with a boundary.",
			first.value.manuscript.manuscriptId,
		);
		if (!second.ok) throw new Error(second.errors[0].message);
		expect(second.value.manuscript).toMatchObject({
			manuscriptSeriesId: first.value.manuscript.manuscriptSeriesId,
			version: 2,
			supersedesManuscriptId: first.value.manuscript.manuscriptId,
		});
		const diff = await diffManuscriptRevisions(
			projectRoot,
			first.value.manuscript.manuscriptId,
			second.value.manuscript.manuscriptId,
		);
		expect(diff).toMatchObject({ ok: true, value: { changed: [{ sectionKey: "introduction" }] } });

		const draft = {
			reviewerRole: "editor" as const,
			findingType: "evidence_based_concern" as const,
			severity: "P0" as const,
			title: "Boundary missing",
			message: "State the scope boundary explicitly.",
			sectionId: first.value.sections[0]?.sectionId ?? null,
			claimOccurrenceId: null,
		};
		const findings = await recordReviewFindings(
			projectRoot,
			first.value.manuscript.manuscriptId,
			[draft, draft],
			"model",
			{ provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: null },
			await manifestRevision(),
			writer.operationId,
		);
		expect(findings).toMatchObject({ ok: true, value: [{ reviewFindingId: expect.any(String) }] });
		if (!findings.ok) throw new Error(findings.errors[0].message);
		expect(new Set(findings.value.map(({ reviewFindingId }) => reviewFindingId))).toHaveProperty("size", 1);
		const decision = await recordRevisionDecision(projectRoot, {
			fromManuscriptId: first.value.manuscript.manuscriptId,
			toManuscriptId: first.value.manuscript.manuscriptId,
			reviewFindingId: findings.value[0]?.reviewFindingId ?? null,
			decision: "reject",
			rationale: "The revised scope statement resolves the concern outside this frozen revision.",
			expectedManifestRevision: await manifestRevision(),
			operationId: writer.operationId,
		});
		expect(decision).toMatchObject({ ok: true, value: { decidedBy: "user", decision: "reject" } });
		expect(await validateProject(projectRoot)).toMatchObject({ valid: true, issues: [] });
	});

	it("passes only located, verified, disclosed, and explicitly approved core claims", async () => {
		const seeded = await seedEvidence();
		const writer = await operation("research.manuscript");
		const content = "Evidence boundaries improve auditability [@chen2025].";
		const manuscript = await createManuscriptRevision(projectRoot, {
			title: "Auditable evidence boundaries",
			paperType: "literature_review",
			abstract: "A synthetic audit manuscript.",
			bibliography: [{ citationKey: "chen2025", sourceId: seeded.source.sourceId }],
			methodRecords: [],
			sections: [
				{
					sectionKey: "findings",
					title: "Findings",
					order: 0,
					content,
					occurrences: [
						{
							claimId: seeded.claim.claimId,
							text: content,
							charStart: 0,
							charEnd: content.length,
							core: true,
							citationKeys: ["chen2025"],
							evidenceIds: [seeded.evidence.evidenceId],
						},
					],
				},
			],
			supersedesManuscriptId: null,
			authoring: { origin: "model", provider: "deepseek", modelId: "deepseek-v4-flash" },
			expectedManifestRevision: await manifestRevision(),
			operationId: writer.operationId,
		});
		if (!manuscript.ok) throw new Error(manuscript.errors[0].message);
		const preview = await evaluateSubmissionGate(projectRoot, manuscript.value.manuscript.manuscriptId, null);
		expect(preview).toMatchObject({
			ok: true,
			value: { passed: false, coreClaimOccurrenceCoverage: 1, citationVerificationCoverage: 1 },
		});
		expect(JSON.stringify(preview)).toContain("ai_disclosure");
		expect(JSON.stringify(preview)).toContain("publish_approval");

		const disclosure = await createDisclosure(projectRoot, {
			manuscriptId: manuscript.value.manuscript.manuscriptId,
			aiUse: "AI assisted section drafting and rubric review.",
			modelIds: ["deepseek-v4-flash"],
			humanResponsibilities: ["The author verified every claim and citation."],
			limitations: ["AI review is not human peer review."],
			unautomatedDecisions: ["Final interpretation and submission decision."],
			expectedManifestRevision: await manifestRevision(),
			operationId: writer.operationId,
		});
		expect(disclosure).toMatchObject({ ok: true, value: { status: "confirmed" } });
		const approved = await approval(writer.operationId, manuscript.value.manuscript.manuscriptId);
		const evaluated = await evaluateSubmissionGate(
			projectRoot,
			manuscript.value.manuscript.manuscriptId,
			approved.approvalId,
		);
		expect(evaluated).toMatchObject({
			ok: true,
			value: {
				passed: true,
				coreClaimOccurrenceCoverage: 1,
				citationVerificationCoverage: 1,
				openP0ReviewFindingCount: 0,
			},
		});
		const other = await conceptualRevision(writer.operationId, "A different immutable draft.", null);
		if (!other.ok) throw new Error(other.errors[0].message);
		const otherDisclosure = await createDisclosure(projectRoot, {
			manuscriptId: other.value.manuscript.manuscriptId,
			aiUse: "AI assisted a separate synthetic draft.",
			modelIds: ["deepseek-v4-flash"],
			humanResponsibilities: ["The author owns factual review."],
			limitations: ["Synthetic fixture only."],
			unautomatedDecisions: ["Submission remains a human decision."],
			expectedManifestRevision: await manifestRevision(),
			operationId: writer.operationId,
		});
		if (!otherDisclosure.ok) throw new Error(otherDisclosure.errors[0].message);
		const reusedApproval = await evaluateSubmissionGate(
			projectRoot,
			other.value.manuscript.manuscriptId,
			approved.approvalId,
		);
		expect(reusedApproval).toMatchObject({
			ok: true,
			value: {
				passed: false,
				checks: expect.arrayContaining([expect.objectContaining({ code: "publish_approval", status: "failed" })]),
			},
		});
		const report = await createSubmissionGateReport(
			projectRoot,
			manuscript.value.manuscript.manuscriptId,
			approved.approvalId,
			await manifestRevision(),
			writer.operationId,
		);
		expect(report).toMatchObject({
			ok: true,
			value: { passed: true, publishability: "submission_candidate", warningsAccepted: true },
		});
		const retargetedApproval = await updateRecord(projectRoot, "approval", approved.approvalId, {
			expectedManifestRevision: await manifestRevision(),
			expectedRecordRevision: 0,
			operationId: writer.operationId,
			changes: {
				dataEgress: {
					...approved.dataEgress,
					recordRefs: [{ kind: "manuscript", id: other.value.manuscript.manuscriptId, revision: 0 }],
				},
			},
		});
		expect(retargetedApproval).toMatchObject({ ok: true });
		expect(await validateProject(projectRoot)).toMatchObject({
			valid: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: "INVALID_SUBMISSION_GATE_REPORT" })]),
		});
	});

	it("blocks invented citations, unsupported core claims, and causal overclaim", async () => {
		const seeded = await seedEvidence();
		const writer = await operation("research.manuscript");
		const invented = "An unsupported statement [@invented2026].";
		const broken = await createManuscriptRevision(projectRoot, {
			title: "Injected boundary failures",
			paperType: "literature_review",
			abstract: null,
			bibliography: [{ citationKey: "chen2025", sourceId: seeded.source.sourceId }],
			methodRecords: [],
			sections: [
				{
					sectionKey: "findings",
					title: "Findings",
					order: 0,
					content: invented,
					occurrences: [
						{
							claimId: seeded.claim.claimId,
							text: invented,
							charStart: 0,
							charEnd: invented.length,
							core: true,
							citationKeys: ["invented2026"],
							evidenceIds: [],
						},
					],
				},
			],
			supersedesManuscriptId: null,
			authoring: { origin: "human", provider: null, modelId: null },
			expectedManifestRevision: await manifestRevision(),
			operationId: writer.operationId,
		});
		if (!broken.ok) throw new Error(broken.errors[0].message);
		const brokenGate = await evaluateSubmissionGate(projectRoot, broken.value.manuscript.manuscriptId, null);
		expect(brokenGate).toMatchObject({
			ok: true,
			value: { passed: false, coreClaimOccurrenceCoverage: 0 },
		});
		expect(JSON.stringify(brokenGate)).toContain("citation_key_closure");
		expect(JSON.stringify(brokenGate)).toContain("core_claim_evidence");

		const causal: ClaimRecord = {
			...seeded.claim,
			claimId: createOpaqueId("claim"),
			claimType: "causal",
			text: "The intervention caused the outcome.",
		};
		const causalCreated = await createRecord(projectRoot, causal, {
			expectedManifestRevision: await manifestRevision(),
			operationId: causal.audit.createdByOperationId,
		});
		if (!causalCreated.ok) throw new Error(causalCreated.errors[0].message);
		const causalText = "The intervention caused the outcome [@chen2025].";
		const causalManuscript = await createManuscriptRevision(projectRoot, {
			title: "Injected causal overclaim",
			paperType: "quantitative",
			abstract: null,
			bibliography: [{ citationKey: "chen2025", sourceId: seeded.source.sourceId }],
			methodRecords: [],
			sections: [
				{
					sectionKey: "results",
					title: "Results",
					order: 0,
					content: causalText,
					occurrences: [
						{
							claimId: causal.claimId,
							text: causalText,
							charStart: 0,
							charEnd: causalText.length,
							core: true,
							citationKeys: ["chen2025"],
							evidenceIds: [seeded.evidence.evidenceId],
						},
					],
				},
			],
			supersedesManuscriptId: null,
			authoring: { origin: "human", provider: null, modelId: null },
			expectedManifestRevision: await manifestRevision(),
			operationId: writer.operationId,
		});
		if (!causalManuscript.ok) throw new Error(causalManuscript.errors[0].message);
		const causalGate = await evaluateSubmissionGate(
			projectRoot,
			causalManuscript.value.manuscript.manuscriptId,
			null,
		);
		expect(JSON.stringify(causalGate)).toContain("method_results");
		expect(JSON.stringify(causalGate)).toContain("causal_claim_boundary");
	});

	it("detects all 20 declared manuscript failure injections without a false pass", async () => {
		interface FailureCase {
			caseId: string;
			scenario: string;
			expectedGate: string;
			expectedStatus: "failed" | "warning";
			falseSuccess: boolean;
		}
		const inventory = JSON.parse(
			await readFile(new URL("../../evals/v0.4/failure-cases.json", import.meta.url), "utf8"),
		) as { version: string; cases: FailureCase[] };
		expect(inventory.version).toBe("0.4.0");
		expect(inventory.cases).toHaveLength(20);
		expect(inventory.cases.every(({ falseSuccess }) => !falseSuccess)).toBe(true);

		const base = await seedEvidence();
		const abstractEvidence = await evidenceClaimVariant(base, "abstract", base.source, {
			evidenceLevel: "abstract",
		});
		const unsupported = await evidenceClaimVariant(base, "unsupported", base.source, {
			supportStatus: "unsupported",
		});
		const causal = await evidenceClaimVariant(base, "causal", base.source, { claimType: "causal" });
		const unverified = await sourceVariant(base, "unverified", {
			publicationStatus: "normal",
			metadataConflicts: [],
		});
		const retracted = await sourceVariant(base, "retracted", {
			publicationStatus: "retracted",
			metadataConflicts: [],
		});
		const rawRecord = base.source.discovery[0]?.rawRecord;
		if (rawRecord === undefined) throw new Error("Fixture source is missing discovery provenance");
		const conflicted = await sourceVariant(base, "conflicted", {
			publicationStatus: "normal",
			metadataConflicts: [
				{
					field: "title",
					values: [
						{
							value: "Conflicting title",
							adapterId: "fixture",
							retrievedAt: new Date().toISOString(),
							rawRecord,
						},
					],
					resolution: "unresolved",
					selectedValue: null,
					resolvedBy: null,
					resolvedAt: null,
				},
			],
		});
		const writer = await operation("research.manuscript.failure-injection");
		let falseSuccesses = 0;

		for (const failureCase of inventory.cases) {
			let subject: { source: SourceRecord; evidence: EvidenceCard; claim: ClaimRecord } = base;
			let paperType: Parameters<typeof createManuscriptRevision>[1]["paperType"] = "literature_review";
			let content = "Evidence boundaries improve auditability [@chen2025].";
			let citationKeys = ["chen2025"];
			let evidenceIds = [base.evidence.evidenceId];
			let disclosureRequired = true;
			let approvalId: string | null = null;
			switch (failureCase.scenario) {
				case "invented_citation":
					content = "Invented citation [@invented2026].";
					citationKeys = ["invented2026"];
					break;
				case "multiple_invented_citations":
					content = "Invented citations [@inventedA; @inventedB].";
					citationKeys = ["inventedA", "inventedB"];
					break;
				case "declared_citation_missing":
					content = "The declared citation marker is absent.";
					break;
				case "core_evidence_missing":
					evidenceIds = [];
					break;
				case "core_citation_missing":
					content = "The core statement has no citation marker.";
					citationKeys = [];
					break;
				case "abstract_evidence":
					subject = abstractEvidence;
					evidenceIds = [subject.evidence.evidenceId];
					break;
				case "unsupported_claim":
					subject = unsupported;
					evidenceIds = [subject.evidence.evidenceId];
					break;
				case "unverified_source":
					subject = unverified;
					evidenceIds = [subject.evidence.evidenceId];
					break;
				case "quantitative_without_run":
					paperType = "quantitative";
					break;
				case "qualitative_without_theme":
					paperType = "qualitative";
					break;
				case "mixed_without_methods":
					paperType = "mixed_methods";
					break;
				case "causal_without_run":
					subject = causal;
					evidenceIds = [subject.evidence.evidenceId];
					paperType = "quantitative";
					break;
				case "missing_disclosure":
					disclosureRequired = false;
					break;
				case "missing_approval":
					break;
				case "retracted_source":
					subject = retracted;
					evidenceIds = [subject.evidence.evidenceId];
					break;
				case "unresolved_metadata":
					subject = conflicted;
					evidenceIds = [subject.evidence.evidenceId];
					break;
			}

			const manuscript = await createManuscriptRevision(projectRoot, {
				title: `Failure injection: ${failureCase.caseId}`,
				paperType,
				abstract: null,
				bibliography: [{ citationKey: "chen2025", sourceId: subject.source.sourceId }],
				methodRecords: [],
				sections: [
					{
						sectionKey: "findings",
						title: "Findings",
						order: 0,
						content,
						occurrences: [
							{
								claimId: subject.claim.claimId,
								text: content,
								charStart: 0,
								charEnd: content.length,
								core: true,
								citationKeys,
								evidenceIds,
							},
						],
					},
				],
				supersedesManuscriptId: null,
				authoring: { origin: "model", provider: "deepseek", modelId: "deepseek-v4-flash" },
				expectedManifestRevision: await manifestRevision(),
				operationId: writer.operationId,
			});
			if (!manuscript.ok) throw new Error(manuscript.errors[0].message);
			const manuscriptId = manuscript.value.manuscript.manuscriptId;
			if (failureCase.scenario !== "missing_approval") {
				approvalId = (await approval(writer.operationId, manuscriptId)).approvalId;
			}

			if (failureCase.scenario === "deterministic_p0" || failureCase.scenario === "model_p0") {
				const deterministic = failureCase.scenario === "deterministic_p0";
				const finding = await recordReviewFindings(
					projectRoot,
					manuscriptId,
					[
						{
							reviewerRole: "integrity",
							findingType: deterministic ? "deterministic_violation" : "evidence_based_concern",
							severity: "P0",
							title: failureCase.caseId,
							message: "Injected unresolved P0 finding.",
							sectionId: null,
							claimOccurrenceId: null,
						},
					],
					deterministic ? "deterministic" : "model",
					deterministic ? null : { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: null },
					await manifestRevision(),
					writer.operationId,
				);
				if (!finding.ok) throw new Error(finding.errors[0].message);
			}
			if (failureCase.scenario === "tampered_anchor") {
				const occurrence = manuscript.value.occurrences[0];
				if (occurrence === undefined) throw new Error("Injected manuscript has no occurrence");
				const updated = await updateRecord(projectRoot, "claim_occurrence", occurrence.claimOccurrenceId, {
					expectedManifestRevision: await manifestRevision(),
					expectedRecordRevision: 0,
					operationId: writer.operationId,
					changes: { anchorHash: hashBytes("tampered") },
				});
				if (!updated.ok) throw new Error(updated.errors[0].message);
			}
			if (failureCase.scenario === "section_drift") {
				const section = manuscript.value.sections[0];
				if (section === undefined) throw new Error("Injected manuscript has no section");
				const updated = await updateRecord(projectRoot, "section", section.sectionId, {
					expectedManifestRevision: await manifestRevision(),
					expectedRecordRevision: 0,
					operationId: writer.operationId,
					changes: { content: `X${section.content.slice(1)}` },
				});
				if (!updated.ok) throw new Error(updated.errors[0].message);
			}
			if (disclosureRequired) {
				const disclosure = await createDisclosure(projectRoot, {
					manuscriptId,
					aiUse: "DeepSeek assisted this synthetic failure-injection draft.",
					modelIds: ["deepseek-v4-flash"],
					humanResponsibilities: ["The author owns all factual decisions."],
					limitations: ["Synthetic test only."],
					unautomatedDecisions: ["Submission remains a human decision."],
					expectedManifestRevision: await manifestRevision(),
					operationId: writer.operationId,
				});
				if (!disclosure.ok) throw new Error(disclosure.errors[0].message);
			}

			const evaluated = await evaluateSubmissionGate(projectRoot, manuscriptId, approvalId);
			if (!evaluated.ok) throw new Error(evaluated.errors[0].message);
			const expected = evaluated.value.checks.find(({ code }) => code === failureCase.expectedGate);
			expect(expected, failureCase.caseId).toMatchObject({ status: failureCase.expectedStatus });
			if (evaluated.value.passed) falseSuccesses += 1;
		}
		expect(falseSuccesses).toBe(0);
	}, 15_000);
});
