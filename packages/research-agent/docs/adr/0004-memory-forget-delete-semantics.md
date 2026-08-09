# ADR 0004: Personal Memory correction, forgetting, and deletion

- Status: accepted for implementation
- Created: 2026-08-08
- Target release: 3.0.0-beta.1

## Problem

An item can exist in canonical revisions, raw signals, feedback, receipts, caches, context, and transfer manifests. Removing it from one index does not prove that it is no longer used or exported. Correction and forgetting also need distinct audit and restoration behavior.

## State transitions

| Action | Canonical result | Retrieval/export result |
|---|---|---|
| correct | Create a new active revision; mark the old revision superseded | Old revision is removed from cache in the same transaction |
| reject | Create a forgotten tombstone for the inferred item | Immediately excluded |
| downrank | Create a new revision with lower confidence or narrower scope | Recomputed from the new revision only |
| forget | Mark forgotten; retain only policy-permitted restricted local audit | Excluded from active index, context, and export |
| delete | Remove semantic revisions and related semantic signal/feedback/receipt fields; retain an irreversible minimal tombstone | Excluded from cache, dry-run retrieval, context, and future exports from current normative state |
| restore | Re-run safety checks and create a new revision from recoverable forgotten state | Included only after successful activation |

The minimal delete tombstone contains only the item ID, hashes needed to prevent accidental resurrection, deletion time, lineage, and a non-semantic reason code. It contains no preference value, free-text rationale, project title, host path, excerpt, prompt, or credential.

Deletion uses two ordered writer transactions. The first enumerates canonical files rather than trusting an index, invalidates caches before commit completes, removes semantic references from signals, feedback, receipts, and pending export manifests, writes the tombstone, records `exportExclusionVerifiedAt: null`, and updates the profile root last. Only after that transaction commits does Doro perform the real deletion checks. The second transaction appends an immutable pass/fail `MemoryDeletionVerificationV1` under `audit/YYYY/MM/`; its committed journal binds the record path, content hash, profile, revision, and transaction ID, and it never rewrites the deletion feedback. A crash during the first transaction leaves either the old root or a recoverable pending transaction. A failure after the first commit cannot roll deletion back or be reported as if it did.

`verify-delete` must check:

1. latest canonical item state and every prior revision path;
2. signals, feedback, receipts, audit payloads, and transfer manifests for semantic residue;
3. active and retrieval indexes;
4. retrieval and context-build dry runs;
5. plaintext and encrypted export manifest dry runs;
6. profile root integrity and pending transactions;
7. the committed local deletion transaction journal containing the exact tombstone and applied-delete feedback paths and hashes.

The attestation records its ID, profile and memory IDs, the deletion transaction ID, its own committing transaction ID, the checked profile revision, check time, checked classes, tombstone hash, profile root hash, sorted residue codes, pass/fail, and the physical-deletion limitation. Its strict schema has no original value, host path, record path, excerpt, prompt, or other semantic field. A verified record must list every checked class in canonical order and have no residue codes. A failed record lists only the canonical-order subset actually checked and at least one residue code; an unavailable check cannot claim the full checklist. Canonical loading binds each tombstone to exactly one applied delete feedback, rejects any item, extra feedback, receipt, provenance reference, or export manifest that reintroduces its deleted paths, hashes, or identifiers, and binds each local attestation to that tombstone plus its committed journal. Generic writers enforce the same terminal boundary under the writer lease; applied-delete feedback can only be written atomically by `deletePersonalMemory`. A failed check returns `committed: true` with a persisted failed attestation and is surfaced as `PARTIAL_SUCCESS` with `MEMORY_DELETE_VERIFICATION_FAILED`. If the attestation itself cannot be persisted, the committed deletion is returned as `PARTIAL_SUCCESS` with `attestationRecorded: false` and `MEMORY_DELETE_COMMITTED_UNVERIFIED`; callers must not retry the already committed deletion.

`/memory verify-delete <memory-id>` repeats the checks and appends another immutable attestation when a deletion tombstone supplies the deletion transaction binding. It does not restore data, broaden access, or create an attestation for a memory with no deletion tombstone.

## Restoration boundary

Forgotten state may be restored explicitly when retained content is still permitted. Deleted state is terminal within the lineage. A verified transfer may create a new lineage and new item ID after import policy review; it cannot flip the deleted revision back to active or reuse its tombstone identity.

Deletion does not create a permanent blacklist for source/session text or broad semantic similarity. Stable signal identifiers and canonical deletion hashes block replay of the deleted records; a genuinely independent future observation may be learned as a new record under the ordinary policy gates.

## Physical deletion limitation

The product guarantees deletion from current normative state, ordinary files, application paths, indexes, context, and future export previews. Bundles or copies exported before deletion, filesystems, snapshots, backups outside Doro, and SSD wear levelling remain outside the application guarantee. This limitation must appear in the command result and user documentation.

## Verification

Tests must inject crashes at every transaction boundary, corrupt caches, stage an export before deletion, duplicate semantic text across record classes, and attempt restoration or transfer replay. Any post-delete semantic residue or retrieval/export reuse is `NO_GO`.
