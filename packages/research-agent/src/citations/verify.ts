// SPDX-License-Identifier: Apache-2.0

import type {
	CitationFieldCheck,
	CitationVerification,
	ContributorName,
	FileRef,
	JsonValue,
	MetadataConflict,
	PublicationStatus,
	ResearchResult,
	SourceRecord,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { type NormalizedSourceCandidate, normalizeMetadataCandidate, normalizeTitle } from "../literature/normalize.ts";

export const CITATION_VERIFIER_VERSION = "0.1.0";
const VERIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type JsonObject = { [key: string]: JsonValue };
export type CitationCheckKind = "lookup" | "publication_status";

export interface CitationMatchThresholds {
	title: number;
	author: number;
	yearTolerance: number;
}

export interface CitationCheckEvidence {
	adapterId: "crossref" | "openalex";
	adapterVersion: string;
	operationId: string;
	checkedAt: string;
	check: CitationCheckKind;
	rawRecord: FileRef | null;
	result: ResearchResult<JsonValue>;
}

export interface BuildCitationVerificationInput {
	source: SourceRecord;
	citationKey: string | null;
	checks: CitationCheckEvidence[];
	matchThresholds: CitationMatchThresholds;
	operationId: string;
	verifiedAt: string;
}

function objectValue(value: JsonValue, label: string): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value;
}

function completeFile(file: FileRef | null): file is FileRef {
	return file !== null && file.hash !== null && file.mediaType !== null && file.bytes !== null;
}

function validateThresholds(thresholds: CitationMatchThresholds): void {
	for (const [name, value] of [
		["title", thresholds.title],
		["author", thresholds.author],
	] as const) {
		if (!Number.isFinite(value) || value < 0 || value > 1)
			throw new TypeError(`${name} threshold must be from 0 to 1`);
	}
	if (!Number.isInteger(thresholds.yearTolerance) || thresholds.yearTolerance < 0) {
		throw new TypeError("yearTolerance must be a non-negative integer");
	}
}

function grams(value: string): string[] {
	const characters = [...normalizeTitle(value).replace(/\s/gu, "")];
	if (characters.length < 2) return characters;
	return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
}

function similarity(left: string, right: string): number {
	const normalizedLeft = normalizeTitle(left);
	const normalizedRight = normalizeTitle(right);
	if (normalizedLeft === normalizedRight) return 1;
	const leftGrams = grams(left);
	const rightGrams = grams(right);
	if (leftGrams.length === 0 || rightGrams.length === 0) return 0;
	const remaining = new Map<string, number>();
	for (const gram of rightGrams) remaining.set(gram, (remaining.get(gram) ?? 0) + 1);
	let overlap = 0;
	for (const gram of leftGrams) {
		const count = remaining.get(gram) ?? 0;
		if (count === 0) continue;
		overlap += 1;
		remaining.set(gram, count - 1);
	}
	return (2 * overlap) / (leftGrams.length + rightGrams.length);
}

function contributorText(contributor: ContributorName): string {
	return (
		contributor.literal ??
		[contributor.given, contributor.family].filter((value): value is string => value !== null).join(" ")
	).trim();
}

function textStatus(expected: string, observed: string | null, threshold: number): CitationFieldCheck["status"] {
	if (observed === null) return "missing";
	const score = similarity(expected, observed);
	return score === 1 ? "match" : score >= threshold ? "near_match" : "conflict";
}

function supportedIdentifierSchemes(adapterId: CitationCheckEvidence["adapterId"]): Set<string> {
	return new Set(adapterId === "crossref" ? ["doi"] : ["doi", "openalex"]);
}

function fieldChecks(
	source: SourceRecord,
	candidate: NormalizedSourceCandidate,
	thresholds: CitationMatchThresholds,
): CitationFieldCheck[] {
	const checks: CitationFieldCheck[] = [];
	const adapterId = candidate.adapterId;
	if (adapterId !== "crossref" && adapterId !== "openalex") throw new TypeError("Citation adapter is unsupported");
	const schemes = supportedIdentifierSchemes(adapterId);
	const expectedIdentifiers = source.identifiers
		.filter(({ scheme }) => schemes.has(scheme))
		.map(({ scheme, normalizedValue }) => `${scheme}:${normalizedValue}`)
		.sort();
	const observedIdentifiers = candidate.identifiers
		.filter(({ scheme }) => schemes.has(scheme))
		.map(({ scheme, normalizedValue }) => `${scheme}:${normalizedValue}`)
		.sort();
	if (expectedIdentifiers.length > 0) {
		checks.push({
			field: "identifier",
			expected: expectedIdentifiers,
			observed: observedIdentifiers,
			status:
				observedIdentifiers.length === 0
					? "missing"
					: expectedIdentifiers.some((value) => observedIdentifiers.includes(value))
						? "match"
						: "conflict",
			sourceAdapterId: candidate.adapterId,
		});
	}
	checks.push({
		field: "title",
		expected: source.title,
		observed: candidate.title,
		status: textStatus(source.title, candidate.title, thresholds.title),
		sourceAdapterId: candidate.adapterId,
	});
	const expectedAuthors = source.contributors.map(contributorText).filter(Boolean);
	if (expectedAuthors.length > 0) {
		const observedAuthors = candidate.contributors.map(contributorText).filter(Boolean);
		checks.push({
			field: "authors",
			expected: expectedAuthors,
			observed: observedAuthors,
			status:
				observedAuthors.length === 0
					? "missing"
					: textStatus(expectedAuthors.join("; "), observedAuthors.join("; "), thresholds.author),
			sourceAdapterId: candidate.adapterId,
		});
	}
	const expectedYear = source.issuedDate === null ? null : Number(source.issuedDate.slice(0, 4));
	if (typeof expectedYear === "number" && Number.isInteger(expectedYear)) {
		const observedYear = candidate.publicationYear;
		checks.push({
			field: "year",
			expected: expectedYear,
			observed: observedYear,
			status:
				observedYear === null
					? "missing"
					: observedYear === expectedYear
						? "match"
						: Math.abs(observedYear - expectedYear) <= thresholds.yearTolerance
							? "near_match"
							: "conflict",
			sourceAdapterId: candidate.adapterId,
		});
	}
	if (source.containerTitle !== null) {
		checks.push({
			field: "container",
			expected: source.containerTitle,
			observed: candidate.containerTitle,
			status:
				candidate.containerTitle === null
					? "missing"
					: normalizeTitle(source.containerTitle) === normalizeTitle(candidate.containerTitle)
						? "match"
						: "conflict",
			sourceAdapterId: candidate.adapterId,
		});
	}
	return checks;
}

function normalizedCandidate(check: CitationCheckEvidence): NormalizedSourceCandidate | null {
	if (check.check !== "lookup" || !check.result.ok) return null;
	if (!completeFile(check.rawRecord)) throw new TypeError("Successful citation lookup requires a complete raw record");
	const value = objectValue(check.result.value, `${check.adapterId} lookup result`);
	return normalizeMetadataCandidate({
		candidateId: `${check.adapterId}:${check.operationId}`,
		adapterId: check.adapterId,
		retrievedAt: check.checkedAt,
		rawRecord: check.rawRecord,
		metadata: objectValue(value.candidate ?? null, `${check.adapterId} lookup candidate`),
		documentContentHash: null,
		requiresBibliographicMatch: true,
	});
}

function checkedPublicationStatus(check: CitationCheckEvidence): PublicationStatus | null {
	if (!check.result.ok) return null;
	if (check.check === "lookup") {
		if (check.adapterId !== "openalex") return null;
		const value = objectValue(check.result.value, "OpenAlex lookup result");
		const candidate = objectValue(value.candidate ?? null, "OpenAlex lookup candidate");
		return publicationStatusValue(candidate.publicationStatus);
	}
	const value = objectValue(check.result.value, `${check.adapterId} publication status result`);
	return publicationStatusValue(value.publicationStatus);
}

function publicationStatusValue(value: JsonValue | undefined): PublicationStatus {
	if (
		value === "normal" ||
		value === "corrected" ||
		value === "retracted" ||
		value === "expression_of_concern" ||
		value === "withdrawn" ||
		value === "unknown"
	) {
		return value;
	}
	throw new TypeError("Citation publication status is invalid");
}

function statusResult(checks: CitationCheckEvidence[]): {
	publicationStatus: PublicationStatus;
	conflicts: MetadataConflict[];
	hasCheck: boolean;
} {
	const values = checks.flatMap((check) => {
		const status = checkedPublicationStatus(check);
		return status === null || !completeFile(check.rawRecord) ? [] : [{ check, status, rawRecord: check.rawRecord }];
	});
	const known = values.filter(({ status }) => status !== "unknown");
	const distinct = new Set(known.map(({ status }) => status));
	const priority: PublicationStatus[] = ["retracted", "withdrawn", "expression_of_concern", "corrected", "normal"];
	const publicationStatus = priority.find((status) => distinct.has(status)) ?? "unknown";
	return {
		publicationStatus,
		hasCheck: values.length > 0,
		conflicts:
			distinct.size < 2
				? []
				: [
						{
							field: "publicationStatus",
							values: known.map(({ check, status, rawRecord }) => ({
								value: status,
								adapterId: check.adapterId,
								retrievedAt: check.checkedAt,
								rawRecord,
							})),
							resolution: "unresolved",
							selectedValue: null,
							resolvedBy: null,
							resolvedAt: null,
						},
					],
	};
}

function serviceFailure(check: CitationCheckEvidence): boolean {
	return (
		!check.result.ok &&
		(check.result.status === "RETRYABLE_FAILURE" ||
			check.result.status === "EXTERNAL_SERVICE_FAILURE" ||
			check.result.errors.some(({ category }) => ["network", "external_service", "rate_limit"].includes(category)))
	);
}

function notFound(check: CitationCheckEvidence): boolean {
	return !check.result.ok && check.result.errors.some(({ category }) => category === "not_found");
}

function dataConflict(check: CitationCheckEvidence): boolean {
	return !check.result.ok && check.result.status === "DATA_CONFLICT";
}

export function buildCitationVerification(input: BuildCitationVerificationInput): CitationVerification {
	validateThresholds(input.matchThresholds);
	if (input.checks.length === 0) throw new TypeError("Citation verification requires at least one provider check");
	if (!Number.isFinite(Date.parse(input.verifiedAt))) throw new TypeError("Citation verifiedAt is invalid");
	const operationIds = new Set<string>();
	for (const check of input.checks) {
		if (operationIds.has(check.operationId)) throw new TypeError("Citation provider operation IDs must be unique");
		operationIds.add(check.operationId);
		if (check.result.meta.operationId !== check.operationId) {
			throw new TypeError("Citation provider result operation ID does not match its evidence");
		}
	}
	const orderedChecks = [...input.checks].sort(
		(left, right) =>
			left.adapterId.localeCompare(right.adapterId) ||
			left.check.localeCompare(right.check) ||
			(left.rawRecord?.hash?.value ?? "").localeCompare(right.rawRecord?.hash?.value ?? "") ||
			left.operationId.localeCompare(right.operationId),
	);
	const verificationId = createOpaqueId("citation_verification");
	const candidates = orderedChecks.flatMap((check) => {
		const candidate = normalizedCandidate(check);
		return candidate === null ? [] : [candidate];
	});
	const checks = candidates.flatMap((candidate) => fieldChecks(input.source, candidate, input.matchThresholds));
	const verifiedIdentifierKeys = new Set(
		candidates.flatMap((candidate) =>
			candidate.identifiers.map(({ scheme, normalizedValue }) => `${scheme}:${normalizedValue}`),
		),
	);
	const identifiers = input.source.identifiers.map((identifier) => {
		const verified = verifiedIdentifierKeys.has(`${identifier.scheme}:${identifier.normalizedValue}`);
		return { ...identifier, verified, verificationId: verified ? verificationId : null };
	});
	const status = statusResult(orderedChecks);
	const lookupChecks = orderedChecks.filter(({ check }) => check === "lookup");
	const hasServiceFailure = lookupChecks.some(serviceFailure);
	const hasNotFound = lookupChecks.some(notFound);
	const hasOtherFailure = lookupChecks.some((check) => !check.result.ok && !serviceFailure(check) && !notFound(check));
	let finalStatus: CitationVerification["finalStatus"];
	if (candidates.length === 0) {
		finalStatus = orderedChecks.some(dataConflict)
			? "conflict"
			: hasServiceFailure
				? "service_unavailable"
				: hasNotFound && !hasOtherFailure
					? "not_found"
					: "incomplete";
	} else if (
		checks.some(({ status }) => status === "conflict") ||
		status.conflicts.length > 0 ||
		orderedChecks.some(dataConflict)
	) {
		finalStatus = "conflict";
	} else if (!identifiers.some(({ verified }) => verified) || checks.length === 0) {
		finalStatus = "incomplete";
	} else {
		const warning =
			checks.some(({ status }) => status !== "match") ||
			orderedChecks.some(({ result }) => !result.ok || result.status === "PARTIAL_SUCCESS") ||
			!status.hasCheck ||
			status.publicationStatus !== "normal";
		finalStatus = warning ? "verified_with_warning" : "verified";
	}
	const expiresAt = new Date(Date.parse(input.verifiedAt) + VERIFICATION_TTL_MS).toISOString();
	return {
		kind: "citation_verification",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		verificationId,
		sourceId: input.source.sourceId,
		citationKey: input.citationKey,
		identifiers,
		verificationSources: orderedChecks
			.flatMap((check) =>
				completeFile(check.rawRecord)
					? [
							{
								adapterId: check.adapterId,
								adapterVersion: check.adapterVersion,
								checkedAt: check.checkedAt,
								rawRecord: check.rawRecord,
								operationId: check.operationId,
							},
						]
					: [],
			)
			.sort(
				(left, right) =>
					left.adapterId.localeCompare(right.adapterId) ||
					(left.rawRecord.hash?.value ?? "").localeCompare(right.rawRecord.hash?.value ?? "") ||
					left.operationId.localeCompare(right.operationId),
			),
		fieldChecks: checks,
		publicationStatus: status.publicationStatus,
		conflicts: status.conflicts,
		finalStatus,
		verifiedAt: input.verifiedAt,
		expiresAt,
		audit: {
			createdAt: input.verifiedAt,
			updatedAt: input.verifiedAt,
			revision: 0,
			createdByOperationId: input.operationId,
			updatedByOperationId: input.operationId,
		},
	};
}

export function citationVerificationFingerprint(record: CitationVerification) {
	return hashCanonicalJson({
		sourceId: record.sourceId,
		citationKey: record.citationKey,
		identifiers: record.identifiers.map(({ scheme, normalizedValue, verified }) => ({
			scheme,
			normalizedValue,
			verified,
		})),
		verificationSources: record.verificationSources.map(({ adapterId, adapterVersion, rawRecord }) => ({
			adapterId,
			adapterVersion,
			rawHash: rawRecord.hash,
		})),
		fieldChecks: record.fieldChecks,
		publicationStatus: record.publicationStatus,
		conflicts: record.conflicts.map((conflict) => ({
			field: conflict.field,
			values: conflict.values.map(({ value, adapterId, rawRecord }) => ({
				value,
				adapterId,
				rawHash: rawRecord.hash,
			})),
			resolution: conflict.resolution,
			selectedValue: conflict.selectedValue,
		})),
		finalStatus: record.finalStatus,
	});
}
