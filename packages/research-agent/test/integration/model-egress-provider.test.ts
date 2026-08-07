// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarnessWithExtensions, fauxModel } from "../../../coding-agent/test/test-harness.ts";
import {
	RESEARCH_SCHEMA_VERSION,
	type ResearchProjectManifest,
	type SourceRecord,
} from "../../src/contracts/schemas.ts";
import { registerResearchTools } from "../../src/extension/tools.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { initializeProject } from "../../src/project/init.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord } from "../../src/project/records.ts";
import { commitProjectTransaction } from "../../src/project/transactions.ts";

describe("model egress provider boundary", () => {
	it("keeps restricted corpus text out of the next remote-provider request", async () => {
		const restrictedText = "RESTRICTED_ABSTRACT_MUST_NOT_REACH_PROVIDER";
		let projectRoot = "";
		const harness = await createHarnessWithExtensions({
			model: {
				...fauxModel,
				id: "remote-faux-1",
				provider: "remote-faux",
				baseUrl: "https://remote-model.invalid/v1",
			},
			responses: [
				{
					toolCalls: [
						{
							name: "research_query_corpus",
							args: {
								query: "policy",
								scope: "sources",
								filters: {},
								limit: 5,
								maxCharsPerHit: 4_000,
								cursor: null,
							},
						},
					],
				},
				"blocked safely",
			],
			extensionFactories: [
				{
					path: "<research-agent-egress>",
					factory: (pi) => {
						registerResearchTools(pi, {
							version: "2.0.1-test",
							requireProject: async () => {
								const opened = await openProject(projectRoot);
								if (opened.compatibility !== "current") throw new Error("Expected current project");
								return opened;
							},
							appendProjectLink() {},
						});
					},
				},
			],
		});
		try {
			projectRoot = join(harness.tempDir, "project");
			const initialized = await initializeProject(projectRoot, { title: "Provider capture fixture" });
			if (initialized.compatibility !== "current") throw new Error("Expected current project");
			const operationId = createOpaqueId("operation");
			const now = new Date().toISOString();
			const source: SourceRecord = {
				kind: "source",
				schemaVersion: RESEARCH_SCHEMA_VERSION,
				sourceId: createOpaqueId("source"),
				identifiers: [],
				title: "Policy interview evidence",
				titleNormalized: "policy interview evidence",
				contributors: [],
				issuedDate: null,
				containerTitle: null,
				publisher: null,
				sourceType: "document",
				language: "en",
				abstractText: restrictedText,
				abstractRights: "unknown",
				discovery: [],
				dedupKeys: {
					doi: null,
					strongIdentifier: null,
					normalizedTitleYearFirstAuthor: null,
					contentHash: null,
				},
				duplicateStatus: "canonical",
				canonicalSourceId: null,
				metadataConflicts: [],
				publicationStatus: "unknown",
				audit: {
					createdAt: now,
					updatedAt: now,
					revision: 0,
					createdByOperationId: operationId,
					updatedByOperationId: operationId,
				},
			};
			const created = await createRecord(projectRoot, source, {
				expectedManifestRevision: initialized.manifest.revision,
				operationId,
			});
			if (!created.ok) throw new Error(created.errors[0].message);
			const setPolicy = async (patch: Partial<ResearchProjectManifest["policy"]>): Promise<void> => {
				const opened = await openProject(projectRoot);
				if (opened.compatibility !== "current") throw new Error("Expected current project");
				await commitProjectTransaction(projectRoot, {
					expectedRevision: opened.manifest.revision,
					writes: [],
					manifest: {
						...opened.manifest,
						policy: { ...opened.manifest.policy, ...patch },
						revision: opened.manifest.revision + 1,
						updatedAt: new Date().toISOString(),
					},
				});
			};
			await setPolicy({ modelEgressAllowed: false });

			await harness.session.prompt("Query the active research project for policy sources.");
			expect(harness.faux.callCount).toBe(2);
			await setPolicy({ modelEgressAllowed: true, allowedModelProviders: ["approved-remote"] });
			await harness.session.prompt("Query the project again under the provider allowlist.");

			expect(harness.faux.callCount).toBe(4);
			const providerRequests = JSON.stringify(harness.faux.contexts);
			expect(providerRequests).toContain("MODEL_EGRESS_DENIED");
			expect(providerRequests).not.toContain(restrictedText);
			expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain(restrictedText);
		} finally {
			harness.cleanup();
		}
	});
});
