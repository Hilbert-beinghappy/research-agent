// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
	type AdapterProtocolBrokerRequest,
	AdapterProtocolBrokerRequestSchema,
	type AdapterProtocolError,
	type AdapterProtocolRequest,
	AdapterProtocolRequestSchema,
	type AdapterProtocolResult,
	AdapterProtocolResultSchema,
} from "@research-agent/contracts/adapter-protocol";
import { Compile } from "typebox/compile";
import { canonicalStringify } from "../contracts/canonical-json.ts";
import type { JsonValue, ResearchResult } from "../contracts/schemas.ts";
import { failureResult, successResult } from "../kernel/results.ts";

const RequestValidator = Compile(AdapterProtocolRequestSchema);
const BrokerRequestValidator = Compile(AdapterProtocolBrokerRequestSchema);
const ResultValidator = Compile(AdapterProtocolResultSchema);

export type AdapterProcessIsolation = "jsonl_process" | "strong_isolation";

export interface AdapterProcessLaunch {
	executable: string;
	args: string[];
	cwd: string;
	readRoots?: string[];
	isolation: AdapterProcessIsolation;
}

export interface AdapterBrokerReply {
	ok: boolean;
	value: JsonValue;
	error: AdapterProtocolError | null;
}

export interface RunAdapterProcessOptions {
	launch: AdapterProcessLaunch;
	request: AdapterProtocolRequest;
	broker: (request: AdapterProtocolBrokerRequest) => Promise<AdapterBrokerReply>;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
}

function sandboxString(value: string): string {
	return JSON.stringify(value);
}

async function strongLaunch(launch: AdapterProcessLaunch): Promise<{ executable: string; args: string[] }> {
	if (process.platform !== "darwin") throw new Error("Strong Adapter isolation is unavailable on this platform");
	await access("/usr/bin/sandbox-exec");
	const cwd = await realpath(launch.cwd);
	const executable = await realpath(launch.executable);
	const readRoots = await Promise.all((launch.readRoots ?? []).map((path) => realpath(path)));
	const profile = [
		"(version 1)",
		'(import "system.sb")',
		"(deny default)",
		`(allow process-exec (literal ${sandboxString(executable)}))`,
		"(allow process-info*)",
		"(allow file-read-metadata)",
		`(allow file-read* (subpath ${sandboxString(cwd)}) (subpath "/System") (subpath "/usr/lib") (subpath "/Library") (subpath ${sandboxString(dirname(executable))}) ${readRoots.map((path) => `(subpath ${sandboxString(path)})`).join(" ")})`,
		`(allow file-write* (subpath ${sandboxString(cwd)}))`,
		"(deny network*)",
	].join("\n");
	return { executable: "/usr/bin/sandbox-exec", args: ["-p", profile, executable, ...launch.args] };
}

function protocolFailure(code: string, message: string, operationId: string, details: JsonValue = null) {
	return failureResult<JsonValue>("PERMANENT_FAILURE", code, "runtime", message, operationId, details);
}

export async function runAdapterProcess(options: RunAdapterProcessOptions): Promise<ResearchResult<JsonValue>> {
	if (!RequestValidator.Check(options.request)) throw new TypeError("Adapter request does not satisfy protocol v1");
	if (!isAbsolute(options.launch.cwd)) throw new TypeError("Adapter working directory must be absolute");
	if (!isAbsolute(options.launch.executable)) throw new TypeError("Adapter executable must be absolute");
	if ((options.launch.readRoots ?? []).some((path) => !isAbsolute(path))) {
		throw new TypeError("Adapter read roots must be absolute");
	}
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
		throw new TypeError("Adapter timeout must be a positive safe integer");
	}
	if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
		throw new TypeError("Adapter output limit must be a positive safe integer");
	}
	let command: { executable: string; args: string[] };
	try {
		command =
			options.launch.isolation === "strong_isolation"
				? await strongLaunch(options.launch)
				: { executable: options.launch.executable, args: options.launch.args };
	} catch (error) {
		return failureResult(
			"PERMISSION_BLOCKED",
			"ADAPTER_ISOLATION_UNAVAILABLE",
			"permission",
			error instanceof Error ? error.message : String(error),
			options.request.messageId,
		);
	}

	return new Promise((resolve) => {
		const child = spawn(command.executable, command.args, {
			cwd: options.launch.cwd,
			env: { LANG: "C.UTF-8", PATH: dirname(options.launch.executable) },
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		let stdoutBuffer = "";
		let stderr = "";
		let outputBytes = 0;
		let result: AdapterProtocolResult | null = null;
		let settled = false;
		const finish = (value: ResearchResult<JsonValue>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolve(value);
		};
		const stop = (value: ResearchResult<JsonValue>): void => {
			child.kill("SIGTERM");
			finish(value);
		};
		const accountOutput = (value: string): boolean => {
			outputBytes += Buffer.byteLength(value);
			if (outputBytes <= options.maxOutputBytes) return true;
			stop(
				protocolFailure(
					"ADAPTER_OUTPUT_TOO_LARGE",
					"Adapter output exceeded the configured byte limit",
					options.request.messageId,
				),
			);
			return false;
		};
		const handleLine = async (line: string): Promise<void> => {
			if (settled || line.trim() === "") return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				stop(
					protocolFailure(
						"ADAPTER_PROTOCOL_INVALID",
						"Adapter emitted malformed JSONL",
						options.request.messageId,
					),
				);
				return;
			}
			if (BrokerRequestValidator.Check(parsed)) {
				const reply = await options.broker(parsed);
				if (settled) return;
				child.stdin.write(
					`${canonicalStringify({
						protocol: "pi-research-adapter-jsonl",
						version: 1,
						messageId: `${parsed.messageId}:response`,
						type: "broker_response",
						requestId: parsed.requestId,
						...reply,
					})}\n`,
				);
				return;
			}
			if (!ResultValidator.Check(parsed) || parsed.requestId !== options.request.messageId || result !== null) {
				stop(
					protocolFailure(
						"ADAPTER_PROTOCOL_INVALID",
						"Adapter emitted an invalid or duplicate result",
						options.request.messageId,
					),
				);
				return;
			}
			if (parsed.ok === (parsed.error !== null)) {
				stop(
					protocolFailure(
						"ADAPTER_PROTOCOL_INVALID",
						"Adapter result success and error fields are inconsistent",
						options.request.messageId,
					),
				);
				return;
			}
			result = parsed;
			child.stdin.end();
		};
		const drainLines = (): void => {
			for (;;) {
				const newline = stdoutBuffer.indexOf("\n");
				if (newline < 0) return;
				const line = stdoutBuffer.slice(0, newline);
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				void handleLine(line);
			}
		};
		const abort = (): void => {
			stop(
				failureResult(
					"PERMISSION_BLOCKED",
					"ADAPTER_ABORTED",
					"cancelled",
					"Adapter run was aborted",
					options.request.messageId,
				),
			);
		};
		const timer = setTimeout(() => {
			stop(
				failureResult(
					"RETRYABLE_FAILURE",
					"ADAPTER_TIMEOUT",
					"runtime",
					"Adapter process exceeded its timeout",
					options.request.messageId,
				),
			);
		}, options.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (!accountOutput(chunk)) return;
			stdoutBuffer += chunk;
			drainLines();
		});
		child.stderr.on("data", (chunk: string) => {
			if (!accountOutput(chunk)) return;
			stderr += chunk;
		});
		child.stdin.once("error", (error) => {
			finish(protocolFailure("ADAPTER_STDIN_FAILED", error.message, options.request.messageId));
		});
		child.once("error", (error) => {
			finish(protocolFailure("ADAPTER_LAUNCH_FAILED", error.message, options.request.messageId));
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			if (stdoutBuffer.trim() !== "") {
				void handleLine(stdoutBuffer).then(() => {
					if (!settled) complete(exitCode);
				});
				return;
			}
			complete(exitCode);
		});
		const complete = (exitCode: number | null): void => {
			if (settled) return;
			if (exitCode !== 0 || result === null) {
				finish(
					protocolFailure(
						"ADAPTER_CRASH",
						`Adapter exited without a valid result${stderr === "" ? "" : `: ${stderr.trim()}`}`,
						options.request.messageId,
						{ exitCode },
					),
				);
				return;
			}
			const adapterError = result.error!;
			finish(
				result.ok
					? successResult(result.value, options.request.messageId)
					: failureResult(
							adapterError.retryable ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
							adapterError.code,
							"runtime",
							adapterError.message,
							options.request.messageId,
							adapterError.details,
						),
			);
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		child.stdin.write(`${canonicalStringify(options.request)}\n`);
	});
}
