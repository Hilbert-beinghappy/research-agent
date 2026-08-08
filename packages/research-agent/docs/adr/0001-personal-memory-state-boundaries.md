# ADR 0001: Personal Memory state boundaries

- Status: accepted for implementation
- Created: 2026-08-08
- Target release: 3.0.0-beta.1

## Problem

Long-lived preferences are useful across Pi Sessions and Research Projects, but storing them in either state would conflate conversation history, research facts, and user-level personalization. That would make deletion, portability, restricted-project isolation, and recovery unverifiable.

## Decision

Five state classes have independent authorities and lifecycles.

| State | Canonical authority | Allowed references | Prohibited use |
|---|---|---|---|
| Pi Session | Pi Host Session state | Opaque references to a Project or Memory receipt | Research evidence or automatic long-term memory |
| Research Project | Project manifest, records, artifacts, and transactions | Verified sources, evidence, analyses, and artifacts | Personal profile storage or preference-as-fact promotion |
| Personal Memory | Profile, policy, signals, candidates, items, feedback, receipts, audit, and transfer manifests | Logical and hash-only references to safe Session, Project, or artifact observations | Restricted project text, credentials, or reverse writes into a Project |
| Team Memory | A separate v4 workspace | Explicit publication receipts and team changesets | Automatic copies of Personal Memory or personal raw signals |
| Derived index/cache | The owning store's cache directory | Query acceleration only | State decisions, export authority, deletion proof, or migration authority |

Personal Memory uses a separate logical root resolved by the Host. Paths never enter receipts, RPC responses, or transfer manifests; external surfaces use locators such as `profile:<id>`.

```text
<DORO_HOME>/profiles/<profile-id>/
  profile.json
  policy.json
  signals/YYYY/MM/
  candidates/
  items/<category>/<memory-id>/<revision>.json
  feedback/YYYY/MM/
  receipts/YYYY/MM/
  audit/YYYY/MM/
  transfer-manifests/
  transactions/{pending,committed,failed}/
  locks/writer.lock
  cache/
```

Canonical JSON, schema validation, SHA-256 content hashes, a single writer lease, staged transactions, and atomic rename govern normative state. Signals, feedback, receipts, and audit events are immutable append records. Item revisions only increase; older revisions are never edited in place. Caches carry `basedOnProfileRevision` and are discarded when it differs from canonical state.

Restricted references retain only the highest sensitivity class, an irreversible content hash, and a logical identifier. They never retain a title, host path, excerpt, document body, or generated summary.

## Failure and degradation

- A missing Personal Memory root yields v2.0.1 behavior with no personalization.
- Cache corruption causes deterministic rebuild from canonical state.
- Canonical Memory corruption opens read-only recovery and disables personalization; Research Project operations continue.
- A failed transaction or transfer import leaves the prior profile root unchanged.
- Team and provider directories are not created by v3.

## Compatibility and non-goals

This decision does not change Project schema 1.5.1, Pi Session format, Research RPC v1, or SDK capability v2. It does not add a vector database, full-text semantic search, cloud sync, Team Memory, provider grants, or a background service.

## Verification

The threat map owns corruption-isolation, cross-store write, cache-staleness, and restricted-reference tests. Beta qualification must demonstrate that removing or corrupting Personal Memory does not change Project validation or availability.
