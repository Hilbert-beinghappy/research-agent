# Install, upgrade, and recovery

## Install

Requirements are Node.js 22.19.0 or newer and a supported Pi package. From a source checkout:

```sh
npm ci --ignore-scripts
pi -e /path/to/pi-research-agent
```

Start Pi inside an empty project directory, run `/research-version`, then `/research-init "title"`. Review the package before loading it: Pi Extensions run in the host process.

The v3.0.0-beta.1 technical candidate qualifies Pi npm packages 0.83.0 and 0.84.0. The authoritative tested matrix is `docs/compatibility/pi-baselines.json`; an unlisted Pi main commit is not implicitly supported. The clean-install probes load the Pi Extension, the inspection-only SDK, and the local stdio RPC executable from packed tarballs.

## Upgrade a project

1. Stop project writes and run `/research-doctor` on the old installation.
2. Create a user backup if desired; migration creates its own verified backup.
3. Install the new package without changing the research project.
4. Open the supported v0.1–v1.5.0 project. It remains read-only and reports `migration_required`. Schema 1.5.1 opens directly.
5. Run `/research-migrate` in an interactive Pi terminal and approve the exact schema transition.
6. Run `/research-doctor`, `/research-validate`, `/research-status full`, and `/research-resume`.

Migration adds missing record-set declarations/directories and a default built-in Domain Package reference when needed. The 1.5.1 step also snapshots and rewrites legacy evidence/claim provenance, using `unknown_legacy` rather than guessing. It is idempotent after success.

Package rollback must use a package version that explicitly supports schema 1.5.1; an older 1.5.0-only runtime opens the newer schema read-only. Keep the package tarball, lockfile, and a verified project backup when an exact runtime rollback must be reproducible.

## Interrupted upgrade

- A staged migration that never became pending is discarded and prepared again.
- A pending migration resumes from its hash-verified journal.
- A project already carrying the v1.5 manifest but a pending journal completes the journal move on retry.
- An active or stale migration lock causes `MIGRATION_LOCKED`; inspect the process and doctor report. Do not delete a lock until the writer is known to be stopped and the project has been backed up.
- Hash conflict, missing file, or a newer unsupported schema keeps the project read-only and requires user-directed repair; no canonical record is silently regenerated.

## Clean-install qualification

```sh
npm run test:clean-install -w packages/research-agent
npm run test:clean-install:latest -w packages/research-agent
npm run test:compat -w packages/research-agent
```

The first lane uses the pinned Pi baseline; the second uses the latest tested stable Pi release. Both pack the package and load it in a clean temporary install. CI repeats supported behavior on Ubuntu, macOS, and Windows.

Third-party Adapter registration is a separate platform gate. Ordinary JSONL conformance and SDK/RPC run cross-platform. Strong registration uses macOS Seatbelt or Linux bubblewrap and blocks on Windows without downgrade.
