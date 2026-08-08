# Pi Research Agent

Pi Research Agent is a local-first Pi package for evidence-based research. The current source tree is an unpublished v2.0.1 hardening candidate; Doro is the branded Pi Package/Profile and does not provide a standalone `doro` CLI. The package connects topic intake, governed literature discovery, evidence and citation checks, user-confirmed research design, isolated local Python/R analysis, optional user-owned Stata execution, auditable qualitative coding, immutable claim-to-evidence manuscript revision, portable knowledge exports, a Zotero export/push adapter, Obsidian-compatible Markdown export, and user-triggered literature monitoring. It extends Pi without replacing Pi Core, adding a database, or requiring a separate UI.

The package is evidence-first: metadata, abstract text, acquired full text, located excerpts, and verified citations are distinct states. Missing full text, unresolved metadata, paywalls, retractions, and insufficient evidence remain explicit; they are never converted into success by model wording.

## Requirements and trust boundary

- Node.js 22.19.0 or newer.
- A compatible Pi installation. v2.0 is qualified against the package baseline `0.83.0`, the latest tested stable package `0.84.0`, and the architecture baseline Pi commit `97f0ccdd96cc207b6ad3630c56eea4d32dbdcf53`.
- Review the package before loading it. The Pi Extension and built-in code run in the Pi host process. Third-party Adapters and analysis runtimes use macOS Seatbelt or Linux bubblewrap strong isolation when available; Windows blocks strong isolation. Explicitly approved host-user analysis fallback is not a sandbox.

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
/research-init --domain public-administration "Public-sector AI accountability"
/skill:research-project-intake
```

Expected version notification:

```text
pi-research-agent v2.0.1
```

The source and packed candidate report 2.0.1. This is release-candidate identity, not evidence that npm publication or the GitHub release has occurred.

The eleven bundled Skills cover the research lifecycle from intake through monitoring. `/scope-review` and `/integrity-review` expand deterministic review prompts. The model invokes fourteen governed aggregate Tools; users do not edit canonical `.research/records` files directly. Seventeen administration commands cover project state, migration, domains, Adapter inspection/registration, deterministic model routing, and exchange.

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
- [Public contracts](docs/public-contracts.md)
- [Adapter development](docs/adapter-development.md)
- [Adapter protocol and isolation](docs/adapter-protocol.md)
- [Exchange and collaboration](docs/exchange-collaboration.md)
- [Model routing](docs/model-routing.md)
- [SDK and stdio RPC](docs/sdk-rpc.md)
- [Project format and recovery](docs/project-format.md)
- [Install, upgrade, and recovery](docs/install-upgrade-recovery.md)
- [Backup and restore](docs/backup-restore.md)
- [Support matrix](docs/support-matrix.md)
- [Adapter capabilities](docs/adapter-capabilities.md)
- [Domain Packages](docs/domain-packages.md)
- [Authorized academic sources](docs/authorized-sources.md)
- [Asset provenance](docs/asset-provenance.md)
- [Evidence evaluation](docs/evaluation.md)
- [v2.0 threat model](docs/threat-model.md)
- [v0.1 release evidence and limitations](docs/release-v0.1.md)
- [v0.2 release evidence and limitations](docs/release-v0.2.md)
- [v0.3 release evidence and limitations](docs/release-v0.3.md)
- [v0.4 release evidence and limitations](docs/release-v0.4.md)
- [v0.5 release evidence and limitations](docs/release-v0.5.md)
- [v1.0 release evidence and limitations](docs/release-v1.0.md)
- [v1.1 release evidence and limitations](docs/release-v1.1.md)
- [v1.5 release evidence and limitations](docs/release-v1.5.md)
- [v2.0 release evidence and limitations](docs/release-v2.0.md)
- [v2.0.1 release-candidate boundary](docs/release-v2.0.1-rc.md)
- [Release-candidate checklist](docs/release-checklist.md)
- [Literature monitoring and scheduling](docs/monitoring.md)
- [Manuscript review rubrics](docs/review-rubrics.md)
- [Submission gate](docs/submission-gate.md)
- [AI disclosure template](docs/ai-disclosure-template.md)
- [Runnable example requests](examples/README.md)
- [v2.0 full-workflow example](examples/full-workflow-v2.0/README.md)

## Public contracts

`@research-agent/contracts` publishes compiled data-only modules through its root plus adapter-protocol, adapters, canonical-json, integrity, schemas, sdk-rpc, validators, and package metadata entry points. `pi-research-agent` deliberately exposes only its compiled contract facade, adapter protocol, SDK, RPC, generated schemas, and package metadata. Provider implementations, project mutation, routing, exchange, Domain Package loading, registration, and other Host internals are not public subpath exports.

Canonical project schemas remain under `schemas/v1.5`; the current schema is 1.5.1 and SDK/RPC protocol schemas remain under `schemas/v2.0`. Migration to 1.5.1 records semantic provenance explicitly and uses `unknown_legacy` rather than guessing an uncertain historical source.

```sh
npm run generate:schemas -w packages/research-agent-contracts
npm test -w packages/research-agent-contracts
npm run generate:schemas -w packages/research-agent
npm run test:unit -w packages/research-agent -- contracts
```

Third-party Adapters depend on `@research-agent/contracts`, not Research Agent internals. `pi-research-agent/sdk` and `pi-research-agent/rpc` expose the documented inspection-only facade. Zotero, monitoring, migration, backup, project mutation, model routing, exchange, Domain Package resolution, conformance, registration, and process execution remain governed built-in paths.

## Release checks

```sh
npm run check -w packages/research-agent-contracts
npm test -w packages/research-agent-contracts
npm run scan:release -w packages/research-agent-contracts
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent
npm run test:public-corpus -w packages/research-agent
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
npm run eval:v1.1 -w packages/research-agent -- v1.1
npm run benchmark:v1.1 -w packages/research-agent
npm run eval:v1.5 -w packages/research-agent -- v1.5
npm run benchmark:v1.5 -w packages/research-agent
npm run qualify:isolation:v1.5 -w packages/research-agent
npm run eval:v2.0 -w packages/research-agent -- v2.0
npm run benchmark:v2.0 -w packages/research-agent
npm run qualify:scenario-e:v2.0 -w packages/research-agent
npm run qualify:release:v2.0 -w packages/research-agent
npm run report:release-identity -w packages/research-agent
npm run scan:release -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:clean-install:latest -w packages/research-agent
npm run test:compat -w packages/research-agent
npm run validate:security-waivers -w packages/research-agent
```

All deterministic tests use synthetic or recorded fixtures and require no provider credentials. Real model evaluation is an explicitly authorized release-candidate activity, not part of default CI.

## License

Apache-2.0. See `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `SBOM.spdx.json`.
