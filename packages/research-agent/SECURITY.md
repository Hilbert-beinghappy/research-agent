# Security policy

## Supported versions

The current v1.x release line receives security fixes. v0.x project formats remain migration inputs but the v0.x package lines are not supported runtimes.

## Reporting

Report vulnerabilities through the repository's private security-advisory channel. Do not open a public issue for an unpatched vulnerability and do not attach credentials, private papers, participant data, or research-project files. Include the affected package version, operating system, a minimal synthetic reproduction, and the expected impact.

## Security boundary

Pi packages execute in the host process. The policy engine, approval ledger, governed file transactions, and HTTP broker reduce accidental or model-initiated misuse, but they do not isolate malicious Pi Extensions, malicious in-process Adapters, a compromised host, or a user who edits project files outside Pi. Use OS-level isolation for untrusted code.

The package does not store provider secrets in project state. Credentials are resolved from configured environment aliases for the duration of a request. Project exports and backups must still be reviewed because canonical records can contain research metadata, excerpts, local filenames, participant material, and user-authored text.

See `docs/threat-model.md` for the v1.0 threat model, sensitive-project defaults, and non-goals. Do not load unknown in-process Adapters: v1.0 provides governance controls, not code isolation.
