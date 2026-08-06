---
name: academic-writing
description: Create an immutable, sectioned academic manuscript from confirmed research questions, evidence, citations, and analysis records. Use when the user asks for an outline, section draft, claim-to-evidence mapping, manuscript revision, AI disclosure, or a submission-candidate integrity check.
---

# Academic Writing

Use `research_manuscript` for canonical manuscript records and `research_artifacts` for deterministic export. The model drafts prose; it does not create facts, evidence, verification, or analysis results.

## Workflow

1. Run `/research-status` and `/research-resume`. Identify the confirmed design, applicable analysis or qualitative synthesis, current claims, located evidence, and citation verification records.
2. Declare the paper type. A review or conceptual paper may omit analysis records; an empirical paper may not silently omit its method records.
3. Draft sections separately. Every core factual or causal statement must be represented as a ClaimOccurrence linked to an existing Claim and its exact EvidenceCard IDs. Keep metadata, abstract, unlocated full text, located evidence, and verified citation status distinct.
4. Use only bibliography entries backed by Source records. A citation key in prose must appear in the manuscript bibliography; bibliography presence is not citation verification.
5. Call `research_manuscript` with `action: "create_revision"`. Never edit an earlier manuscript revision in place. Use `supersedesManuscriptId` for the next immutable revision.
6. Use `action: "diff"` to show changed sections before asking the user to adopt a revision.
7. Record a user-confirmed disclosure with `action: "create_disclosure"` when AI assisted drafting or review.
8. Run `action: "submission_gate"` only after review dispositions are recorded. Export a `manuscript` artifact only from the passed report and the exact manuscript revision.

## Stop Conditions

- Stop rather than inventing a citation, evidence locator, analysis result, interview, reviewer, disclosure, or author decision.
- Do not convert association into causation, an abstract into full-text evidence, or an AI review into human peer review.
- Do not submit externally or mark a draft ready without the explicit submission-candidate approval.
