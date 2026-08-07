# Backup and restore

## Create and inspect

```text
/research-backup create "before analysis revision"
/research-backup list
```

A backup contains `research-project.json`, the project README, canonical `.research` state, project-local sources, notes, and artifacts. It excludes nested backups, caches, locks, AppleDouble sidecars, and non-regular files. Creation acquires the project writer lease and is refused while a transaction or migration is pending, so its manifest revision and file inventory form one stable snapshot.

`backup.json` records every project-relative path, byte count, SHA-256 hash, project ID, schema, revision, and a root hash over the ordered file inventory. Backups live under `.research/backups/committed/<backup-id>/`; copying that directory to separate storage is the user's disaster-recovery step.

## Restore

```text
/research-restore <backup-id> restored-project
```

The destination must differ from the source and be empty. Restore checks the backup schema and root hash, verifies every stored file before copying, rebuilds the required empty project-directory skeleton, recomputes the restored root hash, and checks the project ID before success. It never overlays an existing project.

After restore:

```text
/research-open restored-project
/research-doctor restored-project
/research-validate
/research-resume
```

A successful local restore proves byte-for-byte recovery from that backup. It does not prove that the same physical disk, external provider, Python/R environment, Zotero library, or commercial Stata installation will remain available.

## Migration rollback

Every supported older-to-1.5.1 migration creates a full backup automatically. `/research-migrate rollback <migration-id>` verifies its backup and before/after record snapshots, then restores the pre-migration state only if no later project write occurred. When later writes exist, rollback is refused; restore the backup into a new empty directory instead.
