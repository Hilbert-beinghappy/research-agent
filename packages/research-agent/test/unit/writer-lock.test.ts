// SPDX-License-Identifier: Apache-2.0

import type * as FileSystem from "node:fs/promises";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openFault = vi.hoisted(() => ({
	attempts: 0,
	remaining: 0,
	lastError: null as NodeJS.ErrnoException | null,
	readAttempts: 0,
	readRemaining: 0,
	readLastError: null as NodeJS.ErrnoException | null,
	closeAttempts: 0,
	contention: [] as { nonce: string | null; now: number }[],
	contentionActive: false,
	contentionNonce: null as string | null,
	now: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FileSystem>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> => {
			if (!String(args[0]).endsWith("writer.lock")) return actual.open(...args);
			openFault.attempts += 1;
			if (openFault.remaining > 0) {
				openFault.remaining -= 1;
				openFault.lastError = Object.assign(new Error("simulated delete-pending lock"), { code: "EPERM" });
				throw openFault.lastError;
			}
			const contention = openFault.contention.shift();
			if (contention !== undefined) {
				openFault.now = contention.now;
				if (!openFault.contentionActive || contention.nonce !== openFault.contentionNonce) {
					await actual.rm(args[0], { force: true });
					await actual.writeFile(
						args[0],
						contention.nonce === null
							? "invalid lease\n"
							: `${JSON.stringify({
									version: 1,
									pid: process.pid,
									hostname: hostname(),
									nonce: contention.nonce,
									acquiredAt: "2100-01-01T00:00:00.000Z",
									expiresAt: "2100-01-01T00:01:00.000Z",
								})}\n`,
						{ flag: "wx" },
					);
					openFault.contentionActive = true;
					openFault.contentionNonce = contention.nonce;
				}
				throw Object.assign(new Error("simulated live writer lease"), { code: "EEXIST" });
			}
			if (openFault.contentionActive) {
				openFault.contentionActive = false;
				openFault.contentionNonce = null;
				await actual.rm(args[0], { force: true });
			}
			const handle = await actual.open(...args);
			const close = handle.close.bind(handle);
			Object.defineProperty(handle, "close", {
				configurable: true,
				value: async (): Promise<void> => {
					openFault.closeAttempts += 1;
					await close();
				},
			});
			return handle;
		},
		readFile: async (...args: Parameters<typeof actual.readFile>): ReturnType<typeof actual.readFile> => {
			if (!String(args[0]).endsWith("writer.lock")) return actual.readFile(...args);
			openFault.readAttempts += 1;
			if (openFault.readRemaining > 0) {
				openFault.readRemaining -= 1;
				openFault.readLastError = Object.assign(new Error("simulated writer lock read failure"), {
					code: "EPERM",
				});
				throw openFault.readLastError;
			}
			return actual.readFile(...args);
		},
	};
});

import { withWriterLease } from "../../src/project/writer-lock.ts";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
if (originalPlatform === undefined) throw new Error("process.platform descriptor is unavailable");

let temporaryDirectory: string;

beforeEach(async () => {
	temporaryDirectory = await mkdtemp(join(tmpdir(), "doro-writer-lock-"));
	openFault.attempts = 0;
	openFault.remaining = 0;
	openFault.lastError = null;
	openFault.readAttempts = 0;
	openFault.readRemaining = 0;
	openFault.readLastError = null;
	openFault.closeAttempts = 0;
	openFault.contention = [];
	openFault.contentionActive = false;
	openFault.contentionNonce = null;
	openFault.now = 0;
});

afterEach(async () => {
	vi.restoreAllMocks();
	Object.defineProperty(process, "platform", originalPlatform);
	await rm(temporaryDirectory, { recursive: true, force: true });
});

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { ...originalPlatform, value });
}

describe("writer lease acquisition", () => {
	it("retries a transient Windows delete-pending EPERM", async () => {
		setPlatform("win32");
		openFault.remaining = 1;

		await expect(
			withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => "acquired"),
		).resolves.toBe("acquired");
		expect(openFault.attempts).toBe(2);
	});

	it("rejects the fifth persistent Windows EPERM without running the action", async () => {
		setPlatform("win32");
		openFault.remaining = 5;
		let actionRan = false;
		let thrown: unknown = null;

		try {
			await withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => {
				actionRan = true;
			});
		} catch (error) {
			thrown = error;
		}

		expect(openFault.attempts).toBe(5);
		expect(thrown).toBe(openFault.lastError);
		expect(actionRan).toBe(false);
	});

	it("rejects a non-Windows EPERM immediately", async () => {
		setPlatform("darwin");
		openFault.remaining = 1;

		await expect(
			withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => undefined),
		).rejects.toMatchObject({ code: "EPERM" });
		expect(openFault.attempts).toBe(1);
	});

	it("retries a transient Windows EPERM while reading a contended lease", async () => {
		setPlatform("win32");
		openFault.contention = [{ nonce: "lease-a", now: 0 }];
		openFault.readRemaining = 1;

		await expect(
			withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => "acquired"),
		).resolves.toBe("acquired");
		expect(openFault.readAttempts).toBe(3);
	});

	it("rejects the fifth persistent Windows lease-read EPERM without running the action", async () => {
		setPlatform("win32");
		openFault.contention = [{ nonce: "lease-a", now: 0 }];
		openFault.readRemaining = 5;
		let actionRan = false;
		let thrown: unknown = null;

		try {
			await withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => {
				actionRan = true;
			});
		} catch (error) {
			thrown = error;
		}

		expect(openFault.readAttempts).toBe(5);
		expect(thrown).toBe(openFault.readLastError);
		expect(actionRan).toBe(false);
	});

	it("rejects a non-Windows lease-read EPERM immediately", async () => {
		setPlatform("darwin");
		openFault.contention = [{ nonce: "lease-a", now: 0 }];
		openFault.readRemaining = 1;

		await expect(
			withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => undefined),
		).rejects.toMatchObject({ code: "EPERM" });
		expect(openFault.readAttempts).toBe(1);
	});

	it("preserves a persistent Windows release-read EPERM without unlinking the lease", async () => {
		setPlatform("win32");
		let thrown: unknown = null;

		try {
			await withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => {
				openFault.readRemaining = 5;
			});
		} catch (error) {
			thrown = error;
		}

		expect(openFault.readAttempts).toBe(5);
		expect(thrown).toBe(openFault.readLastError);
		expect(openFault.closeAttempts).toBe(1);
		await expect(stat(join(temporaryDirectory, "locks/writer.lock"))).resolves.toBeDefined();
	});

	it("resets the no-progress deadline when a later valid lease has a new nonce", async () => {
		setPlatform("win32");
		openFault.readRemaining = 1;
		openFault.contention = [
			{ nonce: "lease-a", now: 29_000 },
			{ nonce: "lease-b", now: 31_000 },
			{ nonce: "lease-c", now: 60_500 },
		];
		vi.spyOn(performance, "now").mockImplementation(() => openFault.now);

		await expect(
			withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => "acquired"),
		).resolves.toBe("acquired");
		expect(openFault.attempts).toBe(4);
		expect(openFault.readAttempts).toBe(5);
	});

	it("rejects an unchanged valid lease after the original acquire deadline", async () => {
		setPlatform("win32");
		openFault.readRemaining = 1;
		openFault.contention = [
			{ nonce: "lease-a", now: 29_000 },
			{ nonce: "lease-a", now: 30_001 },
		];
		vi.spyOn(performance, "now").mockImplementation(() => openFault.now);
		let actionRan = false;

		await expect(
			withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => {
				actionRan = true;
			}),
		).rejects.toThrow("TEST_WRITER_LOCKED: another process holds the writer lease");
		expect(actionRan).toBe(false);
		expect(openFault.attempts).toBe(2);
		expect(openFault.readAttempts).toBe(3);
	});

	it("does not treat an invalid replacement lease as progress", async () => {
		openFault.contention = [
			{ nonce: "lease-a", now: 29_000 },
			{ nonce: null, now: 30_001 },
		];
		vi.spyOn(performance, "now").mockImplementation(() => openFault.now);

		await expect(
			withWriterLease(temporaryDirectory, "locks/writer.lock", "TEST", async () => undefined),
		).rejects.toThrow("TEST_WRITER_LOCKED: another process holds the writer lease");
		expect(openFault.attempts).toBe(2);
	});
});
