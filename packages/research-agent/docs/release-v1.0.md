# v1.0 release evidence and limitations

## Shipped

- Schema 1.0 and direct, backup-bound migration from every v0.1–v0.5 manifest without canonical record rewrites.
- Hash-bound backup/restore, project doctor, project migration lock, fast summary status, and file-derived source/evidence/claim query indexes.
- Deterministic policy-aware model routing and a v1 machine-readable `ResearchResult` contract.
- Public API, install/upgrade/recovery, backup, support, security, governance, and RFC documentation.
- Baseline/latest Pi package lanes and Ubuntu/macOS/Windows CI configuration.

## Observed release-candidate evidence

| Gate | Result |
|---|---|
| Scenario D | 15/15 historical-schema interruption cases passed; canonical record rewrites and mixed states: 0. |
| Recovery boundary set | 12/12 declared failure cases retained explicit blocked/degraded states; canonical corruption: 0. |
| Scale benchmark | 10,000-source status p95 3.365 ms; 50,000-evidence filtered query p95 215.477 ms; both below 2 seconds on Darwin arm64/Node 22.19.0. |
| Model boundary | One `deepseek-v4-flash` invocation, two provider turns, USD 0.068305; selected `blocked` and preserved all declared safety rules. |
| Session continuity | Extension integration rebinds the same canonical project across 10 Session identities; Session deletion never removes project facts. |
| Public project replays | Two long-running replay specifications are bound to all six lifecycle stages, five release gates, and at least 10 Session rebinds; Scenario A generates three public synthetic management/public-administration projects. |

The committed evaluator replays sanitized hashes and results without a credential or provider call. Exact commands and interpretation limits are in `docs/evaluation.md`.

## Known limitations

- Public project replays are synthetic and redistribution-safe. The lifecycle evidence is composed across the declared release matrix rather than shipped as human research projects; it is not external scholarly validation or independent-user usability evidence.
- The 10k/50k benchmark uses a deterministic disposable index and manifest counts rather than committing 60,000 canonical fixture files. End-to-end canonical writes are tested separately.
- A backup on the same device is not off-device disaster recovery.
- Pi main/head is observed as a non-blocking future-compatibility lane only after a concrete commit is tested; v1.0 supports the package versions listed in the compatibility manifest.
- SourceAdapter remains experimental and in-process. Unknown third-party Adapter isolation, stable exchange bundles, and SDK/RPC are v1.5/v2.0 work.
- No database, custom Web/desktop UI, hosted project service, account server, background Agent, or default multi-Agent scheduler is included.

## Upgrade trigger

v1.1 work may proceed after the v1.0 core remains migration-clean and the domain/source licensing review is executable. Claims about external pilots, independent installation, or a licensed Chinese database require observed evidence before publication; absence is reported rather than replaced with synthetic success.
