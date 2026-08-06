// SPDX-License-Identifier: Apache-2.0

import { canonicalStringify } from "../contracts/canonical-json.ts";
import type {
	FileRef,
	HashValue,
	JsonValue,
	MetadataConflict,
	PublicationStatus,
	RecordRef,
	ResearchResult,
	SourceDiscoveryEvent,
	SourceIdentifier,
	SourceRecord,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { type DedupDecision, deduplicateCandidates } from "../literature/deduplicate.ts";
import {
	type MetadataCandidateInput,
	type NormalizedSourceCandidate,
	normalizeMetadataCandidate,
} from "../literature/normalize.ts";
import { openProject } from "../project/open.ts";
import { listProjectRecordIds } from "../project/record-index.ts";
import { createRecord, readRecord, updateRecord } from "../project/records.ts";

type JsonObject = { [key: string]: JsonValue };

export interface SourceCandidateInput extends Omit<MetadataCandidateInput, "candidateId"> {
	candidateId: string;
	sourceIdHint: string | null;
	adapterVersion: string;
	queryText: string | null;
	queryHash: HashValue | null;
	rank: number | null;
	requestOperationId: string;
	abstractRights: SourceRecord["abstractRights"];
}

export interface SourceCandidateRejection {
	candidateId: string;
	code: "BIBLIOGRAPHIC_MATCH_REQUIRED" | "INCOMPLETE_METADATA" | "RAW_RECORD_INCOMPLETE";
	message: string;
}

export interface ExistingSourceDuplicate {
	candidateId: string;
	existingSourceId: string;
	reason: "strong_identifier_conflict" | "weak_metadata_match" | "content_identifier_conflict";
}

export interface CommitSourcesValue {
	createdSourceIds: string[];
	reusedSourceIds: string[];
	candidateSources: Array<{ candidateId: string; sourceId: string }>;
	sourceRefs: RecordRef[];
	rejected: SourceCandidateRejection[];
	possibleDuplicates: DedupDecision[];
	existingSourceDuplicates: ExistingSourceDuplicate[];
}

function propagatedFailure<Value>(
	result: Extract<ResearchResult<unknown>, { ok: false }>,
	operationId: string,
): ResearchResult<Value> {
	const error = result.errors[0];
	return failureResult(result.status, error.code, error.category, error.message, operationId, error.details);
}

function completeFile(file: FileRef): boolean {
	return file.hash !== null && file.mediaType !== null && file.bytes !== null;
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string): Value[] {
	return [...new Map(values.map((value) => [key(value), value])).values()];
}

function completeness(candidate: NormalizedSourceCandidate): number {
	return (
		[
			candidate.title,
			candidate.issuedDate,
			candidate.containerTitle,
			candidate.publisher,
			candidate.sourceType,
			candidate.language,
			candidate.abstractText,
		].filter((value) => value !== null).length +
		candidate.identifiers.length +
		candidate.contributors.length
	);
}

function firstValue<Value>(
	members: readonly NormalizedSourceCandidate[],
	select: (member: NormalizedSourceCandidate) => Value | null,
): Value | null {
	for (const member of members) {
		const value = select(member);
		if (value !== null) return value;
	}
	return null;
}

function publicationStatus(members: readonly NormalizedSourceCandidate[]): PublicationStatus {
	for (const status of ["retracted", "withdrawn", "expression_of_concern", "corrected", "normal"] as const) {
		if (members.some((member) => member.publicationStatus === status)) return status;
	}
	return "unknown";
}

function discoveries(inputs: readonly SourceCandidateInput[]): SourceDiscoveryEvent[] {
	return uniqueBy(
		inputs.map((input) => ({
			adapterId: input.adapterId,
			adapterVersion: input.adapterVersion,
			queryText: input.queryText,
			queryHash: input.queryHash,
			discoveredAt: input.retrievedAt,
			rank: input.rank,
			rawRecord: input.rawRecord,
			requestOperationId: input.requestOperationId,
		})),
		(value) => canonicalStringify(value),
	);
}

function conflictsFor(candidateIds: ReadonlySet<string>, decisions: readonly DedupDecision[]): MetadataConflict[] {
	return uniqueBy(
		decisions
			.filter(({ candidateIds: pair }) => pair.some((candidateId) => candidateIds.has(candidateId)))
			.flatMap(({ metadataConflicts }) => metadataConflicts),
		(value) => canonicalStringify(value),
	);
}

function mergedCandidate(members: readonly NormalizedSourceCandidate[]): NormalizedSourceCandidate {
	const selected = [...members].sort(
		(left, right) => completeness(right) - completeness(left) || left.candidateId.localeCompare(right.candidateId),
	)[0];
	if (selected === undefined) throw new TypeError("Source candidate group is empty");
	const identifiers = uniqueBy(
		members.flatMap(({ identifiers }) => identifiers),
		(identifier) => `${identifier.scheme}:${identifier.normalizedValue}`,
	).sort(
		(left, right) =>
			left.scheme.localeCompare(right.scheme) || left.normalizedValue.localeCompare(right.normalizedValue),
	);
	return {
		...selected,
		identifiers,
		contributors:
			firstValue(members, (member) => (member.contributors.length === 0 ? null : member.contributors)) ?? [],
		issuedDate: firstValue(members, ({ issuedDate }) => issuedDate),
		publicationYear: firstValue(members, ({ publicationYear }) => publicationYear),
		containerTitle: firstValue(members, ({ containerTitle }) => containerTitle),
		publisher: firstValue(members, ({ publisher }) => publisher),
		sourceType: firstValue(members, ({ sourceType }) => sourceType),
		language: firstValue(members, ({ language }) => language),
		abstractText: firstValue(members, ({ abstractText }) => abstractText),
		publicationStatus: publicationStatus(members),
		dedupKeys: {
			doi: firstValue(members, ({ dedupKeys }) => dedupKeys.doi),
			arxiv: firstValue(members, ({ dedupKeys }) => dedupKeys.arxiv),
			isbn: firstValue(members, ({ dedupKeys }) => dedupKeys.isbn),
			strongIdentifier: firstValue(members, ({ dedupKeys }) => dedupKeys.strongIdentifier),
			normalizedTitleYearFirstAuthor: firstValue(
				members,
				({ dedupKeys }) => dedupKeys.normalizedTitleYearFirstAuthor,
			),
			contentHash: firstValue(members, ({ dedupKeys }) => dedupKeys.contentHash),
		},
	};
}

async function existingSources(projectRoot: string): Promise<SourceRecord[]> {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
	const sources: SourceRecord[] = [];
	for (const sourceId of await listProjectRecordIds(opened.root, opened.manifest, "source")) {
		const result = await readRecord(opened.root, "source", sourceId);
		if (!result.ok || result.value.kind !== "source") throw new TypeError(`Invalid source record: ${sourceId}`);
		sources.push(result.value);
	}
	return sources;
}

function exactExisting(
	candidate: NormalizedSourceCandidate,
	sources: readonly SourceRecord[],
	sourceIdHint: string | null,
): SourceRecord | null {
	return (
		sources.find(
			(source) =>
				source.sourceId === sourceIdHint &&
				(source.dedupKeys.strongIdentifier === candidate.dedupKeys.strongIdentifier ||
					source.titleNormalized === candidate.titleNormalized),
		) ??
		sources.find(
			(source) =>
				candidate.dedupKeys.strongIdentifier !== null &&
				source.dedupKeys.strongIdentifier === candidate.dedupKeys.strongIdentifier &&
				source.titleNormalized === candidate.titleNormalized,
		) ??
		sources.find(
			(source) =>
				candidate.dedupKeys.contentHash !== null &&
				source.dedupKeys.contentHash === candidate.dedupKeys.contentHash &&
				(source.dedupKeys.strongIdentifier === null ||
					candidate.dedupKeys.strongIdentifier === null ||
					source.dedupKeys.strongIdentifier === candidate.dedupKeys.strongIdentifier),
		) ??
		null
	);
}

function existingDuplicate(
	candidate: NormalizedSourceCandidate,
	sources: readonly SourceRecord[],
): ExistingSourceDuplicate | null {
	const strong = sources.find(
		(source) =>
			candidate.dedupKeys.strongIdentifier !== null &&
			source.dedupKeys.strongIdentifier === candidate.dedupKeys.strongIdentifier,
	);
	if (strong !== undefined) {
		return {
			candidateId: candidate.candidateId,
			existingSourceId: strong.sourceId,
			reason: "strong_identifier_conflict",
		};
	}
	const content = sources.find(
		(source) =>
			candidate.dedupKeys.contentHash !== null && source.dedupKeys.contentHash === candidate.dedupKeys.contentHash,
	);
	if (content !== undefined) {
		return {
			candidateId: candidate.candidateId,
			existingSourceId: content.sourceId,
			reason: "content_identifier_conflict",
		};
	}
	const weak = sources.find(
		(source) =>
			candidate.dedupKeys.normalizedTitleYearFirstAuthor !== null &&
			source.dedupKeys.normalizedTitleYearFirstAuthor === candidate.dedupKeys.normalizedTitleYearFirstAuthor,
	);
	return weak === undefined
		? null
		: {
				candidateId: candidate.candidateId,
				existingSourceId: weak.sourceId,
				reason: "weak_metadata_match",
			};
}

function mergedIdentifiers(left: readonly SourceIdentifier[], right: readonly SourceIdentifier[]): SourceIdentifier[] {
	return uniqueBy([...left, ...right], (value) => `${value.scheme}:${value.normalizedValue}`).sort(
		(a, b) => a.scheme.localeCompare(b.scheme) || a.normalizedValue.localeCompare(b.normalizedValue),
	);
}

export async function commitSourceCandidates(
	projectRoot: string,
	operationId: string,
	inputs: readonly SourceCandidateInput[],
): Promise<ResearchResult<CommitSourcesValue>> {
	try {
		const rejected: SourceCandidateRejection[] = [];
		const acceptedInputs: SourceCandidateInput[] = [];
		const normalized: NormalizedSourceCandidate[] = [];
		for (const input of inputs) {
			if (!completeFile(input.rawRecord)) {
				rejected.push({
					candidateId: input.candidateId,
					code: "RAW_RECORD_INCOMPLETE",
					message: "Source discovery requires a complete project FileRef",
				});
				continue;
			}
			const candidate = normalizeMetadataCandidate(input);
			if (candidate.requiresBibliographicMatch) {
				rejected.push({
					candidateId: input.candidateId,
					code: "BIBLIOGRAPHIC_MATCH_REQUIRED",
					message: "A local document without bibliographic metadata requires an explicit source match",
				});
				continue;
			}
			if (candidate.title === null || candidate.titleNormalized === null || candidate.sourceType === null) {
				rejected.push({
					candidateId: input.candidateId,
					code: "INCOMPLETE_METADATA",
					message: "Canonical sources require a title and source type",
				});
				continue;
			}
			acceptedInputs.push(input);
			normalized.push(candidate);
		}

		const deduplication = deduplicateCandidates(normalized);
		const byId = new Map(normalized.map((candidate) => [candidate.candidateId, candidate]));
		const inputById = new Map(acceptedInputs.map((input) => [input.candidateId, input]));
		const possibleIds = new Set(deduplication.possibleDuplicates.flatMap(({ candidateIds }) => candidateIds));
		const sources = await existingSources(projectRoot);
		const createdSourceIds: string[] = [];
		const reusedSourceIds: string[] = [];
		const sourceRefs: RecordRef[] = [];
		const candidateSources: Array<{ candidateId: string; sourceId: string }> = [];
		const existingSourceDuplicates: ExistingSourceDuplicate[] = [];

		for (const group of deduplication.automaticMergeGroups) {
			const members = group.map((candidateId) => byId.get(candidateId));
			if (members.some((candidate) => candidate === undefined))
				throw new TypeError("Deduplication group is invalid");
			const typedMembers = members as NormalizedSourceCandidate[];
			const candidate = mergedCandidate(typedMembers);
			const groupInputs = group.map((candidateId) => inputById.get(candidateId));
			if (groupInputs.some((input) => input === undefined)) throw new TypeError("Source candidate input is missing");
			const typedInputs = groupInputs as SourceCandidateInput[];
			const discovery = discoveries(typedInputs);
			const sourceIdHints = [
				...new Set(typedInputs.map(({ sourceIdHint }) => sourceIdHint).filter((id) => id !== null)),
			];
			if (sourceIdHints.length > 1)
				throw new TypeError("Merged source candidates contain conflicting source ID hints");
			const exact = exactExisting(candidate, sources, sourceIdHints[0] ?? null);
			if (exact !== null) {
				let storedExact = exact;
				const nextDiscovery = uniqueBy([...exact.discovery, ...discovery], (value) => canonicalStringify(value));
				const nextIdentifiers = mergedIdentifiers(exact.identifiers, candidate.identifiers);
				const nextPublicationStatus = publicationStatus([
					candidate,
					{ ...candidate, publicationStatus: exact.publicationStatus },
				]);
				if (
					nextDiscovery.length !== exact.discovery.length ||
					nextIdentifiers.length !== exact.identifiers.length ||
					nextPublicationStatus !== exact.publicationStatus
				) {
					const opened = await openProject(projectRoot);
					if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
					const updated = await updateRecord(projectRoot, "source", exact.sourceId, {
						expectedManifestRevision: opened.manifest.revision,
						expectedRecordRevision: exact.audit.revision,
						operationId,
						changes: {
							identifiers: nextIdentifiers,
							discovery: nextDiscovery,
							publicationStatus: nextPublicationStatus,
						},
					});
					if (!updated.ok) return propagatedFailure(updated, operationId);
					const readBack = await readRecord(projectRoot, "source", exact.sourceId);
					if (!readBack.ok || readBack.value.kind !== "source") {
						throw new TypeError(`Updated source is invalid: ${exact.sourceId}`);
					}
					storedExact = readBack.value;
					sources.splice(sources.indexOf(exact), 1, storedExact);
				}
				reusedSourceIds.push(exact.sourceId);
				candidateSources.push(...group.map((candidateId) => ({ candidateId, sourceId: exact.sourceId })));
				sourceRefs.push({ kind: "source", id: exact.sourceId, revision: storedExact.audit.revision });
				continue;
			}

			const duplicate = existingDuplicate(candidate, sources);
			if (duplicate !== null) existingSourceDuplicates.push(duplicate);
			const sourceId = createOpaqueId("source");
			const now = new Date().toISOString();
			const source: SourceRecord = {
				kind: "source",
				schemaVersion: RESEARCH_SCHEMA_VERSION,
				sourceId,
				identifiers: candidate.identifiers,
				title: candidate.title!,
				titleNormalized: candidate.titleNormalized!,
				contributors: candidate.contributors,
				issuedDate: candidate.issuedDate,
				containerTitle: candidate.containerTitle,
				publisher: candidate.publisher,
				sourceType: candidate.sourceType!,
				language: candidate.language,
				abstractText: candidate.abstractText,
				abstractRights: typedInputs.some(({ abstractRights }) => abstractRights === "display_allowed")
					? "display_allowed"
					: typedInputs[0]!.abstractRights,
				discovery,
				dedupKeys: {
					doi: candidate.dedupKeys.doi,
					strongIdentifier: candidate.dedupKeys.strongIdentifier,
					normalizedTitleYearFirstAuthor: candidate.dedupKeys.normalizedTitleYearFirstAuthor,
					contentHash: candidate.dedupKeys.contentHash,
				},
				duplicateStatus:
					duplicate !== null || group.some((candidateId) => possibleIds.has(candidateId))
						? "possible_duplicate"
						: "canonical",
				canonicalSourceId: null,
				metadataConflicts: conflictsFor(new Set(group), deduplication.decisions),
				publicationStatus: candidate.publicationStatus,
				audit: {
					createdAt: now,
					updatedAt: now,
					revision: 0,
					createdByOperationId: operationId,
					updatedByOperationId: operationId,
				},
			};
			const opened = await openProject(projectRoot);
			if (opened.compatibility !== "current") throw new TypeError("Research project schema is read-only");
			const created = await createRecord(projectRoot, source, {
				expectedManifestRevision: opened.manifest.revision,
				operationId,
			});
			if (!created.ok) return propagatedFailure(created, operationId);
			sources.push(source);
			createdSourceIds.push(sourceId);
			candidateSources.push(...group.map((candidateId) => ({ candidateId, sourceId })));
			sourceRefs.push({ kind: "source", id: sourceId, revision: 0 });
		}

		return successResult(
			{
				createdSourceIds,
				reusedSourceIds: [...new Set(reusedSourceIds)],
				candidateSources,
				sourceRefs: uniqueBy(sourceRefs, (ref) => `${ref.kind}:${ref.id}:${ref.revision}`),
				rejected,
				possibleDuplicates: deduplication.possibleDuplicates,
				existingSourceDuplicates,
			},
			operationId,
		);
	} catch (error) {
		return failureResult(
			"PERMANENT_FAILURE",
			"SOURCE_COMMIT_FAILED",
			"runtime",
			error instanceof Error ? error.message : "Source candidates could not be committed",
			operationId,
		);
	}
}

export function metadataObject(value: JsonValue): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
