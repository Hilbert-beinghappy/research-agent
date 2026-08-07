# Public contracts v2.0

`@research-agent/contracts` is the data-only contract package. It contains TypeScript types, TypeBox runtime schemas, canonical JSON helpers, SHA-256 helpers, and validators. It performs no filesystem write, network request, model call, or Adapter execution.

## Published entry points

| Entry point | Stable surface |
|---|---|
| `@research-agent/contracts` | All public contract exports. |
| `@research-agent/contracts/adapter-protocol` | JSONL request, broker-request, broker-response, result, and protocol-error schemas. |
| `@research-agent/contracts/adapters` | Source, Analysis Runtime, and Artifact Adapter v1 interfaces and request/result schemas. |
| `@research-agent/contracts/canonical-json` | Canonical JSON normalization and serialization. |
| `@research-agent/contracts/integrity` | SHA-256 byte and canonical-value hashing. |
| `@research-agent/contracts/schemas` | Persisted project, Adapter package, exchange, collaboration, and model-route schemas and types. |
| `@research-agent/contracts/sdk-rpc` | SDK/RPC v1 methods, request/response envelopes, and capability schema. |
| `@research-agent/contracts/validators` | Runtime validation of persisted records and result envelopes. |

`pi-research-agent` and `pi-research-agent/contracts` re-export the compiled canonical project contracts for existing callers. New third-party Adapters should depend only on `@research-agent/contracts`. Neither package exports its internal `src` tree.

Canonical project JSON Schemas remain under `schemas/v1.5`; the current project schema is 1.5.1. SDK/RPC protocol schemas are published under `schemas/v2.0` in both packages. Package v2.0 introduces no project schema 2.0 migration. Compiled modules and generated schemas are shipped for consumers; TypeBox source remains the repository authority.

## Frozen Adapter contract v1

The public Adapter categories are:

- `SourceAdapterV1`: `capabilities`, `healthCheck`, `search`, and `lookup`.
- `AnalysisRuntimeAdapterV1`: `capabilities` and `execute`.
- `ArtifactAdapterV1`: `capabilities` and `render`.

The process protocol invokes `capabilities` followed by the category operation: `search`, `execute`, or `render`. Every operation returns the canonical `ResearchResult` success/failure semantics through a JSONL `result` message. External effects are declared as Host broker requests, not performed through the public contract itself.

Contract v1 freezes field meaning, required methods, error-envelope semantics, package and canonical-manifest identity in conformance reports, and the four broker names: `http`, `credential`, `project_read`, and `staged_output`. Additive optional capabilities may appear in a compatible release. Removing or reinterpreting a v1 field requires a new Adapter contract major.

## Project and evidence contracts

The project schema keeps these states distinct:

- bibliographic metadata;
- abstract material;
- acquired full text;
- located evidence with an exact excerpt and locator;
- citation verification.

No Adapter result can promote one state into another without the corresponding canonical record and deterministic validation. `ResearchResult` explicitly separates success, partial success, retryable/permanent failure, permission block, external-service failure, and data conflict.

Project schema versions and package contract versions are related release facts, not a guaranteed one-to-one mapping. A v1.5 exchange manifest records the exact project schema it carries; callers must still use the project migration and compatibility APIs.

## SDK/RPC contract v1

The documented v2.0 SDK/RPC subset has seven inspection methods over project roots configured at process startup. Requests identify projects by canonical project ID and cannot supply a path. SDK and stdio RPC share one dispatcher and one `ResearchResult` envelope. Canonical writes, migrations, approvals, Adapter registration, exchange, collaboration merge, and submission remain on Pi-governed surfaces.

Capability version 2 reports whether host paths are redacted and separates supported evidence submission (`metadata`, `abstract`, `fulltext_unlocated`, `fulltext_located`) from schema-reserved levels that the current Host rejects (`table_or_figure_located`, `dataset_or_appendix_located`).

## Compatibility process

Published v1 project records remain readable through the v1 release line. A security correction may reject input accepted by an older validator, but the tightened rule and migration impact must be documented. Public contract changes require generated-schema review, conformance fixtures, release-package scanning, and an upgrade note.
