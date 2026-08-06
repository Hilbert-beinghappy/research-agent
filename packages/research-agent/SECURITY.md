# Security policy

## Supported version

The current v0.1 release candidate receives security fixes. No earlier package format is supported.

## Reporting

Report vulnerabilities through the repository's private security-advisory channel. Do not open a public issue for an unpatched vulnerability and do not attach credentials, private papers, participant data, or research-project files. Include the affected package version, operating system, a minimal synthetic reproduction, and the expected impact.

## Security boundary

Pi packages execute in the host process. The policy engine, approval ledger, governed file transactions, and HTTP broker reduce accidental or model-initiated misuse, but they do not isolate malicious Pi Extensions, malicious in-process Adapters, a compromised host, or a user who edits project files outside Pi. Use OS-level isolation for untrusted code.

The package does not store provider secrets in project state. Credentials are resolved from configured environment aliases for the duration of a request. Project exports must still be reviewed because canonical records can contain research metadata, excerpts, local filenames, and user-authored text.

See `docs/threat-model.md` for the v0.1 threat model and non-goals.
