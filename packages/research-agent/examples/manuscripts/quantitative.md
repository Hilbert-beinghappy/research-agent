# Synthetic transparency and trust analysis

> Example status: `submission_candidate` in a synthetic audit fixture. This is not an external research finding.

## Findings

In the frozen synthetic dataset, explanation visibility is associated with the recorded trust score. The manuscript does not describe this association as causal.

## Claim audit

| ClaimOccurrence | Claim | Evidence | Locator | Method record | Boundary |
|---|---|---|---|---|---|
| `occ_quant_1` | `claim_quant_1` | `evidence_quant_1` | output `result.json`, field `association` | successful `analysis_run_quant_1`, confirmed associational specification | no causal effect asserted |

## Review closure

- Deterministic integrity finding: none open.
- Method judgment: association-versus-causation wording accepted by the user.
- Revision: version 2 supersedes version 1; both hashes remain in the project.
- AI disclosure: confirmed; drafting and rubric review disclosed, factual responsibility retained by the author.
- Submission gate: passed only after explicit `publish_or_submit` approval.
