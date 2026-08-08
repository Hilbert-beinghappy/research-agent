# v3.0.0-beta.1 technical-candidate checklist

This checklist governs one fixed commit. It is not evidence that the working tree, an earlier commit, or an unpublished tag passed. Candidate commit/tree/version mapping and observed results come from CI artifacts so this tracked file does not contain a self-referential SHA.

## Candidate identity

- Candidate commit and tree: exact values from `research-agent-release-identity.json` and `research-agent-v3-beta-qualification.json` for the same SHA.
- Expected tag: `pi-research-agent-v3.0.0-beta.1`; it must remain absent until separate tag authorization and every release-eligibility condition passes.
- Version mapping: Agent/SDK `3.0.0-beta.1`; contracts `2.1.0`; Memory schema `1.0.0`; Project schema `1.5.1`; RPC v1; SDK capability v2.
- Product boundary: Doro remains one Pi Package/Profile with no standalone `doro` executable.
- Upstream baseline: repository `UPSTREAM.md`.

## Required observed technical checks

- [ ] Ubuntu, macOS, and Windows `v3.0.0-beta.1 technical core` jobs pass on the exact candidate commit.
- [ ] Each platform passes contracts/Agent checks and all unit, integration, e2e, and compatibility tests.
- [ ] The 5,000-attempt poisoning corpus, prohibited-inference suite, restricted cross-project suite, evidence-boundary suite, no-memory regression, and exact-revision receipt tests pass.
- [ ] Each platform completes the 10,000-transaction Memory store qualifier with exact revision/count/journal/root checks and no pending transaction.
- [ ] Each platform passes 1k/10k/50k retrieval; 10k P95 is at most 75 ms, context P95 is at most 800 tokens, and context maximum is at most 5%.
- [ ] The public scrypt/AES-256-GCM KAT and randomized transfer import/rejection/recovery tests pass on each platform.
- [ ] Synthetic longitudinal arithmetic is bound to its baseline and reports `betaPilotStarted: false` and `stableV3LongitudinalEligible: false`.
- [ ] v0.1 through v2.0 deterministic release gates and benchmarks remain green.
- [ ] macOS completes the separate transaction growth and three-consecutive-pass qualification on the same SHA.
- [ ] The licensed, hash-pinned Ubuntu public-corpus workflow passes on the same SHA.
- [ ] Contracts and Agent release scans, reproducible packs, clean installs, release identity, SBOM/notices/licenses, schemas, migration guide, and transfer vector all bind to the candidate.
- [ ] Production vulnerability and registry-signature checks pass independently on the same SHA.
- [ ] Main branch protection reports the selected release jobs as required checks.

## Release-eligibility conditions

- [ ] The opt-in first 10-person beta pilot has actually started under approved consent, data-controller, randomization, and full-profile exit procedures.
- [ ] The candidate technical report changes from `betaReleaseEligible: false` only on observed pilot evidence, never by editing the synthetic baseline.
- [ ] A release owner and security reviewer approve the exact candidate after reviewing all artifacts and known limitations.
- [ ] The expected beta tag is separately authorized and then read back at that same commit.

Until these conditions pass, the only valid verdict is technical preflight; do not tag or publish the beta. Stable v3 additionally requires 30 participants, 12 weeks, at least 24 Sessions/3 Projects/40 eligible opportunities per participant, all longitudinal thresholds, and a new fixed-SHA qualification.

## Rollback and waivers

- Preserve the prior package, lockfile, commit, verified Project backups, and candidate reports.
- Rollback must not rewrite a schema 1.5.1 Project or silently delete a separate Personal Memory profile.
- `docs/security-waivers.json` must remain valid; a waiver documents accepted temporary risk and never converts a failed high/critical audit or security hard gate into a pass.
- Do not merge, tag, publish, deploy, enroll participants, or change external data state without the corresponding explicit authorization and observed readback.
