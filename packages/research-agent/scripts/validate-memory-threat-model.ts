// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const threatMapPath = join(packageRoot, "docs/adr/personal-memory-threat-controls.json");
const requiredThreatIds = new Set([
	"PM-001",
	"PM-002",
	"PM-003",
	"PM-004",
	"PM-005",
	"PM-006",
	"PM-007",
	"PM-008",
	"PM-009",
	"PM-010",
	"PM-011",
]);
const rootKeys = new Set(["version", "status", "targetRelease", "threats"]);
const threatKeys = new Set(["id", "severity", "owner", "threat", "controls", "machineTests", "failureVerdict"]);
const testKeys = new Set(["id", "path", "implementation"]);

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
	if (unexpected.length > 0) throw new TypeError(`${label} has unexpected keys: ${unexpected.join(", ")}`);
}

const parsed: unknown = JSON.parse(readFileSync(threatMapPath, "utf8"));
if (!object(parsed)) throw new TypeError("Personal Memory threat map must be an object");
onlyKeys(parsed, rootKeys, "Personal Memory threat map");
if (
	parsed.version !== 1 ||
	parsed.status !== "accepted_for_implementation" ||
	parsed.targetRelease !== "3.0.0-beta.1" ||
	!Array.isArray(parsed.threats)
) {
	throw new TypeError("Personal Memory threat map metadata is invalid");
}

const seenThreatIds = new Set<string>();
const seenTestIds = new Set<string>();
let implementedTests = 0;
let requiredBeforeBetaTests = 0;
for (const [threatIndex, threatValue] of parsed.threats.entries()) {
	if (!object(threatValue)) throw new TypeError(`Threat ${threatIndex} must be an object`);
	onlyKeys(threatValue, threatKeys, `Threat ${threatIndex}`);
	const id = nonEmptyString(threatValue.id, `Threat ${threatIndex} id`);
	if (!/^PM-\d{3}$/u.test(id) || seenThreatIds.has(id))
		throw new TypeError(`Threat ID is invalid or duplicated: ${id}`);
	seenThreatIds.add(id);
	if (threatValue.severity !== "high" && threatValue.severity !== "critical") {
		throw new TypeError(`Threat ${id} must be high or critical severity`);
	}
	nonEmptyString(threatValue.owner, `Threat ${id} owner`);
	nonEmptyString(threatValue.threat, `Threat ${id} description`);
	if (
		!Array.isArray(threatValue.controls) ||
		threatValue.controls.length === 0 ||
		threatValue.controls.some((control) => typeof control !== "string" || control.trim().length === 0)
	) {
		throw new TypeError(`Threat ${id} requires non-empty controls`);
	}
	if (threatValue.failureVerdict !== "NO_GO") throw new TypeError(`Threat ${id} must fail closed with NO_GO`);
	if (!Array.isArray(threatValue.machineTests) || threatValue.machineTests.length === 0) {
		throw new TypeError(`Threat ${id} requires at least one machine test`);
	}
	for (const [testIndex, testValue] of threatValue.machineTests.entries()) {
		if (!object(testValue)) throw new TypeError(`Threat ${id} machine test ${testIndex} must be an object`);
		onlyKeys(testValue, testKeys, `Threat ${id} machine test ${testIndex}`);
		const testId = nonEmptyString(testValue.id, `Threat ${id} machine test ${testIndex} id`);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(testId) || seenTestIds.has(testId)) {
			throw new TypeError(`Machine test ID is invalid or duplicated: ${testId}`);
		}
		seenTestIds.add(testId);
		const testPath = nonEmptyString(testValue.path, `Machine test ${testId} path`);
		if (!/^test\/(?:unit|integration)\/memory\/security\/[a-z0-9-]+\.test\.ts$/u.test(testPath)) {
			throw new TypeError(`Machine test ${testId} has a non-canonical path`);
		}
		if (testValue.implementation === "implemented") {
			implementedTests += 1;
			if (!existsSync(join(packageRoot, testPath)))
				throw new Error(`Implemented machine test is missing: ${testPath}`);
		} else if (testValue.implementation === "required_before_beta") {
			requiredBeforeBetaTests += 1;
		} else {
			throw new TypeError(`Machine test ${testId} has an invalid implementation state`);
		}
	}
}

const missingThreatIds = [...requiredThreatIds].filter((id) => !seenThreatIds.has(id));
const unexpectedThreatIds = [...seenThreatIds].filter((id) => !requiredThreatIds.has(id));
if (missingThreatIds.length > 0 || unexpectedThreatIds.length > 0) {
	throw new Error(
		`Personal Memory threat coverage differs: missing=${missingThreatIds.join(",") || "none"} unexpected=${unexpectedThreatIds.join(",") || "none"}`,
	);
}

process.stdout.write(
	`${JSON.stringify({
		status: "passed",
		threats: seenThreatIds.size,
		machineTests: seenTestIds.size,
		implementedTests,
		requiredBeforeBetaTests,
	})}\n`,
);
