# v2.0 release boundary

v2.0 makes the local Research Agent installable as a Pi Package with a documented multi-project SDK and optional local stdio RPC facade. The Pi terminal remains the complete product surface for governed research workflows; SDK/RPC supplies a narrow inspection interface for external clients.

## Stable scope

- `pi-research-agent` 2.0.0 and `@research-agent/contracts` 2.0.0 under Apache-2.0.
- Canonical project schema 1.5.0; no schema 2.0 migration was introduced because no validated breaking need was found.
- Seven SDK/RPC v1 inspection methods over explicitly configured projects.
- Frozen core record envelopes, IDs, revisions and audit fields; Result/Error; Operation/Approval; Adapter v1; sandbox protocol v1; Exchange v1; migration compatibility policy.
- Multiple local projects in one SDK/RPC process without a database or second canonical store.
- File exchange and record-only collaboration from v1.5 remain available through governed Pi/library surfaces, not through the stable RPC subset.

## Release evidence

The v2.0 gate runs public type/schema tests, SDK/RPC parity and malformed-request tests, all historical migration replays, two management/public-administration project exchange replays, the public third-party Source Adapter, and the full v0.1–v1.5 regression set. Each project replay creates a separate canonical project, packs and imports it, validates it, and preserves a distinct artifact hash. The public full-workflow guide reuses the Scenario A, quantitative, qualitative, manuscript, and knowledge-delivery fixtures instead of inventing a second fixture system. On macOS, Scenario E verifies that Host approval precedes brokered HTTP success and that denial or Adapter crash leaves project validation usable. The existing strong-isolation qualification separately denies direct network, private reads, project writes, credential access, and subprocess execution.

Release qualification packs the Agent and contracts packages twice and requires identical entry manifests and tarball bytes; the release-candidate check is replayed after the committed baseline is present so the package closure is stable. Clean-install tests act as independent consumer probes by loading the Pi Package, SDK, and RPC executable from tarballs against Pi 0.83.0 and 0.84.0. The public community Source Adapter acts as the third-party developer probe and imports only `@research-agent/contracts`. Release scans require licenses, notices, SBOM, security/governance material, schemas, examples, and evaluation baselines while rejecting private configuration, credentials, personal paths, tests, and unreviewed Skills.

The recorded `deepseek-v4-flash` boundary evaluation is supplementary evidence for routing behavior. Deterministic tests, not the model's self-report, enforce permissions, hashes, schemas, migration, and project integrity.

These are synthetic or recorded, redistribution-safe release fixtures. They establish package, recovery, evidence-boundary, and extension behavior; they do not claim an independent human usability study, external empirical validity, or journal readiness.

## Upgrade and rollback

Upgrade the npm packages together because `pi-research-agent` 2.0.0 depends on `@research-agent/contracts` 2.0.0. Existing schema 1.5.0 projects open without migration. A full project backup remains required before any future project-format migration, but this package upgrade itself writes no migration journal.

Rolling the package back to v1.5 removes SDK/RPC v1 but leaves schema 1.5.0 project files readable. Exchange and Adapter records remain part of the 1.5 schema. Keep the package tarball, lockfile, project snapshot, and release verification output when reproducibility matters.

## Security and platform limits

- Unknown third-party Adapter registration remains: static inspection, explicit approval, strong-isolation conformance, then registration.
- Strong Adapter isolation is shipped only on macOS. Linux and Windows support the JSONL protocol and deterministic SDK/RPC tests but must not describe `jsonl_process` as a sandbox.
- Brokered HTTP is subject to Host policy and approval. Credentials never enter the Adapter request.
- Default Exchange excludes raw/restricted material, credentials, Pi Session state, and internal runtime state; derived notes and artifacts still require user review for sensitivity.
- The SDK/RPC process trusts its host user and explicitly configured roots. It is not an operating-system security boundary.

## Not included

v2.0 does not ship hosted SaaS, accounts, a network RPC server, a required Web/desktop UI, a hosted vector database, real-time CRDT collaboration, a general multi-Agent platform, automatic email/submission/publication, Linux/Windows strong sandboxing, or a plugin marketplace. Proprietary databases and commercial runtimes remain user-installed, policy-governed Adapters.
