// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AdapterProtocolMessageSchema } from "../src/adapter-protocol.ts";
import {
	AdapterCapabilitySnapshotV1Schema,
	AnalysisRuntimeRequestV1Schema,
	AnalysisRuntimeResultV1Schema,
	ArtifactAdapterRequestV1Schema,
	ArtifactAdapterResultV1Schema,
	SourceSearchPageV1Schema,
	SourceSearchRequestV1Schema,
} from "../src/adapters.ts";
import {
	MemoryCandidateDraftV1Schema,
	MemoryDeletionTombstoneV1Schema,
	MemoryFeedbackV1Schema,
	MemoryItemV1Schema,
	MemoryUseReceiptV1Schema,
	PreferenceSignalV1Schema,
	ResearcherProfileV1Schema,
} from "../src/memory.ts";
import { EncryptedTransferEnvelopeV1Schema, MemorySnapshotManifestV1Schema } from "../src/memory-transfer.ts";
import {
	AdapterPackageManifestSchema,
	CollaborationChangeSetSchema,
	ExchangeBundleManifestSchema,
	JsonResearchResultSchema,
	ModelRouteDecisionSchema,
	PersistedRecordSchema,
} from "../src/schemas.ts";
import { ResearchRpcRequestSchema, ResearchRpcResponseSchema, ResearchSdkCapabilitySchema } from "../src/sdk-rpc.ts";

const directory = fileURLToPath(new URL("../schemas/v1.5/", import.meta.url));
const v2Directory = fileURLToPath(new URL("../schemas/v2.0/", import.meta.url));
const memoryDirectory = fileURLToPath(new URL("../schemas/memory/v1.0/", import.meta.url));
const jsonSchema = "https://json-schema.org/draft/2020-12/schema";
const schemas = [
	["persisted-record", "Pi Research Agent persisted record v1.5", PersistedRecordSchema],
	["research-result", "Pi Research Agent result v1", JsonResearchResultSchema],
	["adapter-package", "Pi Research Agent adapter package v1", AdapterPackageManifestSchema],
	["adapter-protocol", "Pi Research Agent adapter JSONL protocol v1", AdapterProtocolMessageSchema],
	["adapter-capability", "Pi Research Agent adapter capability v1", AdapterCapabilitySnapshotV1Schema],
	["source-search-request", "Pi Research Agent source search request v1", SourceSearchRequestV1Schema],
	["source-search-page", "Pi Research Agent source search page v1", SourceSearchPageV1Schema],
	["analysis-runtime-request", "Pi Research Agent analysis runtime request v1", AnalysisRuntimeRequestV1Schema],
	["analysis-runtime-result", "Pi Research Agent analysis runtime result v1", AnalysisRuntimeResultV1Schema],
	["artifact-adapter-request", "Pi Research Agent artifact adapter request v1", ArtifactAdapterRequestV1Schema],
	["artifact-adapter-result", "Pi Research Agent artifact adapter result v1", ArtifactAdapterResultV1Schema],
	["exchange-bundle", "Pi Research Agent exchange bundle v1", ExchangeBundleManifestSchema],
	["collaboration-change-set", "Pi Research Agent collaboration change set v1", CollaborationChangeSetSchema],
	["model-route-decision", "Pi Research Agent model route decision v1", ModelRouteDecisionSchema],
] as const;
const memorySchemas = [
	["researcher-profile", "Doro Researcher Profile v1", ResearcherProfileV1Schema],
	["preference-signal", "Doro Preference Signal v1", PreferenceSignalV1Schema],
	["memory-candidate-draft", "Doro Memory Candidate Draft v1", MemoryCandidateDraftV1Schema],
	["memory-item", "Doro Memory Item v1", MemoryItemV1Schema],
	["memory-use-receipt", "Doro Memory Use Receipt v1", MemoryUseReceiptV1Schema],
	["memory-feedback", "Doro Memory Feedback v1", MemoryFeedbackV1Schema],
	["memory-deletion-tombstone", "Doro Memory Deletion Tombstone v1", MemoryDeletionTombstoneV1Schema],
	["memory-snapshot-manifest", "Doro Memory Snapshot Manifest v1", MemorySnapshotManifestV1Schema],
	["encrypted-transfer-envelope", "Doro Encrypted Transfer Envelope v1", EncryptedTransferEnvelopeV1Schema],
] as const;

await mkdir(directory, { recursive: true });
await mkdir(v2Directory, { recursive: true });
await mkdir(memoryDirectory, { recursive: true });
await Promise.all(
	[
		...schemas.map(([name, title, schema]) => [directory, name, title, schema] as const),
		...memorySchemas.map(([name, title, schema]) => [memoryDirectory, name, title, schema] as const),
		[v2Directory, "research-rpc-request", "Pi Research Agent RPC request v1", ResearchRpcRequestSchema] as const,
		[v2Directory, "research-rpc-response", "Pi Research Agent RPC response v1", ResearchRpcResponseSchema] as const,
		[
			v2Directory,
			"research-sdk-capabilities",
			"Pi Research Agent SDK capabilities v1",
			ResearchSdkCapabilitySchema,
		] as const,
	].map(([target, name, title, schema]) =>
		writeFile(
			`${target}${name}.schema.json`,
			`${JSON.stringify({ $schema: jsonSchema, title, ...schema }, null, 2)}\n`,
		),
	),
);
