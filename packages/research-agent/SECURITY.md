# Security policy

## Supported versions

The current v1.x release line receives security fixes. v0.x project formats remain migration inputs but the v0.x package lines are not supported runtimes.

## Reporting

Report vulnerabilities through the repository's private security-advisory channel. Do not open a public issue for an unpatched vulnerability and do not attach credentials, private papers, participant data, or research-project files. Include the affected package version, operating system, a minimal synthetic reproduction, and the expected impact.

## Security boundary

Pi packages execute in the host process. The policy engine, approval ledger, governed file transactions, and HTTP broker reduce accidental or model-initiated misuse, but they do not isolate malicious Pi Extensions, compromised built-in code, a compromised host, or a user who edits project files outside Pi. Third-party Adapter v1 execution uses a separate JSONL process; governed registration additionally requires the tested macOS strong-isolation profile. Ordinary process separation is not an OS sandbox, and unsupported strong-isolation platforms block rather than downgrade.

The package does not store provider secrets in project state. Credentials are resolved from configured environment aliases for the duration of a request. Project exports and backups must still be reviewed because canonical records can contain research metadata, excerpts, local filenames, participant material, and user-authored text.

See `docs/threat-model.md` for the v1.5 threat model, sensitive-project defaults, and non-goals. Do not load unknown code as a Pi Extension or built-in Adapter. For third-party Adapter v1 packages, use static inspection, exact-hash approval, successful strong conformance, and Host-mediated effects.
