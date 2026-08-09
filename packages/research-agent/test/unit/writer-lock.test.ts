// SPDX-License-Identifier: Apache-2.0

import type * as FileSystem from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openFault = vi.hoisted(() => ({
	attempts: 0,
	remaining: 0,
	lastError: null as NodeJS.ErrnoException | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FileSystem>();
	return {
		...actual,
		open: (...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> => {
			if (!String(args[0]).endsWith("writer.lock")) return actual.open(...args);
			openFault.attempts += 1;
			if (openFault.remaining === 0) return actual.open(...args);
			openFault.remaining -= 1;
			openFault.lastError = Object.assign(new Error("simulated delete-pending lock"), { code: "EPERM" });
			return Promise.reject(openFault.lastError);
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
});

afterEach(async () => {
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
});
