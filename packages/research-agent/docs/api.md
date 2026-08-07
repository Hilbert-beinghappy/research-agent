# Public API v2.0

Pi Research Agent exposes a deliberately small public surface. Files under `src/` that are not reachable through a package export are internal.

## Stable exports

| Package entry | Contract |
|---|---|
| `pi-research-agent` | Canonical JSON helpers, persisted schemas and types, validators, `ResearchResult`, project manifest, backup, catalog, evidence, citation, design, analysis, writing, approval, task, and operation contracts. |
| `pi-research-agent/contracts` | The same contract surface as the package root. |
| `@research-agent/contracts` | Data-only v1 contracts for projects, Adapters, JSONL messages, exchange, collaboration, model routes, canonical JSON, hashing, and validation. |
| `pi-research-agent/adapters/conformance` | Package loading, hashing, category conformance, and process-based conformance. |
| `pi-research-agent/adapters/runner` | Bounded JSONL process runner and Host broker boundary. |
| `pi-research-agent/adapters/registration` | Persist a matching successful conformance report as project registration. Embedders own approval when bypassing Pi commands. |
| `pi-research-agent/exchange` | Exchange pack/read/unpack and record-only collaboration create/read/merge APIs. |
| `pi-research-agent/routing/models` | `parseResearchModelRouteInput`, `selectResearchModelRoute`, their TypeBox schemas, and route/result types. |
| `pi-research-agent/sdk` | `createResearchSdk`, the seven documented inspection methods, package/schema capability metadata, and the shared request dispatcher. |
| `pi-research-agent/rpc` | Local stdio JSONL server over the same SDK dispatcher; no network listener. |
| `pi-research-agent/domains` | `loadDomainPackage`, `resolveDomainResources`, and resolved-resource types. |
| `pi-research-agent/access` | `evaluateAuthorizedSourceAccess`, built-in policy snapshot construction, request/decision types, and access-policy contracts. |
| `pi-research-agent/schemas/v1.5/*` | Generated JSON Schema for persisted records, machine results, project catalogs/backups, Adapter packages/protocol, exchange, collaboration, and model routes. |
| `pi-research-agent/schemas/v2.0/*` | SDK/RPC v1 request, response, and capability schemas. |

The v1 compatibility promise covers backward reading of published 1.x minor records, direct migration from 0.1–1.1 projects, Adapter contract v1, and the machine-readable `ResearchResult` envelope. A security fix may reject input that an older validator accepted; release notes must identify the tightened rule.

## Built-in integration exports

`pi-research-agent/adapters/source`, `adapters/crossref`, `adapters/openalex`, `adapters/unpaywall`, and `adapters/http` remain built-in provider surfaces. Third-party packages should implement the frozen interfaces from `@research-agent/contracts/adapters` and communicate through the JSONL protocol instead of importing a provider implementation.

## Extension boundary

The Pi package loads `extensions/research.ts`, registers fourteen governed aggregate Tools and sixteen research administration commands plus `/research-version`, and stores only a project link in Pi Session entries. Command results use the same `ResearchResult` shape as Tools. The v2.0 SDK/RPC subset exposes project open/validate/doctor and record list/read operations for explicitly configured projects. Backup, migration, transaction, Adapter registration, exchange, collaboration merge, and all other mutations remain Pi-governed or internal library surfaces.

## Change process

A breaking public contract, project-schema major, or default security-policy change requires an accepted RFC, migration and rollback documentation, compatibility fixtures, and a major version. New optional fields may be added in a minor version when old readers can preserve them without semantic reinterpretation.
