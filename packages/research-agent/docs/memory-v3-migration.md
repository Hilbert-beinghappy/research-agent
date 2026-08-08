# Personal Memory v3 migration and rollback

## Version boundary

`pi-research-agent@3.0.0-beta.1` uses `@research-agent/contracts@2.1.0`, Personal Memory schema `1.0.0`, Research Project schema `1.5.1`, SDK capability v2, and RPC wire v1. Upgrading from the v2.0.1 package does not migrate or rewrite a Research Project. Personal Memory is a new, physically separate profile store and is created only after interactive confirmation.

No Session transcript, Project record, document, evidence, claim, credential, host path, or prior exported artifact is automatically imported into Personal Memory. Unknown profile schema versions and malformed records fail closed to read-only/degraded memory while Project work continues without personalization.

## Upgrade

1. Preserve the v2.0.1 package/lockfile and a verified Project backup.
2. Install the exact beta candidate and verify `/research-version` reports `3.0.0-beta.1`.
3. Run the no-memory path first with `DORO_MEMORY_MODE=off`; Project manifests and root hashes must remain unchanged.
4. If opting in, create one profile through `/memory status`, inspect its empty state, then add only explicit low-risk preferences.
5. Keep encrypted transfer artifacts outside the profile root. Import accepts only authenticated v1 bundles into an empty profile or a validated same-lineage fast-forward.

There is no in-place Personal Memory schema migration in this beta because `1.0.0` is the first profile schema. A future schema change requires a new ADR, a pre-migration authenticated snapshot, before/after root hashes, interruption recovery tests, and an explicit migration command. Readers must reject unknown versions rather than guess.

## Rollback

Set `DORO_MEMORY_MODE=off`, stop Pi, and reinstall the preserved v2.0.1 package. The older package ignores the separate v3 profile; it must not delete or reinterpret it. Research Projects stay on schema `1.5.1` and require no downgrade.

Retain, export, or delete Personal Memory only through an explicit user decision. Item deletion and `verify-delete` remove semantic data from normative profile state, indexes, context, and exports, but cannot promise forensic erasure from external backups, filesystem snapshots, or SSD wear levelling. A full-profile exit procedure and data-controller approval are prerequisites for starting the real beta pilot.

Rollback does not authorize a tag, publication, force push, schema rewrite, Project restore over a non-empty destination, or removal of user data.
