---
name: research-project-intake
description: Clarify and bound a management or public-administration research topic before literature work. Use when the user wants to start a research project, refine a topic or question, define scope, plan search concepts, or asks about 选题、研究问题、研究范围、检索计划.
---

# Research Project Intake

Turn an initial topic into a reviewable scope and bounded search plan. Reply in the user's language.

## Establish the project

1. Check whether a research project is active. If not, clarify the scope first, then tell the user to run `/research-init "<title>"`; do not create project files directly.
2. Extract what the user already specified. Ask only about missing choices that materially change retrieval or interpretation, at most three questions at a time.
3. Present a scope card with:
   - phenomenon or problem;
   - unit and level of analysis;
   - population, organization, policy field, or jurisdiction;
   - focal concepts and proposed relationships;
   - time range and languages;
   - eligible evidence and explicit exclusions;
   - unresolved ambiguities.
4. Ask the user to confirm material assumptions before broad retrieval.

Do not force a causal question when the request is descriptive, interpretive, normative, or exploratory. Do not invent a population, jurisdiction, mechanism, or outcome.

## Build the search plan

After confirmation, form a small query plan from separate concept blocks and synonyms. Preserve meaningful differences between constructs instead of collapsing them into one broad keyword. Use bilingual terms when relevant, but state that current open-source coverage does not establish database completeness.

- Use `research_search_sources` for bounded Crossref/OpenAlex searches.
- Use `research_import_sources` when the user supplies RIS, BibTeX, CSL-JSON, or PDF files.
- Let the tools enforce budgets, approvals, normalization, deduplication, and project writes.
- Preserve partial failures and costs. Never describe a failed or unavailable adapter as a zero-result search.

## Hand off

Return the confirmed scope card, query plan ID, executed query IDs, newly recorded source IDs, exclusions, coverage limitations, and the next evidence task. Continue with the `literature-evidence` skill when the user wants retrieval, full text, close reading, or evidence cards.

Never write canonical JSON, compute record hashes, merge duplicates, or claim that the search is exhaustive.
