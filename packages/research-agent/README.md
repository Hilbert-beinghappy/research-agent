# Pi Research Agent

Pi Research Agent is a local-first Pi package for evidence-based management and public-administration research. v0.2 connects topic intake, governed literature discovery, local bibliography/PDF import, deterministic deduplication, full-text status, located evidence, citation verification, evidence matrices, review artifacts, and user-confirmed quantitative or qualitative research design without adding a database or a separate UI.

The package is evidence-first: metadata, abstract text, acquired full text, located excerpts, and verified citations are distinct states. Missing full text, unresolved metadata, paywalls, retractions, and insufficient evidence remain explicit; they are never converted into success by model wording.

## Requirements and trust boundary

- Node.js 22.19.0 or newer.
- A compatible Pi installation; v0.1 is qualified against Pi commit `97f0ccdd96cc207b6ad3630c56eea4d32dbdcf53`.
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
pi-research-agent v0.2.0
```

The four bundled Skills are `research-project-intake`, `literature-evidence`, `literature-review`, and `research-design`. `/scope-review` and `/integrity-review` expand deterministic review prompts. The model invokes eight governed aggregate Tools; users do not edit canonical `.research/records` files directly.

## Optional provider configuration

Provider values stay in the process environment and are referenced by alias in operation receipts. Do not put them in `research-project.json`:

```sh
export CROSSREF_MAILTO="researcher@example.org"
export OPENALEX_API_KEY="..."
export UNPAYWALL_EMAIL="researcher@example.org"
```

Crossref works without `CROSSREF_MAILTO`. OpenAlex search and Unpaywall lookup report a degraded or blocked capability when their required value is absent. Every paid request still requires the project budget and approval policy to allow it.

## Documentation

- [CLI and Tools](docs/cli.md)
- [Project format and recovery](docs/project-format.md)
- [Adapter capabilities](docs/adapter-capabilities.md)
- [Asset provenance](docs/asset-provenance.md)
- [Evidence evaluation](docs/evaluation.md)
- [v0.1 threat model](docs/threat-model.md)
- [v0.1 release evidence and limitations](docs/release-v0.1.md)
- [v0.2 release evidence and limitations](docs/release-v0.2.md)
- [Runnable example requests](examples/README.md)

## Public contracts

The current v0.2 persisted-record and result contracts are exported from `pi-research-agent/contracts`. TypeBox definitions in `src/contracts/schemas.ts` are the single source for static types, runtime validation, and the JSON Schemas under `schemas/v0.2`. The immutable v0.1 schemas remain under `schemas/v0.1`; existing v0.1 records remain readable after manifest migration.

```sh
npm run generate:schemas -w packages/research-agent
npm run test:unit -w packages/research-agent -- contracts
```

The built-in SourceAdapter contract is exported from `pi-research-agent/adapters/source`. It remains experimental in v0.2; the stable third-party Adapter v1 contract is a v1.5 milestone.

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
npm run scan:release -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:compat -w packages/research-agent
```

All deterministic tests use synthetic or recorded fixtures and require no provider credentials. Real model evaluation is an explicitly authorized release-candidate activity, not part of default CI.

## License

Apache-2.0. See `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `SBOM.spdx.json`.
