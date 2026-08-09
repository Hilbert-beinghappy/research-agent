# ADR 0005: Encrypted Personal Memory transfer

- Status: accepted for implementation
- Created: 2026-08-08
- Target release: 3.0.0-beta.1

## Problem

Personal Memory is user-level state and must not be copied through a Research Project, cloud service, or plaintext archive. Cross-machine transfer needs confidentiality, integrity, bounded parsing, lineage conflict rules, and rollback without storing a passphrase or key.

## Decision

The only v3 transfer is a user-created offline file with format `doro-memory-transfer`, envelope version 1.

- KDF: scrypt with a random bundle salt, `N=131072`, `r=8`, `p=1`; implementations set a bounded 256 MiB `maxmem` so the fixed parameters are both executable and resource-limited.
- Content cipher: AES-256-GCM.
- Key hierarchy: scrypt derives a KEK; a random 256-bit DEK encrypts content; the KEK only wraps the DEK.
- Nonces: every wrapped key, manifest, and content file uses a distinct random 96-bit nonce under its key.
- Manifest: the inner manifest is encrypted. The outer envelope exposes only version, algorithm parameters, wrapped-DEK fields, encrypted-manifest locator/hash, and ciphertext root hash.
- AAD: envelope version, canonical ciphertext path, and expected plaintext hash are authenticated for each encrypted entry.
- Secrets: passphrases and raw KEK/DEK values are never written to Session, Project, profile, receipt, logs, bundle, crash report, or command history. Buffers are cleared on a best-effort basis after use.

The version 1 file is canonical JSON. Its top level is the fixed envelope plus a sorted `entries` array containing only opaque ciphertext paths and base64 ciphertext. Each entry stores the 16-byte GCM tag before its ciphertext. Content paths are fixed `content/NNNNNNNN.bin`; the encrypted inner manifest is `manifest.bin`. The ciphertext root authenticates the sorted path/hash pairs. Unknown fields, unknown versions, non-canonical JSON, duplicate or case-colliding paths, and compression metadata are rejected.

Version 1 deliberately has no compression. This removes the decompression-bomb surface instead of attempting to estimate a compression ratio. Pre-decryption limits are 64 MiB per bundle, 20,000 plaintext files, 4 MiB per content entry, 8 MiB for the encrypted manifest, and 32 MiB total plaintext.

The export snapshot includes profile and policy plus allowed signals, items, feedback, receipts, and the portable audit class. In version 1 that audit class carries deletion tombstones, but `MemoryDeletionVerificationV1` records and their committed journals remain local-only until transfer has a verifiable provenance chain. Version 1 does not transfer or reconstruct the source deletion journal: an imported terminal pair prevents resurrection, while `/memory verify-delete` records a local failed/unproven check with `deletion_binding_mismatch`; it cannot claim verified source lineage or fabricate local provenance. The snapshot excludes Session content, Project content, restricted source references by default, credentials, keys, caches, locks, and pending transactions.

## Import order and rollback

1. Enforce archive byte, file-count, entry-size, compression-ratio, and canonical-path limits before decrypting content.
2. Validate the fixed outer envelope and supported algorithm parameters.
3. Derive the KEK, unwrap the DEK, authenticate the inner manifest, then authenticate every file.
4. Validate plaintext hashes, root hash, schemas, paths, profile identity, lineage, and revision monotonicity in staging.
5. Snapshot the local profile and atomically exchange directories only after every check passes.
6. On any failure, leave the local profile root unchanged and mark staging rejected or rolled back without sensitive error detail.

Wrong passphrases and tampering return the same authentication-failure class. Same-lineage imports are fast-forward only; a fork remains in staging with a deterministic conflict report. A different profile ID creates a separate profile and is never auto-merged. Reimport of an identical snapshot is idempotent.

Normal profile writers check a transfer barrier before and after taking the writer lease; readers disable personalization while that barrier exists. Import validates a same-filesystem staging profile first, records the snapshot manifest there, then performs the directory exchange under an external per-profile lease. A canonical external journal recovers interruption before exchange, between the two renames, during rollback, or after the commit point. Same-lineage fast-forward requires a greater profile revision and every local portable record to be byte-identical in the incoming snapshot or covered by an authenticated deletion tombstone. A local terminal tombstone and its uniquely bound applied-delete feedback are stricter: both must be present byte-for-byte in the incoming snapshot and can never be replaced through tombstone coverage. An idempotent replay preserves the original local root and journals; a non-idempotent merge conflicts when local deletion-verification audit exists rather than copying or silently discarding evidence without its journal. The old root remains available until the validated replacement commits.

## Dependency and compatibility boundary

Implementation uses the Node.js cryptographic standard library and introduces no cryptography dependency. Envelope or KDF parameter changes require a new envelope version, published cross-platform test vectors, migration documentation, and a new ADR. Readers reject unknown versions rather than guessing.

## Verification

Required vectors cover correct import on macOS/Linux/Windows, wrong passphrase, ciphertext/tag/AAD tampering, nonce uniqueness, traversal, case collision, decompression bomb, oversized entry, duplicate import, lineage fork, interruption before exchange, and interruption during rollback. Any key leakage, unauthenticated plaintext, path escape, or local-root mutation on rejected import is `NO_GO`.
