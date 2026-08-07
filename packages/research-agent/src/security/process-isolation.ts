// SPDX-License-Identifier: Apache-2.0

import { access, realpath } from "node:fs/promises";
import { dirname } from "node:path";

export interface StrongProcessLaunch {
	executable: string;
	args: string[];
	cwd: string;
	readRoots?: string[];
}

function sandboxString(value: string): string {
	return JSON.stringify(value);
}

async function existingRealPaths(paths: readonly string[]): Promise<string[]> {
	const existing: string[] = [];
	for (const path of paths) {
		try {
			existing.push(await realpath(path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return [...new Set(existing)];
}

export async function createStrongProcessLaunch(
	launch: StrongProcessLaunch,
): Promise<{ executable: string; args: string[] }> {
	const cwd = await realpath(launch.cwd);
	const executable = await realpath(launch.executable);
	const runtimeRoot = dirname(dirname(executable));
	const readRoots = await existingRealPaths(launch.readRoots ?? []);
	if (process.platform === "darwin") {
		await access("/usr/bin/sandbox-exec");
		const profile = [
			"(version 1)",
			'(import "system.sb")',
			"(deny default)",
			`(allow process-exec (literal ${sandboxString(executable)}) (subpath ${sandboxString(runtimeRoot)}))`,
			"(allow process-info*)",
			"(allow file-read-metadata)",
			`(allow file-read* (subpath ${sandboxString(cwd)}) (subpath "/System") (subpath "/usr/lib") (subpath "/Library") (subpath ${sandboxString(runtimeRoot)}) ${readRoots.map((path) => `(subpath ${sandboxString(path)})`).join(" ")})`,
			`(allow file-write* (subpath ${sandboxString(cwd)}))`,
			"(deny network*)",
		].join("\n");
		return { executable: "/usr/bin/sandbox-exec", args: ["-p", profile, executable, ...launch.args] };
	}
	if (process.platform === "linux") {
		await access("/usr/bin/bwrap");
		const systemRoots: string[] = [];
		for (const root of [
			"/bin",
			"/etc",
			"/lib",
			"/lib64",
			"/sbin",
			"/usr",
			dirname(dirname(executable)),
			...readRoots,
		]) {
			try {
				await access(root);
				if (!systemRoots.includes(root)) systemRoots.push(root);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const args = ["--die-with-parent", "--new-session", "--unshare-net"];
		for (const root of systemRoots) args.push("--ro-bind", root, root);
		args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", cwd, cwd, "--chdir", cwd);
		return { executable: "/usr/bin/bwrap", args: [...args, executable, ...launch.args] };
	}
	throw new Error("Strong process isolation is unavailable on this platform");
}
