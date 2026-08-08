# v2.0.1 release-candidate checklist

This checklist governs a candidate; it is not evidence that the current working tree or an unpublished tag has passed. Candidate-specific commit, tree, version mapping, and observed results are emitted as the `research-agent-release-identity.json` CI artifact so the tracked checklist does not contain a self-referential SHA.

## Candidate identity

- Candidate commit and tree: exact values from the candidate SHA's `research-agent-release-identity.json` artifact.
- Expected release tag: `pi-research-agent-v2.0.1`; absence is required until tag authorization and all checks pass.
- Release owner and security reviewer: recorded in the protected release approval before tag creation; CI authorship alone is not approval.
- Upstream baseline: see repository `UPSTREAM.md`
- Product boundary: Doro is a Pi profile/package; no standalone `doro` CLI is claimed.
- Version mapping: `pi-research-agent` and SDK package identity 2.0.1; `@research-agent/contracts` 2.0.0; project schema 1.5.1; `pi-research-rpc` v1; SDK capability v2; Pi 0.83.0 baseline and 0.84.0 latest qualified.

## Required observed checks

- [ ] Ubuntu, macOS, and Windows `v2.0 core` jobs pass on the candidate commit.
- [ ] Privacy regression blocks restricted abstract, document, evidence, claim, and manuscript payloads before model visibility.
- [ ] Evidence provenance regression records model provider/model/prompt/schema/turn and rejects model-selected deterministic/imported provenance.
- [ ] `pdfjs-dist` production audit is clear; corrupt, encrypted, oversized, scripted, and nested hostile PDF tests pass without file, process, or network effects.
- [ ] Two independent processes complete the 1,000-write writer test without lost updates; SIGKILL recovery and restored-project validation pass.
- [ ] macOS completes three consecutive 1,000-write runs on the candidate SHA; each is at most 225 seconds, adjacent 250/500/1,000 growth ratios are at most 2.6, and normal distinct-ID conflict rate is below 0.1%.
- [ ] Python and R qualification pass where installed. Stata remains unqualified until a licensed runner records a real pass.
- [ ] `npm run test:public-corpus -w packages/research-agent` completes the hash-pinned NIST workflow from import through restore.
- [ ] Existing failure tests cover unavailable provider/network, parser rejection, Adapter failure, and interrupted transaction/migration recovery.
- [ ] Contracts and Agent release scans pass, both packages pack reproducibly, and clean install/uninstall probes pass against Pi 0.83.0 and 0.84.0.
- [ ] Packed-tarball smoke loads Doro through Pi's package Extension, reports 2.0.1 through SDK/RPC, and confirms no standalone `doro` executable exists.
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
