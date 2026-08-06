# Manuscript submission gate

`research_manuscript` with `action: "submission_gate"` evaluates one immutable `ManuscriptRecord`. It records readiness only; it never sends a file or submits to a journal.

The gate fails when any of these conditions holds:

- a Markdown citation key is absent from the manuscript bibliography;
- a declared ClaimOccurrence citation is absent from the section text or bibliography;
- a core ClaimOccurrence lacks located supporting/qualifying evidence from its cited Source;
- cited Source metadata is unresolved, duplicated, retracted, withdrawn, or under an expression of concern;
- a cited Source lacks current formal CitationVerification;
- a quantitative or qualitative paper lacks its required successful AnalysisRun or confirmed ThemeSynthesis;
- a core causal claim lacks a successful run from a confirmed causal specification;
- a ClaimOccurrence no longer matches its immutable section range and anchor hash;
- the manuscript lacks a user-confirmed AI DisclosureRecord;
- an unresolved P0 ReviewFinding remains.

After deterministic checks pass, the user must explicitly approve `research.manuscript.mark_submission_candidate`. The resulting `SubmissionGateReport` includes exact record references, coverage ratios, P0 count, approval ID, and timestamp. A `manuscript` Artifact can become `submission_candidate` only from that report; export reuses the same approval and does not prompt a second time.

Any later manuscript revision requires a new disclosure review and a new submission-gate report. An old report never upgrades a newer revision.
