# Public API v2.0

Pi Research Agent exposes a deliberately small public surface. Files under `src/` that are not reachable through a package export are internal.

## Stable exports

| Package entry | Contract |
|---|---|
| `pi-research-agent` | Compiled canonical contract facade: schemas, types, validators, `ResearchResult`, and canonical JSON/integrity helpers. |
| `pi-research-agent/contracts` | The same contract surface as the package root. |
| `pi-research-agent/adapter-protocol` | Compiled Adapter JSONL protocol contracts. |
| `pi-research-agent/sdk` | `createResearchSdk`, the seven documented inspection methods, package/schema capability metadata, and the shared request dispatcher. |
| `pi-research-agent/rpc` | Local stdio JSONL server over the same SDK dispatcher; no network listener. |
| `pi-research-agent/schemas/v1.5/*` | Generated JSON Schema for persisted records, machine results, project catalogs/backups, Adapter packages/protocol, exchange, collaboration, and model routes. |
| `pi-research-agent/schemas/v2.0/*` | SDK/RPC v1 request, response, and capability schemas. |
| `pi-research-agent/package.json` | Package metadata. |
| `@research-agent/contracts` and documented subpaths | Compiled data-only contracts for projects, Adapters, JSONL messages, exchange, collaboration, model routes, canonical JSON, hashing, SDK/RPC, and validation. |

The v1 compatibility promise covers backward reading of published 1.x minor records, direct migration from 0.1–1.1 projects, Adapter contract v1, and the machine-readable `ResearchResult` envelope. A security fix may reject input that an older validator accepted; release notes must identify the tightened rule.

## Built-in integration boundary

Provider implementations, project storage/mutation, migration, backup, routing, exchange, Domain Package resolution, Adapter conformance/registration/runner, and access-policy implementation are internal. Third-party packages implement the frozen interfaces from `@research-agent/contracts/adapters` and communicate through the JSONL protocol instead of importing source files or provider implementations.

## Extension boundary

The Pi package loads `extensions/research.ts`, registers fourteen governed aggregate Tools and sixteen research administration commands plus `/research-version`, and stores only a project link in Pi Session entries. Command results use the same `ResearchResult` shape as Tools. The SDK/RPC subset exposes project open/validate/doctor and record list/read operations for explicitly configured projects, redacts host paths by default, and advertises supported evidence-submission levels. Backup, migration, transaction, Adapter registration, exchange, collaboration merge, and all other mutations remain Pi-governed internal surfaces.

## Change process

A breaking public contract, project-schema major, or default security-policy change requires an accepted RFC, migration and rollback documentation, compatibility fixtures, and a major version. New optional fields may be added in a minor version when old readers can preserve them without semantic reinterpretation.
