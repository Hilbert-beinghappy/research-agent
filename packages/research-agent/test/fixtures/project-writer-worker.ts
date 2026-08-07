// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import type { OperationRecord, ResearchProjectManifest } from "../../src/contracts/schemas.ts";
import { RESEARCH_SCHEMA_VERSION } from "../../src/contracts/schemas.ts";
import { createOpaqueId } from "../../src/kernel/identity.ts";
import { atomicWriteFile } from "../../src/project/atomic-write.ts";
import { openProject } from "../../src/project/open.ts";
import { createRecord } from "../../src/project/records.ts";
import { prepareProjectTransaction } from "../../src/project/transactions.ts";
import { withProjectWriterLease } from "../../src/project/writer-lock.ts";

function operationRecord(operationId: string, ownerOperationId: string, name: string): OperationRecord {
	const now = new Date().toISOString();
	return {
		kind: "operation",
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		operationId,
		taskId: null,
		operationKind: "tool",
		name,
		implementationVersion: "writer-stress-v1",
		status: "planned",
		session: null,
		actor: { type: "tool", id: "writer-stress" },
		modelExecution: null,
		adapterExecution: null,
		inputs: [],
		inputFiles: [],
		outputs: [],
		outputFiles: [],
		rawRequest: null,
		rawResponse: null,
		approvalIds: [],
		usage: {
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			networkRequests: 0,
			cost: { amount: 0, currency: "USD" },
		},
		error: null,
		startedAt: null,
		finishedAt: null,
		audit: {
			createdAt: now,
			updatedAt: now,
			revision: 0,
			createdByOperationId: ownerOperationId,
			updatedByOperationId: ownerOperationId,
		},
	};
}

function nextManifest(manifest: ResearchProjectManifest): ResearchProjectManifest {
	return { ...structuredClone(manifest), revision: manifest.revision + 1, updatedAt: new Date().toISOString() };
}

const [mode, projectRoot, label = "worker", rawCount = "500"] = process.argv.slice(2);
if (projectRoot === undefined) throw new TypeError("project root is required");

if (mode === "batch") {
	const count = Number(rawCount);
	if (!Number.isInteger(count) || count < 1) throw new TypeError("record count must be a positive integer");
	for (let index = 0; index < count; index += 1) {
		const operationId = createOpaqueId("operation");
		const record = operationRecord(operationId, operationId, `${label}-${index}`);
		for (;;) {
			const opened = await openProject(projectRoot);
			if (opened.compatibility !== "current") throw new Error("expected current project");
			const result = await createRecord(projectRoot, record, {
				expectedManifestRevision: opened.manifest.revision,
				operationId,
			});
			if (result.ok) break;
			if (result.status !== "DATA_CONFLICT") throw new Error(result.errors[0].message);
		}
	}
	process.stdout.write(`${JSON.stringify({ count })}\n`);
} else if (mode === "prepare-crash") {
	const opened = await openProject(projectRoot);
	if (opened.compatibility !== "current") throw new Error("expected current project");
	const transactionId = await prepareProjectTransaction(projectRoot, {
		expectedRevision: opened.manifest.revision,
		writes: [
			{ path: "notes/crash-a.txt", content: "new-a" },
			{ path: "notes/crash-b.txt", content: "new-b" },
		],
		manifest: nextManifest(opened.manifest),
	});
	await withProjectWriterLease(projectRoot, async () => {
		await atomicWriteFile(join(projectRoot, "notes", "crash-a.txt"), "new-a");
		await new Promise<void>((resolve, reject) => {
			process.stdout.write(`${JSON.stringify({ transactionId })}\n`, "utf8", (error) => {
				if (error === null || error === undefined) resolve();
				else reject(error);
			});
		});
		await new Promise<never>(() => {});
	});
} else {
	throw new TypeError(`unknown worker mode: ${mode ?? ""}`);
}
