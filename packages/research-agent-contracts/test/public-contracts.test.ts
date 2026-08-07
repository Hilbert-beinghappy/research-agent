// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
	AdapterPackageManifestSchema,
	CollaborationChangeSetSchema,
	ExchangeBundleManifestSchema,
	hashCanonicalJson,
	ModelRouteDecisionSchema,
	RESEARCH_SCHEMA_VERSION,
	validatePersistedRecord,
} from "../src/index.ts";

describe("public contracts", () => {
	it("exports the frozen v1.5 contract surface", () => {
		expect(RESEARCH_SCHEMA_VERSION).toBe("1.5.0");
		expect(AdapterPackageManifestSchema).toBeDefined();
		expect(CollaborationChangeSetSchema).toBeDefined();
		expect(ExchangeBundleManifestSchema).toBeDefined();
		expect(ModelRouteDecisionSchema).toBeDefined();
	});

	it("rejects an Adapter registration whose conformance identity was replaced", () => {
		const manifest = {
			format: "pi-research-adapter-package" as const,
			manifestVersion: 1 as const,
			contractVersion: 1 as const,
			packageId: "example-source",
			packageVersion: "1.0.0",
			adapterId: "example-source",
			adapterVersion: "1.0.0",
			adapterKind: "source" as const,
			entrypoint: "entry.mjs",
			capabilities: [{ capability: "search", required: true, constraints: null }],
			requiredBrokers: [],
			isolationProfiles: ["strong_isolation" as const],
			licenseExpression: "Apache-2.0",
			provenance: { source: "public fixture", repositoryUrl: null },
			packageHash: { algorithm: "sha256" as const, value: "a".repeat(64) },
			sbomPath: null,
			sbomHash: null,
		};
		const now = "2026-08-07T00:00:00.000Z";
		const registration = {
			kind: "adapter_registration" as const,
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			adapterRegistrationId: "adapter_registration_fixture",
			manifest,
			conformance: {
				format: "pi-research-adapter-conformance" as const,
				version: 1 as const,
				packageId: manifest.packageId,
				packageVersion: manifest.packageVersion,
				packageHash: manifest.packageHash,
				manifestHash: hashCanonicalJson(manifest),
				adapterId: manifest.adapterId,
				adapterKind: manifest.adapterKind,
				passed: true,
				checks: [{ name: "search", passed: true, message: "passed" }],
			},
			isolationProfile: "strong_isolation" as const,
			status: "active" as const,
			registeredAt: now,
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: "operation_fixture",
				updatedByOperationId: "operation_fixture",
			},
		};
		expect(validatePersistedRecord(registration).ok).toBe(true);
		expect(
			validatePersistedRecord({
				...registration,
				conformance: {
					...registration.conformance,
					manifestHash: { algorithm: "sha256", value: "0".repeat(64) },
				},
			}),
		).toMatchObject({
			ok: false,
			issues: [{ code: "adapter_registration.conformance_mismatch" }],
		});
	});
});
