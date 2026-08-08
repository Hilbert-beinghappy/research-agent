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
| delete | Remove semantic revisions and related semantic signal/feedback/receipt fields; retain an irreversible minimal tombstone | Excluded from cache, dry-run retrieval, context, and every export |
| restore | Re-run safety checks and create a new revision from recoverable forgotten state | Included only after successful activation |

The minimal delete tombstone contains only the item ID, hashes needed to prevent accidental resurrection, deletion time, lineage, and a non-semantic reason code. It contains no preference value, free-text rationale, project title, host path, excerpt, prompt, or credential.

Deletion is a synchronous writer transaction. It enumerates canonical files rather than trusting an index, invalidates caches before commit completes, removes semantic references from signals, feedback, receipts, and pending export manifests, writes the tombstone, and updates the profile root last. A crash leaves either the old verified root or a recoverable pending transaction; it cannot expose a mixed committed state.

`verify-delete` must check:

1. latest canonical item state and every prior revision path;
2. signals, feedback, receipts, audit payloads, and transfer manifests for semantic residue;
3. active and retrieval indexes;
4. retrieval and context-build dry runs;
5. plaintext and encrypted export manifest dry runs;
6. profile root integrity and pending transactions.

The report records checked classes, tombstone hash, profile root hash, and pass/fail, but never repeats deleted semantics.

## Restoration boundary

Forgotten state may be restored explicitly when retained content is still permitted. Deleted state is terminal within the lineage. A verified transfer may create a new lineage and new item ID after import policy review; it cannot flip the deleted revision back to active or reuse its tombstone identity.

## Physical deletion limitation

The product guarantees deletion from normative state, ordinary files, application paths, indexes, context, and exports. Filesystems, snapshots, backups outside Doro, and SSD wear levelling prevent an application-level guarantee of forensic media erasure. This limitation must appear in the command result and user documentation.

## Verification

Tests must inject crashes at every transaction boundary, corrupt caches, stage an export before deletion, duplicate semantic text across record classes, and attempt restoration or transfer replay. Any post-delete semantic residue or retrieval/export reuse is `NO_GO`.
