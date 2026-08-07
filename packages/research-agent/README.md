# Pi Research Agent

Pi Research Agent is a local-first Pi package for evidence-based management and public-administration research. v1.0 connects topic intake, governed literature discovery, evidence and citation checks, user-confirmed research design, reproducible local Python/R analysis, optional user-owned Stata execution, auditable qualitative coding, immutable claim-to-evidence manuscript revision, portable knowledge exports, Zotero reconciliation, and user-triggered literature monitoring. It adds direct migration from every v0.x project, hash-bound backup/restore, project diagnosis, deterministic model routing, and fast file-derived corpus indexes without adding a database or a separate UI.

The package is evidence-first: metadata, abstract text, acquired full text, located excerpts, and verified citations are distinct states. Missing full text, unresolved metadata, paywalls, retractions, and insufficient evidence remain explicit; they are never converted into success by model wording.

## Requirements and trust boundary

- Node.js 22.19.0 or newer.
- A compatible Pi installation. v1.0 is qualified against the package baseline `0.83.0`, the latest tested stable package `0.84.0`, and the architecture baseline Pi commit `97f0ccdd96cc207b6ad3630c56eea4d32dbdcf53`.
- Review the package before loading it. Like every Pi Extension, it runs in the Pi host process with the user's filesystem and network authority. Project policy and tool hooks are governance controls, not an OS sandbox.

## Run from a source checkout

Start Pi in a new empty research directory and point `-e` at this package:

```sh
mkdir research-project
cd research-project
pi -e /path/to/pi-mono/packages/research-agent
```

Then initialize and load the intake workflow:

```text
/research-version
/research-init "Public-sector AI accountability"
/skill:research-project-intake
```

Expected version notification:

```text
pi-research-agent v1.0.0
```

The eleven bundled Skills cover the research lifecycle from intake through monitoring. `/scope-review` and `/integrity-review` expand deterministic review prompts. The model invokes fourteen governed aggregate Tools; users do not edit canonical `.research/records` files directly. Project administration is available through `/research-status`, `/research-doctor`, `/research-backup`, `/research-restore`, and `/research-migrate`.

## Optional provider configuration

Provider values stay in the process environment and are referenced by alias in operation receipts. Do not put them in `research-project.json`:

```sh
export CROSSREF_MAILTO="researcher@example.org"
export OPENALEX_API_KEY="..."
export UNPAYWALL_EMAIL="researcher@example.org"
export ZOTERO_API_KEY="..."
```

Crossref works without `CROSSREF_MAILTO`. OpenAlex search and Unpaywall lookup report a degraded or blocked capability when their required value is absent. `ZOTERO_API_KEY` is referenced only by credential alias; it is never stored in a project. Every paid request, sensitive egress, and external write still requires the project budget and approval policy to allow it.

## Documentation

- [CLI and Tools](docs/cli.md)
- [Public API](docs/api.md)
- [Project format and recovery](docs/project-format.md)
- [Install, upgrade, and recovery](docs/install-upgrade-recovery.md)
- [Backup and restore](docs/backup-restore.md)
- [Support matrix](docs/support-matrix.md)
- [Adapter capabilities](docs/adapter-capabilities.md)
- [Asset provenance](docs/asset-provenance.md)
- [Evidence evaluation](docs/evaluation.md)
- [v1.0 threat model](docs/threat-model.md)
- [v0.1 release evidence and limitations](docs/release-v0.1.md)
- [v0.2 release evidence and limitations](docs/release-v0.2.md)
- [v0.3 release evidence and limitations](docs/release-v0.3.md)
- [v0.4 release evidence and limitations](docs/release-v0.4.md)
- [v0.5 release evidence and limitations](docs/release-v0.5.md)
- [v1.0 release evidence and limitations](docs/release-v1.0.md)
- [Literature monitoring and scheduling](docs/monitoring.md)
- [Manuscript review rubrics](docs/review-rubrics.md)
- [Submission gate](docs/submission-gate.md)
- [AI disclosure template](docs/ai-disclosure-template.md)
- [Runnable example requests](examples/README.md)

## Public contracts

The current v1.0 persisted-record, result, project-catalog, and project-backup contracts are exported from `pi-research-agent/contracts`. TypeBox definitions in `src/contracts/schemas.ts` are the single source for static types, runtime validation, and the JSON Schemas under `schemas/v1.0`. The immutable v0.1–v0.5 schemas remain committed; their projects can migrate directly to v1.0 without rewriting canonical records.

```sh
npm run generate:schemas -w packages/research-agent
npm run test:unit -w packages/research-agent -- contracts
```

The deterministic model router is exported from `pi-research-agent/routing/models`. The built-in SourceAdapter contract remains experimental; the stable isolated third-party Adapter contract is a v1.5 milestone. Zotero, portable-format, monitor, local analysis, project doctor, and backup implementations are governed built-in paths, not stable third-party execution APIs.

## Release checks

```sh
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent
npm run eval -w packages/research-agent -- v0.1
npm run benchmark:v0.1 -w packages/research-agent
npm run eval:v0.2 -w packages/research-agent -- v0.2
npm run benchmark:v0.2 -w packages/research-agent
npm run eval:v0.3 -w packages/research-agent -- v0.3
npm run benchmark:v0.3 -w packages/research-agent
npm run qualify:runtimes:v0.3 -w packages/research-agent
npm run eval:v0.4 -w packages/research-agent -- v0.4
npm run benchmark:v0.4 -w packages/research-agent
npm run eval:v0.5 -w packages/research-agent -- v0.5
npm run benchmark:v0.5 -w packages/research-agent
npm run eval:v1.0 -w packages/research-agent -- v1.0
npm run benchmark:v1.0 -w packages/research-agent
npm run scan:release -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:clean-install:latest -w packages/research-agent
npm run test:compat -w packages/research-agent
```

All deterministic tests use synthetic or recorded fixtures and require no provider credentials. Real model evaluation is an explicitly authorized release-candidate activity, not part of default CI.

## License

Apache-2.0. See `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `SBOM.spdx.json`.
