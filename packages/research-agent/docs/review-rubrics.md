# Manuscript review rubrics

All reviewer roles inspect the same immutable manuscript revision and canonical project records. A role is a rubric, not an independent witness. Agreement among roles does not verify a fact, citation, method, or result.

| Rubric | Required checks | Allowed finding types |
|---|---|---|
| Integrity | citation-key closure, ClaimOccurrence anchors, located evidence, citation status, disclosure, P0 state, submission approval | `deterministic_violation` |
| Editor | question-to-conclusion alignment, section coherence, scope and limitation visibility | `evidence_based_concern`, `stylistic_suggestion` |
| Theory | construct consistency, relation direction, alternatives, boundary conditions, extrapolation | `evidence_based_concern`, `methodological_judgment` |
| Quantitative method | confirmed specification, estimand, identification, diagnostics, failed/non-converged runs, association-versus-causation language | `deterministic_violation` only for recorded contract failures; otherwise `methodological_judgment` |
| Qualitative method | authorized material, stable locators, confirmed codebook, human coding decisions, negative cases, audit trail | `deterministic_violation` only for recorded contract failures; otherwise `methodological_judgment` |
| Devil's advocate | strongest rival explanation, unsupported generalization, missing counterevidence | `evidence_based_concern`, `methodological_judgment` |

Every finding identifies the exact manuscript revision and, when available, a section or ClaimOccurrence. P0 means the draft cannot pass the submission gate while unresolved. A deterministic P0 cannot be dismissed by model prose. Other findings remain recommendations until the user records an explicit disposition.

AI-generated findings must retain provider/model provenance and must be labeled as AI review. They are not human peer review, editorial acceptance, ethics approval, or external replication.
