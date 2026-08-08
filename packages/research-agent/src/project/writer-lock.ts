// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalizeJson, canonicalStringify } from "../contracts/canonical-json.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { syncParentDirectory } from "./atomic-write.ts";
import {
	emitProjectTransactionTrace,
	type ProjectTransactionTraceContext,
	traceProjectTransactionPhase,
} from "./transaction-trace.ts";

const WRITER_LOCK = ".research/locks/writer.lock";
const LEASE_DURATION_MS = 30_000;
const RENEW_INTERVAL_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 30_000;

interface WriterLease {
	version: 1;
	pid: number;
	hostname: string;
	nonce: string;
	acquiredAt: string;
	expiresAt: string;
}

interface WriterLeaseScope {
	path: string;
	active: boolean;
	parent: WriterLeaseScope | null;
}

const writerLeaseScope = new AsyncLocalStorage<WriterLeaseScope>();

function scopeHoldsWriterLease(scope: WriterLeaseScope | undefined, path: string): boolean {
	let current = scope;
	while (current !== undefined) {
		if (current.active && current.path === path) return true;
		current = current.parent ?? undefined;
	}
	return false;
}

export async function assertProjectWriterLeaseHeld(projectRoot: string): Promise<void> {
	const path = await resolveProjectPath(projectRoot, WRITER_LOCK);
	if (!scopeHoldsWriterLease(writerLeaseScope.getStore(), path)) {
		throw new Error(
			"PROJECT_WRITER_LEASE_REQUIRED: the current async operation does not hold the project writer lease",
		);
	}
}

async function readLease(path: string): Promise<WriterLease | null> {
	try {
		const raw = canonicalizeJson(JSON.parse(await readFile(path, "utf8")));
		if (
			raw === null ||
			typeof raw !== "object" ||
			Array.isArray(raw) ||
			raw.version !== 1 ||
			typeof raw.pid !== "number" ||
			!Number.isInteger(raw.pid) ||
			raw.pid < 1 ||
			typeof raw.hostname !== "string" ||
			typeof raw.nonce !== "string" ||
			typeof raw.acquiredAt !== "string" ||
			typeof raw.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(raw.expiresAt))
		) {
			return null;
		}
		return {
			version: 1,
			pid: raw.pid,
			hostname: raw.hostname,
			nonce: raw.nonce,
			acquiredAt: raw.acquiredAt,
			expiresAt: raw.expiresAt,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
		throw error;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function reclaimLease(path: string): Promise<boolean> {
	const stalePath = `${path}.stale.${randomUUID()}`;
	try {
		await rename(path, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	await rm(stalePath, { force: true });
	await syncParentDirectory(path);
	return true;
}

export async function withProjectWriterLease<Value>(
	projectRoot: string,
	action: () => Promise<Value>,
	traceContext: ProjectTransactionTraceContext = {},
): Promise<Value> {
	await mkdir(await resolveProjectPath(projectRoot, ".research/locks"), { recursive: true });
	const path = await resolveProjectPath(projectRoot, WRITER_LOCK);
	const host = hostname();
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
	const waitStarted = performance.now();
	emitProjectTransactionTrace("writer_lease_wait", "started", traceContext);
	const parentScope = writerLeaseScope.getStore();
	if (scopeHoldsWriterLease(parentScope, path)) {
		const error = new Error(
			"PROJECT_WRITER_LOCK_REENTRANT: the current async operation already holds the project writer lease",
		);
		emitProjectTransactionTrace("writer_lease_wait", "failed", traceContext, performance.now() - waitStarted, error);
		throw error;
	}
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		while (handle === null) {
			try {
				handle = await open(path, "wx+");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const lease = await readLease(path);
				const sameHostProcessEnded = lease !== null && lease.hostname === host && !processIsAlive(lease.pid);
				const expiredRemoteLease =
					lease !== null && lease.hostname !== host && Date.parse(lease.expiresAt) <= Date.now();
				let invalidLeaseExpired = false;
				if (lease === null) {
					try {
						invalidLeaseExpired = Date.now() - (await stat(path)).mtimeMs >= LEASE_DURATION_MS;
					} catch (statError) {
						if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
						throw statError;
					}
				}
				if (sameHostProcessEnded || expiredRemoteLease || invalidLeaseExpired) {
					await reclaimLease(path);
					continue;
				}
				if (Date.now() >= deadline) {
					throw new Error("PROJECT_WRITER_LOCKED: another process holds the project writer lease");
				}
				await delay(25);
			}
		}
	} catch (error) {
		emitProjectTransactionTrace("writer_lease_wait", "failed", traceContext, performance.now() - waitStarted, error);
		throw error;
	}

	const nonce = randomUUID();
	const acquiredAt = new Date().toISOString();
	const writeLease = async (): Promise<void> => {
		const content = new TextEncoder().encode(
			`${canonicalStringify({
				version: 1,
				pid: process.pid,
				hostname: host,
				nonce,
				acquiredAt,
				expiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString(),
			})}\n`,
		);
		await handle.truncate(0);
		let offset = 0;
		while (offset < content.byteLength) {
			const { bytesWritten } = await handle.write(content, offset, content.byteLength - offset, offset);
			offset += bytesWritten;
		}
		await handle.sync();
	};

	try {
		await writeLease();
	} catch (error) {
		await handle.close();
		await unlink(path);
		emitProjectTransactionTrace("writer_lease_wait", "failed", traceContext, performance.now() - waitStarted, error);
		throw error;
	}
	emitProjectTransactionTrace("writer_lease_wait", "completed", traceContext, performance.now() - waitStarted);
	let renewal = Promise.resolve();
	let renewalError: unknown = null;
	let renewalCount = 0;
	const timer = setInterval(() => {
		renewalCount += 1;
		renewal = renewal
			.then(() => traceProjectTransactionPhase("writer_lease_renew", { ...traceContext, renewalCount }, writeLease))
			.catch((error: unknown) => {
				renewalError ??= error;
			});
	}, RENEW_INTERVAL_MS);
	timer.unref();
	const scope: WriterLeaseScope = { path, active: true, parent: parentScope ?? null };
	let outcome: { ok: true; value: Value } | { ok: false; error: unknown };
	try {
		outcome = { ok: true, value: await writerLeaseScope.run(scope, action) };
	} catch (error) {
		outcome = { ok: false, error };
	} finally {
		scope.active = false;
	}
	clearInterval(timer);
	await traceProjectTransactionPhase("writer_lease_release", { ...traceContext, renewalCount }, async () => {
		await renewal;
		const current = await readLease(path);
		await handle.close();
		if (renewalError !== null || current?.nonce !== nonce) {
			throw new Error("PROJECT_WRITER_LEASE_LOST: project writer ownership changed during the transaction", {
				cause: renewalError,
			});
		}
		await unlink(path);
		await syncParentDirectory(path);
	});
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
