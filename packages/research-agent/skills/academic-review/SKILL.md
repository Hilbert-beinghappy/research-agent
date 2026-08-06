---
name: academic-review
description: Review an immutable manuscript against deterministic integrity results and explicit editorial, evidence, theory, method, causal, and extrapolation rubrics. Use when the user asks for manuscript review, integrity findings, reviewer perspectives, citation audit, or unresolved issue triage.
---

# Academic Review

Use `research_review` to preserve findings. Reviewer roles are rubrics over the same canonical project, not independent evidence sources.

## Workflow

1. Run `research_review` with `action: "record_integrity_findings"` first. Deterministic violations take priority over prose advice.
2. Inspect the exact manuscript revision, ClaimOccurrences, cited Sources, EvidenceCards, analysis runs, disclosure, and existing findings.
3. Apply only relevant rubrics: editorial coherence, theory boundary, method validity, causal identification, extrapolation, evidence sufficiency, and citation integrity.
4. Record model findings with `action: "record_findings"`. Use `deterministic_violation` only for a machine-checkable failed rule; otherwise use `evidence_based_concern`, `methodological_judgment`, or `stylistic_suggestion`.
5. Point each finding to a section or ClaimOccurrence when possible. State the observed record boundary and a concrete correction; do not manufacture a missing fact.
6. Let the user accept, reject, defer, or otherwise decide each finding through the revision workflow. Repeated identical findings are deduplicated, not counted as corroboration.

## Stop Conditions

- Do not treat agreement among model roles as verification or override CitationVerification, AnalysisRun, qualitative decisions, or user judgment.
- Do not claim human peer review, journal acceptance, ethical approval, or factual correctness from this workflow.
- Do not automatically reject a manuscript or accept review advice.
