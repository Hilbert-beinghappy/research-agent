// SPDX-License-Identifier: Apache-2.0

import { type Static, Type } from "typebox";
import { DataClassSchema, MEMORY_HASH_PATTERN, MEMORY_SCHEMA_VERSION } from "./memory.ts";
import { RelativePathSchema } from "./schemas.ts";

const StrictObject = <const Properties extends Parameters<typeof Type.Object>[0]>(properties: Properties) =>
	Type.Object(properties, { additionalProperties: false });
const IdentifierSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const IsoDateTimeSchema = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
});
const Sha256Schema = Type.String({ pattern: MEMORY_HASH_PATTERN });
const NonceBase64Schema = Type.String({ pattern: "^[A-Za-z0-9+/]{16}$" });
const SaltOrTagBase64Schema = Type.String({ pattern: "^[A-Za-z0-9+/]{22}==$" });
const DekCiphertextBase64Schema = Type.String({ pattern: "^[A-Za-z0-9+/]{43}=$" });

export const MemorySnapshotManifestV1Schema = StrictObject({
	format: Type.Literal("doro-memory-snapshot"),
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	snapshotId: IdentifierSchema,
	profileId: IdentifierSchema,
	profileRevision: Type.Integer({ minimum: 0 }),
	createdAt: IsoDateTimeSchema,
	includedClasses: Type.Array(
		Type.Union([
			Type.Literal("profile"),
			Type.Literal("policy"),
			Type.Literal("signals"),
			Type.Literal("items"),
			Type.Literal("feedback"),
			Type.Literal("receipts"),
			Type.Literal("audit"),
		]),
		{ minItems: 1, uniqueItems: true },
	),
	excluded: Type.Array(
		Type.Union([
			Type.Literal("session_content"),
			Type.Literal("project_content"),
			Type.Literal("restricted_sources"),
			Type.Literal("credentials"),
			Type.Literal("keys"),
			Type.Literal("cache"),
			Type.Literal("pending_transactions"),
		]),
		{ uniqueItems: true },
	),
	files: Type.Array(
		StrictObject({
			path: RelativePathSchema,
			size: Type.Integer({ minimum: 0 }),
			plaintextHash: Sha256Schema,
			dataClass: DataClassSchema,
		}),
		{ uniqueItems: true },
	),
	rootHash: Sha256Schema,
	sourceLineage: StrictObject({ profileId: IdentifierSchema, baseRevision: Type.Integer({ minimum: 0 }) }),
});
export type MemorySnapshotManifestV1 = Static<typeof MemorySnapshotManifestV1Schema>;

export const EncryptedTransferEnvelopeV1Schema = StrictObject({
	format: Type.Literal("doro-memory-transfer"),
	version: Type.Literal(1),
	cipher: Type.Literal("AES-256-GCM"),
	kdf: StrictObject({
		name: Type.Literal("scrypt"),
		N: Type.Literal(131072),
		r: Type.Literal(8),
		p: Type.Literal(1),
		saltBase64: SaltOrTagBase64Schema,
	}),
	wrappedDek: StrictObject({
		nonceBase64: NonceBase64Schema,
		ciphertextBase64: DekCiphertextBase64Schema,
		tagBase64: SaltOrTagBase64Schema,
	}),
	encryptedManifest: StrictObject({
		nonceBase64: NonceBase64Schema,
		path: RelativePathSchema,
		ciphertextHash: Sha256Schema,
	}),
	ciphertextRootHash: Sha256Schema,
});
export type EncryptedTransferEnvelopeV1 = Static<typeof EncryptedTransferEnvelopeV1Schema>;
