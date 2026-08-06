# v0.1 release evidence

Status: release candidate. This document records observed local evidence and separates it from CI/platform evidence. A Git push is not an npm publication.

## Scope delivered

v0.1 implements a single Pi host Agent with three Skills and seven aggregate Tools. It uses versioned Markdown/JSON/RIS/BibTeX files, no database, no custom UI, no sub-Agent runtime, and no Pi core modification. Crossref, OpenAlex, Unpaywall, local bibliography/PDF import, text-layer parsing, evidence cards, citation verification, artifact gates, and transaction recovery are connected through one canonical project format.

## Scenario A and quality gates

The offline Scenario A replay covers three frozen management/public-administration topics. Each produces a recoverable project, normalized/de-duplicated source state, access/full-text states, six located and four abstract EvidenceCards, citation status, evidence matrix, review, JSONL/RIS/BibTeX exports, and explicit anomaly results.

Observed v0.1 candidate evidence:

| Gate | Result |
|---|---|
| Scenario A replay | Passed for all three topics in the local candidate run. |
| Evidence rubric | 30 cards and 3 reviews; each review scored 20/20; hard items 4, 5 and 8 scored 2/2. |
| Evidence-level violation | 0 in the frozen gate. |
| False verified citation | 0 in the frozen gate. |
| Recovery data loss | 0 in transaction fault fixtures. |
| Dedup gold | Threshold enforced by `normalization-dedup` tests: precision >=0.98 and recall >=0.95. |
| Text locator | Threshold enforced by PDF/evidence tests: >=0.95 on the text-layer fixture set. |
| Real model routing check | One explicitly authorized `deepseek-v4-flash` call; unsupported conclusion remained blocked. Public aggregate baseline contains no credential or local config. |

The frozen rubric and public aggregate baselines are under `evals/`. Recorded provider and document fixtures are under `test/fixtures/`; they contain synthetic/minimized test data, not private research material.

## Reproduce deterministic qualification

```sh
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent -- scenario-a
npm run eval -w packages/research-agent -- v0.1
npm run benchmark:v0.1 -w packages/research-agent
npm run scan:release -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:compat -w packages/research-agent
```

Default CI is credential-free and does not call a live model or provider. The dedicated research-agent matrix repeats Scenario A and the quality evaluator three times on Ubuntu, macOS, and Windows, then checks the tarball, clean install, baseline compatibility, and performance thresholds.

## Performance budget

`npm run benchmark:v0.1 -w packages/research-agent` measures actual v0.1 code with synthetic, credential-free fixtures and fails when:

- opening and computing status for a project containing 1,000 SourceRecords has p95 >=1 second;
- deterministic normalization/deduplication of 1,000 candidates has p95 >=3 seconds;
- the 20-literature offline normalization, deduplication, canonical source set, and JSON/RIS/BibTeX/Markdown rendering path takes >=30 seconds.

The JSON report records runtime/platform resources, fixture counts and bytes, wall/CPU/RSS/disk observations, and zero model/API usage. Network and model latency are deliberately excluded and are governed by per-operation budgets instead.

The committed local baseline `evals/v0.1/baselines/performance-darwin-arm64.json` was measured from source revision `6dc2b59ee6929b97af504a9eec26435306b4bc10` on Apple M4 / 16 GiB / Node 24.14.0:

| Measurement | Local p95 | Release threshold |
|---|---:|---:|
| 1,000-source project open and status | 0.649 ms | <1,000 ms |
| 1,000-candidate deterministic deduplication | 28.593 ms | <3,000 ms |
| 20-literature offline deterministic flow | 3.707 ms | <30,000 ms |

This is one machine observation, not a cross-platform guarantee. Each GitHub matrix job writes its own benchmark artifact for the exact pushed commit.

## Supply-chain and release boundary

- `SBOM.spdx.json` is a deterministic SPDX 2.3 inventory of the package's production dependency closure.
- `THIRD_PARTY_NOTICES.md` separates bundled runtime dependencies from host-provided peers.
- `scan:release` inspects the actual npm file list for required public artifacts, unknown Skills, test code, AppleDouble files, environment/config files, common secrets, private keys, personal paths, and unknown declared licenses.
- `test:clean-install` installs the packed package in a temporary project with lifecycle scripts disabled and imports the public contract.
- Direct runtime dependencies are exact pins. Pi core packages and TypeBox are host peers.

## Known limitations and non-claims

- v0.1 has seven actual aggregate Tools. Earlier architecture prose describing nine logical tools is not the implementation surface.
- v0.1 has no `/research-export` command; export is performed by `research_artifacts`.
- OpenAlex pricing/availability and all external APIs can drift. Recorded fixture tests do not prove current live-service behavior.
- Scanned PDFs are identified as `OCR_REQUIRED`; no OCR is performed or uploaded.
- Model quality is not inferred from one routing call. Deterministic gates, provenance, and human review remain authoritative.
- The package does not claim systematic-review compliance merely because it generated a review.
- In-process Pi Extensions/Adapters are trusted code, not sandboxed plugins.
- v0.1 is not published to npm by this repository task; publication requires a separate reviewed release action.
- Cross-platform status is authoritative only after the public matrix reports success for the exact pushed commit.
