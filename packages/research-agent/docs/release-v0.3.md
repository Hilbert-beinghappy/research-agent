# v0.3 release evidence

Status: local release candidate. This document records observed evidence only; cross-platform CI is authoritative after the exact commit is pushed.

## Scope delivered

v0.3 adds content-addressed CSV and UTF-8 qualitative material, data dictionaries, confirmed analysis specifications, local Python/R execution, optional approved Stata batch execution, stable terminal `AnalysisRun` records, qualitative segments, versioned codebooks, immutable model suggestions, separate human coding decisions, themes, negative cases, and Markdown/JSON audit output. It adds `research_analysis` and `research_qualitative` plus two bounded Skills. Pi remains the only Agent loop and conversation UI; there is no database, notebook server, hosted compute, or second orchestrator.

The v0.2-to-v0.3 migration only adds record sets and directories. It does not move user data, infer a codebook, create a specification, or execute a runtime. Existing v0.1/v0.2 record schemas remain committed and readable.

## Observed local gates

| Gate | Observed result |
|---|---|
| Package check | Biome/tsgo passed after checking 97 files. |
| Unit and contract tests | 78/78 passed across 13 files. |
| Integration tests | 57/57 passed across 16 files. |
| Runtime clean room | Python 3.9.6 and R 4.5.3 each completed three runs; all six `result.json` hashes were identical, all run records were retained, project validation passed, and raw mutations were zero. |
| Failure injection | Missing package, missing variable, crash, timeout, non-convergence and raw mutation produced explicit terminal failure; false-success was zero and the mutated raw fixture was restored. Stata used only the mock `-b do` contract and did not inspect license content. |
| Qualitative audit | Three stable locators, three model suggestions, human accept/edit/reject, one superseded decision, one negative case and two theme versions remained in the audit; model-overwrite count was zero. |
| Performance | 1,000-row import/dictionary p95 96.065 ms; 1,000-segment indexing p95 4,309.390 ms; both below 5,000 ms with zero model/API calls. |
| Real model boundary | `deepseek-v4-flash` routed to both aggregate tools, stopped at imports, preserved associational scope, rejected significance selection/automatic coding, and covered eight warnings. JSON Schema output used two provider turns and cost USD 0.063315. |

The performance and runtime baselines are one Apple Silicon observation, not a cross-platform guarantee. The public data and interview text are synthetic and establish regression behavior only; they do not establish empirical validity, saturation, external validity, or method quality for another project.

## Reproduce deterministic qualification

```sh
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent
npm run eval:v0.3 -w packages/research-agent -- v0.3
npm run benchmark:v0.3 -w packages/research-agent
npm run scan:release -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:compat -w packages/research-agent
```

`npm run qualify:runtimes:v0.3 -w packages/research-agent` is an explicit release-candidate command because it executes local Python and R. It does not install either runtime or any package. Default CI uses contract tests and frozen qualification evidence and never reads private provider configuration.

## Permissions and non-claims

- Dataset/material import and deterministic profiling may create new project files automatically; raw originals are immutable and hash-checked.
- Analysis specification, codebook and theme confirmation require interactive user action. Python/R execution requires the project policy to allow or ask about unknown scripts; Stata always requires commercial-runtime approval.
- Qualitative segmentation, model suggestions and audits are blocked before record access when project model-egress policy excludes the active provider or qualitative material.
- The exact executable, arguments, project-relative run directory and inputs are shown before execution. Runtime code is not OS-sandboxed and remains user-reviewed code.
- Missing dependency/runtime/variable/output, crash, timeout, abort, non-convergence and input mutation never become success. The package does not install or substitute dependencies.
- A seed and lock file improve reproducibility but do not guarantee identical results across platforms or establish methodological validity.
- A model suggestion is not a coding decision. Human edits, rejections, supersession and negative cases remain visible.
- v0.3 does not select models for significance, upgrade association to causation, contact participants, certify ethics/privacy, build a notebook/UI, run hosted compute, or distribute Stata.
