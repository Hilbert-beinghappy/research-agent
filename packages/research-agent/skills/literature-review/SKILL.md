---
name: literature-review
description: Synthesize canonical claims and evidence into a traceable management or public-administration literature review. Use for evidence matrices, thematic synthesis, research gaps, review drafting, integrity checks, citation-ready exports, or requests mentioning 文献综述、证据矩阵、研究缺口、综述定稿.
---

# Literature Review

Synthesize from project records, not chat memory or uncommitted notes. Reply in the user's language.

## Load the rules

Read [evidence-rules.md](references/evidence-rules.md) before synthesis. For management or public-administration work, also read [management-public-admin.md](references/management-public-admin.md).

## Synthesize

1. Use `research_query_corpus` to inspect current claims, evidence, sources, and unresolved states in bounded pages.
2. Use `research_artifacts` to generate an exploratory evidence matrix. Move it to `evidence_checked` only after the deterministic gate passes.
3. Organize the review around constructs, theories, mechanisms, contexts, methods, and disagreements rather than listing papers one by one.
4. Tie each substantive sentence in the working draft to ClaimRecord and EvidenceCard IDs. Calibrate wording to the evidence level and relationship.
5. Present contradictory and qualifying evidence alongside support. Explain boundary conditions without turning heterogeneity into a false consensus.
6. Derive gaps from the recorded search and evidence matrix. Say “not found in the recorded search scope” instead of claiming that no research exists.
7. Use `research_verify_citations` for missing or stale citation checks and `research_documents` plus `research_query_corpus` for missing full-text locations.
8. Commit the review with `research_artifacts`. Keep it `exploratory` while blockers remain, request `evidence_checked` only when evidence rules pass, and request `submission_candidate` only when the user explicitly asks to finalize and accepts the displayed warnings.
9. Generate RIS, BibTeX, or JSON through `research_artifacts`; do not format or write canonical exports by hand.

## Required sections

Include the bounded question and search scope, thematic synthesis, evidence disagreements, methodological and contextual limits, evidence-based gaps, and next research actions. Keep unresolved items visible in the prose or a blocker list.

## Stop conditions

Do not present an artifact as submission-ready when a core claim lacks located evidence, a formal citation is unverified, a source has an unresolved conflict or high-risk publication status, or the final confirmation is absent. Return the blocker, affected record IDs, and the smallest next action instead.
