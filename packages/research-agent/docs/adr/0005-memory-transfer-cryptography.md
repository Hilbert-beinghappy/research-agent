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

The export snapshot includes profile and policy plus allowed signals, items, feedback, receipts, and audit records. It excludes Session content, Project content, restricted source references by default, credentials, keys, caches, locks, and pending transactions.

## Import order and rollback

1. Enforce archive byte, file-count, entry-size, compression-ratio, and canonical-path limits before decrypting content.
2. Validate the fixed outer envelope and supported algorithm parameters.
3. Derive the KEK, unwrap the DEK, authenticate the inner manifest, then authenticate every file.
4. Validate plaintext hashes, root hash, schemas, paths, profile identity, lineage, and revision monotonicity in staging.
5. Snapshot the local profile and atomically exchange directories only after every check passes.
6. On any failure, leave the local profile root unchanged and mark staging rejected or rolled back without sensitive error detail.

Wrong passphrases and tampering return the same authentication-failure class. Same-lineage imports are fast-forward only; a fork remains in staging with a deterministic conflict report. A different profile ID creates a separate profile and is never auto-merged. Reimport of an identical snapshot is idempotent.

## Dependency and compatibility boundary

Implementation uses the Node.js cryptographic standard library and introduces no cryptography dependency. Envelope or KDF parameter changes require a new envelope version, published cross-platform test vectors, migration documentation, and a new ADR. Readers reject unknown versions rather than guessing.

## Verification

Required vectors cover correct import on macOS/Linux/Windows, wrong passphrase, ciphertext/tag/AAD tampering, nonce uniqueness, traversal, case collision, decompression bomb, oversized entry, duplicate import, lineage fork, interruption before exchange, and interruption during rollback. Any key leakage, unauthenticated plaintext, path escape, or local-root mutation on rejected import is `NO_GO`.
