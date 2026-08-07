# Security policy

## Supported versions

The current v2.x release line receives security fixes. Published v1.x project formats remain readable or supported migration inputs, but superseded package lines are not supported runtimes.

## Reporting

Report vulnerabilities through the repository's private security-advisory channel. Do not open a public issue for an unpatched vulnerability and do not attach credentials, private papers, participant data, or research-project files. Include the affected package version, operating system, a minimal synthetic reproduction, and the expected impact.

## Security boundary

Pi packages execute in the host process. The policy engine, model-visible payload gate, approval ledger, single-writer project transactions, and HTTP broker reduce accidental or model-initiated misuse, but they do not isolate malicious Pi Extensions, compromised built-in code, a compromised host, or a user who edits project files outside Pi. Third-party Adapter v1 execution and confirmed analysis scripts use macOS Seatbelt or Linux bubblewrap strong isolation when available. Windows blocks strong isolation; analysis may run with host-user authority only after the existing unknown-code or commercial-runtime approval explicitly accepts that fallback. Ordinary process separation is not an OS sandbox.

SDK/RPC v1 is a local inspection facade over explicitly configured project roots. It opens no socket, exposes no mutation method, and redacts host paths by default; `includeHostPaths`/`--include-host-paths` is an explicit local-host opt-in. It is not an authentication boundary against the host user. PDF parsing rejects documents that declare JavaScript actions and remains an untrusted-input boundary despite the fixed PDF.js dependency.

The package does not store provider secrets in project state. Credentials are resolved from configured environment aliases for the duration of a request. Project exports and backups must still be reviewed because canonical records can contain research metadata, excerpts, local filenames, participant material, and user-authored text.

See `docs/threat-model.md`, `docs/security-waivers.json`, and `docs/release-checklist.md` for the current threat model and release gates. Do not load unknown code as a Pi Extension or built-in Adapter. For third-party Adapter v1 packages, use static inspection, exact-hash approval, successful strong conformance, and Host-mediated effects.
