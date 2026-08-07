// SPDX-License-Identifier: Apache-2.0

import type {
	AdapterConformanceReport,
	AdapterIsolationProfile,
	AdapterRegistrationRecord,
	ResearchResult,
} from "../contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { createOpaqueId } from "../kernel/identity.ts";
import { hashCanonicalJson } from "../kernel/integrity.ts";
import { withPersistedRunningOperation } from "../kernel/operations.ts";
import { failureResult, successResult } from "../kernel/results.ts";
import { openProject } from "../project/open.ts";
import { createRecord } from "../project/records.ts";
import { finishOperation } from "../tools/operations.ts";
import { loadAdapterPackage } from "./conformance.ts";

export interface RegisterAdapterPackageInput {
	operationId: string;
	conformance: AdapterConformanceReport;
	isolationProfile: AdapterIsolationProfile;
	status?: "active" | "legacy_trusted";
}

export async function registerAdapterPackage(
	projectRoot: string,
	packageRoot: string,
	input: RegisterAdapterPackageInput,
): Promise<ResearchResult<AdapterRegistrationRecord>> {
	const operationId = input.operationId;
	try {
		const manifest = await withPersistedRunningOperation(projectRoot, operationId, () =>
			loadAdapterPackage(packageRoot),
		);
		const status = input.status ?? "active";
		if (
			!input.conformance.passed ||
			input.conformance.packageId !== manifest.packageId ||
			input.conformance.packageVersion !== manifest.packageVersion ||
			input.conformance.packageHash.value !== manifest.packageHash.value ||
			input.conformance.manifestHash.value !== hashCanonicalJson(manifest).value ||
			input.conformance.adapterId !== manifest.adapterId ||
			input.conformance.adapterKind !== manifest.adapterKind ||
			input.conformance.checks.some(({ passed }) => !passed)
		) {
			throw new TypeError("Adapter registration requires a matching successful conformance report");
		}
		if (!manifest.isolationProfiles.includes(input.isolationProfile)) {
			throw new TypeError(`Adapter does not declare ${input.isolationProfile}`);
		}
		if (status === "active" && input.isolationProfile === "legacy_trusted") {
			throw new TypeError("Active third-party Adapters must declare a process isolation profile");
		}
		if (status === "legacy_trusted" && input.isolationProfile !== "legacy_trusted") {
			throw new TypeError("Legacy trusted registration requires an explicit legacy_trusted declaration");
		}
		const now = new Date().toISOString();
		const registration: AdapterRegistrationRecord = {
			kind: "adapter_registration",
			schemaVersion: RESEARCH_SCHEMA_VERSION,
			adapterRegistrationId: createOpaqueId("adapter_registration"),
			manifest,
			conformance: input.conformance,
			isolationProfile: input.isolationProfile,
			status,
			registeredAt: now,
			audit: {
				createdAt: now,
				updatedAt: now,
				revision: 0,
				createdByOperationId: operationId,
				updatedByOperationId: operationId,
			},
		};
		const opened = await openProject(projectRoot);
		if (opened.compatibility !== "current") throw new TypeError("Project became read-only");
		const created = await createRecord(opened.root, registration, {
			expectedManifestRevision: opened.manifest.revision,
			operationId,
		});
		if (!created.ok) throw new Error(created.errors[0].message);
		const result = successResult(registration, operationId);
		await finishOperation(projectRoot, operationId, result, [created.value]);
		return result;
	} catch (error) {
		const result = failureResult<AdapterRegistrationRecord>(
			"PERMANENT_FAILURE",
			"ADAPTER_REGISTRATION_FAILED",
			"validation",
			error instanceof Error ? error.message : String(error),
			operationId,
		);
		await finishOperation(projectRoot, operationId, result);
		return result;
	}
}
