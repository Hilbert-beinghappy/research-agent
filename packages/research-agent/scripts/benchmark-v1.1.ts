// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { accessPolicySnapshot, evaluateAuthorizedSourceAccess } from "../src/access/policy.ts";
import type { DomainPackageManifest } from "../src/contracts/schemas.ts";
import { resolveDomainResources } from "../src/domain/packages.ts";

function p95(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const value = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	if (value === undefined) throw new Error("Benchmark produced no measurements");
	return Number(value.toFixed(3));
}

const ruleCount = 10_000;
const decisionCount = 10_000;
const domainPackage: DomainPackageManifest = {
	format: "pi-research-domain-package",
	manifestVersion: 1,
	packageId: "pi-research-domain-benchmark",
	packageVersion: "1.1.0",
	displayName: "Benchmark",
	domainId: "benchmark",
	domainLabel: "Benchmark",
	languages: ["en"],
	licenseExpression: "Apache-2.0",
	resources: Array.from({ length: ruleCount }, (_, index) => ({
		ruleId: `rule-${index}`,
		resourceType: "search_synonym",
		key: `term-${index}`,
		value: [`term ${index}`],
		precedence: 100,
		provenance: {
			origin: "maintainer_authored",
			sourceTitle: "Synthetic benchmark rule",
			sourceUrl: null,
			licenseExpression: "Apache-2.0",
			reviewedAt: "2026-08-07",
		},
	})),
};
const policy = accessPolicySnapshot("benchmark", "1.1.0", "2026-08-07T00:00:00.000Z", "official_api");
const request = {
	action: "metadata" as const,
	entitlementState: "active" as const,
	requestsUsed: 0,
	itemsUsed: 0,
	bytesUsed: 0,
	requestedItems: 1,
	requestedBytes: 1,
};

const resolutionMeasurementsMs: number[] = [];
const accessMeasurementsMs: number[] = [];
for (let sample = 0; sample < 20; sample += 1) {
	let started = performance.now();
	if (resolveDomainResources([domainPackage]).length !== ruleCount)
		throw new Error("Domain rule resolution lost data");
	resolutionMeasurementsMs.push(performance.now() - started);

	started = performance.now();
	for (let index = 0; index < decisionCount; index += 1) {
		if (evaluateAuthorizedSourceAccess(policy, request).status !== "allowed") {
			throw new Error("Authorized source access changed during benchmark");
		}
	}
	accessMeasurementsMs.push(performance.now() - started);
}

const thresholdMs = 2_000;
const domainResolutionP95Ms = p95(resolutionMeasurementsMs);
const accessPolicyP95Ms = p95(accessMeasurementsMs);
const report = {
	benchmark: "pi-research-agent-v1.1",
	generatedAt: new Date().toISOString(),
	schemaVersion: "1.1.0",
	platform: `${process.platform}-${process.arch}`,
	node: process.version,
	fixture: { domainRules: ruleCount, accessDecisions: decisionCount },
	results: {
		domainResolution: {
			samples: resolutionMeasurementsMs.length,
			measurementsMs: resolutionMeasurementsMs.map((value) => Number(value.toFixed(3))),
			p95Ms: domainResolutionP95Ms,
			thresholdMs,
			passed: domainResolutionP95Ms < thresholdMs,
		},
		accessPolicy: {
			samples: accessMeasurementsMs.length,
			measurementsMs: accessMeasurementsMs.map((value) => Number(value.toFixed(3))),
			p95Ms: accessPolicyP95Ms,
			thresholdMs,
			passed: accessPolicyP95Ms < thresholdMs,
		},
	},
	usage: { modelCalls: 0, apiRequests: 0, modelCostUsd: 0, apiCostUsd: 0 },
};
const passed = report.results.domainResolution.passed && report.results.accessPolicy.passed;
const output = `${JSON.stringify({ ...report, status: passed ? "passed" : "failed" }, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
	const outputPath = process.argv[outputIndex + 1];
	if (outputPath === undefined) throw new TypeError("--output requires a path");
	const absolutePath = resolve(process.cwd(), outputPath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, output);
}
process.stdout.write(output);
if (!passed) process.exitCode = 1;
