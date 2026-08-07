# v2.0.1 release-candidate checklist

This checklist governs a candidate; it is not evidence that the current working tree or an unpublished tag has passed. Fill the candidate commit, tree, tag, owners, links, and observed results only after they exist.

## Candidate identity

- Candidate commit: `UNSET`
- Candidate tree: `UNSET`
- Candidate tag: `UNSET`
- Release owner: `UNSET`
- Security reviewer: `UNSET`
- Upstream baseline: see repository `UPSTREAM.md`
- Product boundary: Doro is a Pi profile/package; no standalone `doro` CLI is claimed.
- Version mapping: root monorepo metadata, Pi package versions, Research Agent package version, contracts version, and project schema are independent fields and must all be recorded.

## Required observed checks

- [ ] Ubuntu, macOS, and Windows `v2.0 core` jobs pass on the candidate commit.
- [ ] Privacy regression blocks restricted abstract, document, evidence, claim, and manuscript payloads before model visibility.
- [ ] Evidence provenance regression records model provider/model/prompt/schema/turn and rejects model-selected deterministic/imported provenance.
- [ ] `pdfjs-dist` production audit is clear; corrupt, encrypted, oversized, scripted, and nested hostile PDF tests pass without file, process, or network effects.
- [ ] Two independent processes complete the 1,000-write writer test without lost updates; SIGKILL recovery and restored-project validation pass.
- [ ] Python and R qualification pass where installed. Stata remains unqualified until a licensed runner records a real pass.
- [ ] `npm run test:public-corpus -w packages/research-agent` completes the hash-pinned NIST workflow from import through restore.
- [ ] Existing failure tests cover unavailable provider/network, parser rejection, Adapter failure, and interrupted transaction/migration recovery.
- [ ] Contracts and Agent release scans pass, both packages pack reproducibly, and clean install/uninstall probes pass against Pi 0.83.0 and 0.84.0.
- [ ] SDK/RPC logs contain no default host path, username, credential value, or private fixture text; `includeHostPaths` remains explicit opt-in.
- [ ] Production vulnerability and registry-signature jobs pass independently.
- [ ] SBOM, NOTICE, third-party notices, licenses, and Skill provenance match the candidate tarballs.
- [ ] The Doro patch queue replays from the recorded upstream baseline and the resulting tree matches the recorded candidate tree.
- [ ] Branch protection reports all release jobs as required for the candidate commit.
- [ ] The release tag points to that same fully qualified commit.

## Security waivers

`docs/security-waivers.json` is validated in CI. Every temporary entry requires a GHSA/CVE advisory ID, a substantive risk explanation, an expiry, and an owner. Expired or malformed entries fail CI. A waiver documents accepted temporary risk; it does not turn a failed high/critical production audit into a stable-release pass.

## Rollback evidence

- Preserve the prior tested tarballs, lockfile, commit, upstream baseline, and qualification reports.
- Package rollback must not rewrite a schema 1.5.1 project.
- Any future project-format migration requires a verified pre-migration backup and a tested restore into an empty destination.
- Do not publish, push a tag, or change branch protection until the user explicitly authorizes the remote action.
