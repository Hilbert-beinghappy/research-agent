# Exchange and file collaboration v1

v1.5 adds portable directory bundles. It does not add a database, hosted sync service, message queue, CRDT, or remote execution.

## Exchange Bundle

An exchange directory contains:

```text
bundle.json
files/
  research-project.json
  .research/records/...
  notes/...
  artifacts/...
```

`packProjectExchange` requires a current project with no pending transaction or migration and a destination that does not exist. It copies regular files through a staging directory, verifies every SHA-256 value, writes the manifest, and atomically renames the bundle. `unpackProjectExchange` verifies the manifest and every file, rebuilds empty canonical directories, validates that the imported project opens, and renames only into a new destination.

Default bundles include the manifest, canonical records, parsed sources, notes, and artifacts. They exclude raw originals/imports, backups, caches, locks, migrations, runs, transactions, Pi Session state, runtime state, and secrets. `--include-raw` adds `sources/originals` and `sources/imports`; it never includes credentials or Pi Session files.

Canonical records, notes, and artifacts may themselves contain sensitive excerpts or derived participant material. The default exclusion list is not automatic content classification or redaction. Review the manifest and project content before sharing.

The unsigned `rootHash` binds the file list, per-file hashes, and sizes. It detects file-content or file-list changes but does not authenticate every manifest metadata field. An optional Ed25519 signature authenticates the complete manifest except its signature field. Trust in a signing key is a user/host policy decision.

For active registrations, the manifest records exact Adapter package IDs, versions, file-closure hashes, and canonical manifest hashes. An optional unavailable Adapter may carry `null` hashes and cannot be activated from that reference alone. The imported project remains readable; the missing capability is reported rather than replacing canonical state.

## Pi command governance

```text
/research-exchange pack ./project.exchange
/research-exchange pack --include-raw ./project-with-raw.exchange
/research-exchange unpack {"bundle":"./project.exchange","destination":"./imported-project"}
```

Packing or unpacking through the Pi command is an external write and requires interactive, destination-bound approval. Non-interactive use returns `PERMISSION_BLOCKED`. Direct TypeScript library calls perform deterministic file work but do not create user consent; the embedding application owns the equivalent governance boundary.

## Collaboration ChangeSet

A ChangeSet transports selected canonical record files plus the successful author Operation. It records the project ID, base manifest revision, base hash, proposed hash, record revision, paths, and a root hash. Approval, Adapter registration, exchange, collaboration-merge, and arbitrary Operation records cannot be selected directly.

Merge rules are deterministic:

- an identical proposed hash is skipped;
- a missing record with a `null` base hash can be added;
- a matching base hash with the next record revision can be replaced;
- any divergent base is a conflict.

If one selected record conflicts, none of the proposed research records are applied. The conflict is stored as a `CollaborationMergeRecord` for manual resolution. A successful merge commits all selected records and the merge record in one project transaction.

ChangeSets are record-only. Share referenced immutable files first through an Exchange Bundle or another approved channel; a ChangeSet does not silently copy or fetch them.
