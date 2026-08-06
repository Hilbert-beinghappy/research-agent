# v0.2 release evidence

Status: local release candidate. This document records observed evidence only; cross-platform CI is authoritative after the exact commit is pushed.

## Scope delivered

v0.2 extends the v0.1 evidence project with five canonical record families: `ResearchQuestionVersion`, `ConceptRecord`, `TheoryRelation`, `DesignDecision`, and `ProtocolRecord`. One `research_design` aggregate Tool and one progressively loaded `research-design` Skill create and confirm these records. Deterministic `research-design` artifacts reuse the existing Artifact path. Pi remains the only conversation UI and Agent loop; the package still adds no database, custom UI, or multi-Agent runtime.

The v0.1-to-v0.2 migration changes only manifest schema, revision, record-set declarations, and directories. It stores hash-bound before/after snapshots, resumes an interrupted pending migration, and refuses rollback after any later v0.2 manifest write. Existing v0.1 records and public schemas remain readable and are not rewritten.

## Observed local gates

| Gate | Observed result |
|---|---|
| Package check | Biome checked 88 files; tsgo reported no errors. |
| Unit and contract tests | 74/74 passed across 12 files. |
| Integration tests | 47/47 passed across 14 files with one worker. |
| Migration | Preparation is non-mutating; pending recovery, commit, unchanged rollback, and lossy-rollback block passed. |
| Scenario A design extension | One complete v0.1 evidence project continued into seven confirmed design records, one quantitative protocol, one qualitative protocol, and a deterministic design artifact. |
| Method boundary | Six public fixtures (three quantitative, three qualitative) passed 8/8 hard gates each. Causal/associational gold violations, missing confirmed provenance, and injected-boundary false negatives were all zero. |
| Real model boundary | One validated `deepseek-v4-flash` turn preserved the associational boundary, blocked automatic confirmation and analysis, and covered all required risks. The validated call cost USD 0.038; one earlier harness-rejected invocation has explicitly unobserved cost. |
| Performance | Final local validation p95 13.618 ms (<2,000 ms); design artifact p95 0.619 ms (<5,000 ms); zero model/API calls in the benchmark itself. |

The performance baseline is one Apple Silicon observation under `evals/v0.2/baselines/performance-darwin-arm64.json`, not a cross-platform guarantee. The method fixtures and frozen rubric establish regression behavior on declared cases; they do not replace external methods review.

## Reproduce deterministic qualification

```sh
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent -- scenario-a
npm run eval -w packages/research-agent -- v0.1
npm run eval:v0.2 -w packages/research-agent -- v0.2
npm run benchmark:v0.1 -w packages/research-agent
npm run benchmark:v0.2 -w packages/research-agent
npm run scan:release -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:compat -w packages/research-agent
```

Default CI is credential-free and does not call a model or live academic provider. The dedicated three-platform matrix preserves the v0.1 Scenario A regression and adds the v0.2 method gate and performance budget.

## Permissions and non-claims

- Creating local design drafts is automatic; every design confirmation or rejection is an explicit interactive action. Headless confirmation persists `awaiting_confirmation` and returns `PERMISSION_BLOCKED`.
- Evidence gaps are permitted but explicit. Confirmation requires current Operation provenance and either Evidence/Claim provenance or `evidenceGap: true`.
- `claimMode: causal` requires a named identification strategy and assumptions. A method label or estimator name does not establish causality.
- Quantitative protocols require a preanalysis plan. Qualitative protocols require an interview or case-selection plan and preserve audit requirements.
- Ethics checklists identify required review; they are not IRB, legal, privacy, or organizational approval.
- v0.2 does not run statistical analysis, qualitative coding, participant outreach, external preregistration, team collaboration, or automatic submission.
- v0.2 does not add a database, vector index, custom Web/desktop UI, or Pi core modification.
