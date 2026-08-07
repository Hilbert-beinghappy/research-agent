// SPDX-License-Identifier: Apache-2.0

import { stat } from "node:fs/promises";
import type { JsonValue, RecordKind } from "../contracts/schemas.ts";
import { RESEARCH_MIGRATABLE_SCHEMA_VERSIONS, RESEARCH_SCHEMA_VERSION } from "../contracts/schemas.ts";
import { BUILT_IN_DOMAIN_PACKAGE_IDS, loadDomainPackageById } from "../domain/packages.ts";
import { resolveProjectPath } from "../kernel/paths.ts";
import { listPendingProjectMigrations, listStagedProjectMigrations } from "./migrate.ts";
import { openProject } from "./open.ts";
import { listProjectRecordIds } from "./record-index.ts";
import { readRecord } from "./records.ts";
import { listPendingProjectTransactions } from "./transactions.ts";
import { validateProject } from "./validate.ts";

export type ProjectDoctorCategory =
	| "schema"
	| "hash"
	| "missing_file"
	| "pending_transaction"
	| "pending_migration"
	| "adapter_absence"
	| "domain_package_absence"
	| "external_drift"
	| "integrity";

export interface ProjectDoctorIssue {
	code: string;
	category: ProjectDoctorCategory;
	severity: "attention" | "blocked";
	path: string;
	message: string;
}

export interface ProjectRepairAction {
	issueCode: string;
	action: string;
	automatic: false;
}

export interface ProjectDoctorReport {
	format: "pi-research-project-doctor";
	version: 1;
	status: "healthy" | "attention" | "blocked";
	projectId: string | null;
	schemaVersion: string | null;
	revision: number | null;
	issues: ProjectDoctorIssue[];
	repairPlan: ProjectRepairAction[];
}

const MIGRATABLE = new Set<string>(RESEARCH_MIGRATABLE_SCHEMA_VERSIONS);
const DEFAULT_ADAPTERS = new Set([
	"crossref",
	"openalex",
	"unpaywall",
	"local-import",
	"native-artifact",
	"zotero-api",
	"python",
	"r",
	"stata",
]);

async function migrationLockPresent(projectRoot: string): Promise<boolean> {
	try {
		await stat(await resolveProjectPath(projectRoot, ".research/locks/migration.lock"));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function rawIdentity(value: JsonValue): { projectId: string | null; revision: number | null } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { projectId: null, revision: null };
	return {
		projectId: typeof value.projectId === "string" ? value.projectId : null,
		revision: typeof value.revision === "number" ? value.revision : null,
	};
}

function categoryForValidationCode(code: string): ProjectDoctorCategory {
	if (code.includes("HASH") || code.includes("INTEGRITY")) return "hash";
	if (code.includes("MISSING") || code.includes("NOT_FOUND") || code.includes("OUTPUT")) return "missing_file";
	if (code === "PENDING_TRANSACTION") return "pending_transaction";
	return "integrity";
}

function repairAction(issue: ProjectDoctorIssue): ProjectRepairAction {
	let action = "Resolve the reported project conflict manually, then rerun /research-doctor";
	if (issue.category === "schema") action = `Run /research-migrate after creating a verified backup`;
	if (issue.category === "pending_transaction")
		action = "Use /research-recover to commit or roll back the pending transaction";
	if (issue.category === "pending_migration")
		action = "Resume /research-migrate or inspect the staged migration journal";
	if (issue.category === "adapter_absence") action = "Install or enable the named adapter, or disable its profile";
	if (issue.category === "domain_package_absence")
		action = "Install the referenced domain package or continue with generic research guidance";
	if (issue.category === "external_drift")
		action = "Run the adapter reconciliation task; do not rewrite canonical records from external state";
	if (issue.category === "missing_file")
		action = "Restore the exact file from a verified backup or recreate a derived artifact";
	if (issue.category === "hash")
		action = "Restore the expected bytes from a verified backup or require user conflict resolution";
	return { issueCode: issue.code, action, automatic: false };
}

async function adapterIssues(
	projectRoot: string,
	manifest: Extract<Awaited<ReturnType<typeof openProject>>, { compatibility: "current" }>["manifest"],
	availableAdapters: ReadonlySet<string>,
): Promise<ProjectDoctorIssue[]> {
	const issues: ProjectDoctorIssue[] = [];
	for (const kind of [
		"adapter_export_profile",
		"monitor_subscription",
		"external_item_link",
	] as const satisfies readonly RecordKind[]) {
		for (const id of await listProjectRecordIds(projectRoot, manifest, kind)) {
			const result = await readRecord(projectRoot, kind, id);
			if (!result.ok) continue;
			if (
				result.value.kind === "adapter_export_profile" &&
				result.value.enabled &&
				!availableAdapters.has(result.value.adapterId)
			) {
				issues.push({
					code: "ADAPTER_ABSENT",
					category: "adapter_absence",
					severity: "attention",
					path: `adapter_export_profile:${id}`,
					message: `Enabled adapter ${result.value.adapterId} is unavailable`,
				});
			}
			if (result.value.kind === "monitor_subscription" && !availableAdapters.has(result.value.adapterId)) {
				issues.push({
					code: "ADAPTER_ABSENT",
					category: "adapter_absence",
					severity: "attention",
					path: `monitor_subscription:${id}`,
					message: `Monitor adapter ${result.value.adapterId} is unavailable`,
				});
			}
			if (result.value.kind === "external_item_link" && result.value.syncStatus !== "synced") {
				issues.push({
					code: "EXTERNAL_STATE_DRIFT",
					category: "external_drift",
					severity: "attention",
					path: `external_item_link:${id}`,
					message: "External item link requires reconciliation",
				});
			}
		}
	}
	return issues;
}

export async function doctorProject(
	projectRoot: string,
	availableAdapters: ReadonlySet<string> = DEFAULT_ADAPTERS,
	availableDomainPackages: ReadonlySet<string> = BUILT_IN_DOMAIN_PACKAGE_IDS,
): Promise<ProjectDoctorReport> {
	let opened: Awaited<ReturnType<typeof openProject>>;
	try {
		opened = await openProject(projectRoot);
	} catch (error) {
		const issue: ProjectDoctorIssue = {
			code: "PROJECT_OPEN_FAILED",
			category: "schema",
			severity: "blocked",
			path: "research-project.json",
			message: error instanceof Error ? error.message : "Project could not be opened",
		};
		return {
			format: "pi-research-project-doctor",
			version: 1,
			status: "blocked",
			projectId: null,
			schemaVersion: null,
			revision: null,
			issues: [issue],
			repairPlan: [repairAction(issue)],
		};
	}
	const identity = rawIdentity(opened.manifest);
	if (opened.compatibility !== "current") {
		const migratable = opened.compatibility === "migration_required" && MIGRATABLE.has(opened.schemaVersion);
		const issue: ProjectDoctorIssue = {
			code: migratable ? "SCHEMA_MIGRATION_REQUIRED" : "SCHEMA_UNSUPPORTED",
			category: "schema",
			severity: migratable ? "attention" : "blocked",
			path: "research-project.json#schemaVersion",
			message: migratable
				? `Project schema ${opened.schemaVersion} can migrate to ${RESEARCH_SCHEMA_VERSION}`
				: `Project schema ${opened.schemaVersion} is unsupported`,
		};
		return {
			format: "pi-research-project-doctor",
			version: 1,
			status: migratable ? "attention" : "blocked",
			projectId: identity.projectId,
			schemaVersion: opened.schemaVersion,
			revision: identity.revision,
			issues: [issue],
			repairPlan: [repairAction(issue)],
		};
	}
	const [validation, pendingTransactions, pendingMigrations, stagedMigrations, migrationLock, adapters] =
		await Promise.all([
			validateProject(opened.root),
			listPendingProjectTransactions(opened.root),
			listPendingProjectMigrations(opened.root),
			listStagedProjectMigrations(opened.root),
			migrationLockPresent(opened.root),
			adapterIssues(opened.root, opened.manifest, availableAdapters),
		]);
	const issues: ProjectDoctorIssue[] = validation.issues.map((issue) => ({
		...issue,
		category: categoryForValidationCode(issue.code),
		severity: "blocked" as const,
	}));
	if (pendingTransactions.length > 0 && !issues.some(({ code }) => code === "PENDING_TRANSACTION")) {
		issues.push({
			code: "PENDING_TRANSACTION",
			category: "pending_transaction",
			severity: "attention",
			path: ".research/transactions/pending",
			message: `${pendingTransactions.length} transaction(s) require recovery`,
		});
	}
	if (pendingMigrations.length > 0 || stagedMigrations.length > 0) {
		issues.push({
			code: stagedMigrations.length > 0 ? "MIGRATION_STAGING_INCOMPLETE" : "PENDING_MIGRATION",
			category: "pending_migration",
			severity: "attention",
			path: ".research/migrations",
			message: `${pendingMigrations.length} pending and ${stagedMigrations.length} staged migration(s) found`,
		});
	}
	if (migrationLock) {
		issues.push({
			code: "MIGRATION_LOCK_PRESENT",
			category: "pending_migration",
			severity: "attention",
			path: ".research/locks/migration.lock",
			message: "A migration lock is active or was left by an interrupted process",
		});
	}
	issues.push(...adapters);
	const { templatePackage, templateVersion } = opened.manifest.domain;
	if ((templatePackage === null) !== (templateVersion === null)) {
		issues.push({
			code: "DOMAIN_PACKAGE_REFERENCE_INCOMPLETE",
			category: "domain_package_absence",
			severity: "attention",
			path: "research-project.json#domain",
			message: "Domain package ID and version must either both be set or both be null",
		});
	} else if (templatePackage !== null && templateVersion !== null) {
		let available = availableDomainPackages.has(templatePackage);
		try {
			available =
				(await loadDomainPackageById(templatePackage, templateVersion, opened.root)).domainId ===
				opened.manifest.domain.id;
		} catch {
			if (BUILT_IN_DOMAIN_PACKAGE_IDS.has(templatePackage)) available = false;
		}
		if (!available) {
			issues.push({
				code: "DOMAIN_PACKAGE_ABSENT",
				category: "domain_package_absence",
				severity: "attention",
				path: "research-project.json#domain.templatePackage",
				message: `Domain package ${templatePackage}@${templateVersion} is unavailable; generic guidance remains usable`,
			});
		}
	}
	const status = issues.some(({ severity }) => severity === "blocked")
		? "blocked"
		: issues.length > 0
			? "attention"
			: "healthy";
	return {
		format: "pi-research-project-doctor",
		version: 1,
		status,
		projectId: opened.manifest.projectId,
		schemaVersion: RESEARCH_SCHEMA_VERSION,
		revision: opened.manifest.revision,
		issues,
		repairPlan: issues.map(repairAction),
	};
}
