# Public API v1

Pi Research Agent exposes a deliberately small public surface. Files under `src/` that are not reachable through a package export are internal and may change within v1.x.

## Stable v1 exports

| Package entry | Contract |
|---|---|
| `pi-research-agent` | Canonical JSON helpers, persisted schemas and types, validators, `ResearchResult`, project manifest, backup, catalog, evidence, citation, design, analysis, writing, approval, task, and operation contracts. |
| `pi-research-agent/contracts` | The same contract surface as the package root. |
| `pi-research-agent/routing/models` | `parseResearchModelRouteInput`, `selectResearchModelRoute`, their TypeBox schemas, and route/result types. |
| `pi-research-agent/schemas/v1.0/*` | Generated JSON Schema for persisted records, machine results, project catalogs, and project backups. |

The v1 compatibility promise covers backward reading of published 1.x minor records, direct migration from 0.1–0.5 projects, and the machine-readable `ResearchResult` envelope. A security fix may reject input that an older validator accepted; release notes must identify the tightened rule.

## Experimental exports

`pi-research-agent/adapters/source`, `adapters/crossref`, `adapters/openalex`, `adapters/unpaywall`, and `adapters/http` are built-in integration surfaces. They are public for testing and composition but are not the stable isolated third-party Adapter contract. That contract and its conformance kit are a v1.5 milestone.

## Extension boundary

The Pi package loads `extensions/research.ts`, registers fourteen governed aggregate Tools and thirteen research administration commands plus `/research-version`, and stores only a project link in Pi Session entries. Command results use the same `ResearchResult` shape as Tools. The Extension, project doctor, backup engine, migration engine, transaction internals, and filesystem layout helpers are not imported as SDK APIs in v1.0; automation uses Pi command/Tool surfaces until the v2.0 SDK/RPC release.

## Change process

A breaking public contract, project-schema major, or default security-policy change requires an accepted RFC, migration and rollback documentation, compatibility fixtures, and a major version. New optional fields may be added in a minor version when old readers can preserve them without semantic reinterpretation.
