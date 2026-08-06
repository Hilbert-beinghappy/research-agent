import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const allowedTools = new Set([
	"research_search_sources",
	"research_import_sources",
	"research_documents",
	"research_query_corpus",
	"research_commit_evidence",
	"research_verify_citations",
	"research_artifacts",
	"research_design",
	"research_analysis",
	"research_qualitative",
]);

function researchTools(content: string): string[] {
	return [...new Set(content.match(/\bresearch_[a-z_]+\b/g) ?? [])].sort();
}

describe("research skill routing", () => {
	it("loads six bounded workflow skills and two thin prompt templates", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-research-skills-"));
		const cwd = join(tempDir, "project");
		const agentDir = join(tempDir, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);

		try {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory({ packages: [packageDir] }),
			});
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const packageSkills = skills.filter(({ filePath }) =>
				filePath.startsWith(`${join(packageDir, "skills")}${sep}`),
			);
			expect(packageSkills.map(({ name }) => name).sort()).toEqual([
				"literature-evidence",
				"literature-review",
				"qualitative-research",
				"quantitative-research",
				"research-design",
				"research-project-intake",
			]);
			const descriptions = new Map(packageSkills.map(({ name, description }) => [name, description]));
			expect(descriptions.get("research-project-intake")).toContain("选题");
			expect(descriptions.get("literature-evidence")).toContain("证据卡");
			expect(descriptions.get("literature-review")).toContain("文献综述");
			expect(descriptions.get("research-design")).toContain("research question");
			expect(descriptions.get("quantitative-research")).toContain("UTF-8 CSV");
			expect(descriptions.get("qualitative-research")).toContain("human coding decisions");

			const skillText = new Map<string, string>();
			for (const skill of packageSkills) {
				const content = await readFile(skill.filePath, "utf8");
				skillText.set(skill.name, content);
				expect(researchTools(content).every((tool) => allowedTools.has(tool))).toBe(true);
				expect(content).not.toMatch(
					/createRecord|updateRecord|brokerProjectFile|hashCanonicalJson|\.research\/records/,
				);
			}
			expect(skillText.get("literature-evidence")).toContain("abstract evidence");
			expect(skillText.get("literature-evidence")).toContain("fulltext_unlocated");
			expect(skillText.get("literature-review")).toContain("unresolved conflict");
			expect(skillText.get("literature-review")).toContain("smallest next action");
			expect(skillText.get("research-design")).toContain('claimMode: "causal"');
			expect(skillText.get("research-design")).toContain("Never infer confirmation from silence");

			const evidenceRules = await readFile(
				join(packageDir, "skills", "literature-review", "references", "evidence-rules.md"),
				"utf8",
			);
			for (const level of [
				"metadata",
				"abstract",
				"fulltext_unlocated",
				"fulltext_located",
				"table_or_figure_located",
				"dataset_or_appendix_located",
			]) {
				expect(evidenceRules).toContain(`\`${level}\``);
			}

			const { prompts, diagnostics: promptDiagnostics } = loader.getPrompts();
			expect(promptDiagnostics).toEqual([]);
			const packagePrompts = prompts.filter(({ filePath }) =>
				filePath.startsWith(`${join(packageDir, "prompts")}${sep}`),
			);
			expect(packagePrompts.map(({ name }) => name).sort()).toEqual(["integrity-review", "scope-review"]);
			for (const prompt of packagePrompts) {
				expect(researchTools(prompt.content).every((tool) => allowedTools.has(tool))).toBe(true);
				expect(prompt.content).not.toMatch(/createRecord|updateRecord|SHA-256|dedupKeys|inputAggregateHash/);
			}
			expect(packagePrompts.find(({ name }) => name === "scope-review")?.content).toContain(
				"research-project-intake",
			);
			expect(packagePrompts.find(({ name }) => name === "integrity-review")?.content).toContain(
				"research_artifacts",
			);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
