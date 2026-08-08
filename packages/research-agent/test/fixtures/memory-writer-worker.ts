// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import type { MemoryCandidateDraftV1, PreferenceSignalV1 } from "@research-agent/contracts/memory";
import { canonicalStringify } from "../../src/contracts/canonical-json.ts";
import { hashCanonicalJson } from "../../src/contracts/integrity.ts";
import { MEMORY_WRITER_LOCK_PATH } from "../../src/memory/layout.ts";
import { appendMemoryRecord, openMemoryProfile } from "../../src/memory/store.ts";
import { prepareMemoryTransaction } from "../../src/memory/transactions.ts";
import { atomicWriteFile } from "../../src/project/atomic-write.ts";
import { withWriterLease } from "../../src/project/writer-lock.ts";

const [mode, profileRoot, label = "worker", countText = "0"] = process.argv.slice(2);
if (profileRoot === undefined) throw new TypeError("profile root is required");

function hash(value: unknown): `sha256:${string}` {
	return `sha256:${hashCanonicalJson(value).value}`;
}

const opened = await openMemoryProfile(profileRoot);
if (opened.mode !== "read-write") throw new Error("expected writable memory profile");

if (mode === "batch") {
	const count = Number(countText);
	for (let index = 0; index < count; index += 1) {
		const now = new Date().toISOString();
		const signal: PreferenceSignalV1 = {
			format: "doro-preference-signal",
			schemaVersion: "1.0.0",
			signalId: `${label}-${index}`,
			profileId: opened.profile.profileId,
			signalType: "explicit_statement",
			actor: "user",
			observedAt: now,
			category: "writing",
			normalizedKey: "language",
			normalizedValue: "zh-CN",
			scopeCandidate: { level: "global" },
			baseWeight: 1,
			dedupeKey: hash({ label, index }),
			dataClass: "public",
			sourceRefs: [{ kind: "session", locator: `session:${label}-${index}`, dataClass: "public" }],
			sourceContentHash: hash({ source: label, index }),
			captureMethod: { type: "deterministic", ruleVersion: "test-v1" },
			trustState: "accepted",
			rejectionCode: null,
			createdAt: now,
		};
		await appendMemoryRecord(profileRoot, signal);
	}
	process.stdout.write(`${JSON.stringify({ count })}\n`);
} else if (mode === "prepare-crash") {
	const now = new Date().toISOString();
	const candidate: MemoryCandidateDraftV1 = {
		format: "doro-memory-candidate-draft",
		schemaVersion: "1.0.0",
		candidateId: "candidate-crash",
		profileId: opened.profile.profileId,
		category: "writing",
		key: "language",
		value: "zh-CN",
		proposedScope: { level: "global" },
		sourceSignalRefs: [{ signalId: "signal-crash", contentHash: hash("signal-crash") }],
		proposedEffects: ["formatting"],
		rationaleCodes: ["explicit-user-preference"],
		generatedBy: { type: "rule", version: "test-v1", outputSchemaHash: hash("candidate-schema") },
		createdAt: now,
	};
	const content = `${canonicalStringify(candidate)}\n`;
	const prepared = await prepareMemoryTransaction(profileRoot, opened.profile.revision, (profile, transactionId) => ({
		profile: {
			...profile,
			revision: profile.revision + 1,
			updatedAt: new Date().toISOString(),
			lastTransactionId: transactionId,
		},
		writes: [{ path: "candidates/candidate-crash.json", content }],
		result: null,
	}));
	await withWriterLease(profileRoot, MEMORY_WRITER_LOCK_PATH, "MEMORY", async () => {
		await atomicWriteFile(join(profileRoot, "candidates", "candidate-crash.json"), content);
		await new Promise<void>((resolve, reject) => {
			process.stdout.write(`${JSON.stringify({ transactionId: prepared.transactionId })}\n`, "utf8", (error) => {
				if (error === null || error === undefined) resolve();
				else reject(error);
			});
		});
		await new Promise<never>(() => {});
	});
} else {
	throw new TypeError(`unknown worker mode: ${mode ?? ""}`);
}
