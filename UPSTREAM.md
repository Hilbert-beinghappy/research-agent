# Pi upstream synchronization

This repository keeps Pi as the host runtime and carries Doro Research Agent as a focused patch set. Pi Core is not forked into a second session or model loop.

## Recorded baseline

| Field | Value |
|---|---|
| Upstream repository | `https://github.com/earendil-works/pi.git` |
| Architecture baseline commit | `97f0ccdd96cc207b6ad3630c56eea4d32dbdcf53` |
| Architecture baseline tree | `3a2cb6544cd4aead69788065b2c32a457043b585` |
| Nearest release tag | `v0.83.0` at `845d6ff1f6643aba440341cce877ce1c43ebbc39` |
| Distance from that tag | 233 upstream commits |
| Imported baseline commit | `61628e574878d6ae4927f4019803a151d7829ba2` |
| Imported baseline tree | `3a2cb6544cd4aead69788065b2c32a457043b585` |
| Pi package version in that tree | `0.83.0` |

The imported root commit and the upstream baseline have identical trees but unrelated Git ancestry. Package version `0.83.0` is therefore a compatibility fact, not the upstream Git baseline.

The v2.0.0 source-preview patch queue is the twelve commits after `61628e574` through `72e83b547`; its expected tree is `281df4dbddb1444d40be4ce813f8e5fb00bddbda`. Later candidate identities are carried by fixed-SHA CI artifacts rather than written into the tracked checklist, which cannot safely contain its own final commit.

## v3 replay and CI identity mapping

For a v3 candidate, `CANDIDATE_SHA` is both the Doro queue endpoint in `61628e574..CANDIDATE_SHA` and the source identity for the replay. An isolated replay record must retain the source candidate commit/tree, the upstream target commit/tree, the resulting replay commit/tree, the ordered patch list, and any conflict decisions. The replay result is compatibility evidence only; it does not prove that CI passed on the source candidate.

CI maps that replay source identity to release evidence as follows:

- `research-agent-release-identity.json` is generated on the original candidate checkout and binds `candidate.commit`, `candidate.tree`, the expected tag, the Pi Package/Profile form, and the package/protocol version mapping; it also requires `GITHUB_SHA` to equal checked-out `HEAD`.
- `research-agent-v3-beta-qualification.json` independently binds the same candidate commit/tree to the v3 technical checks, artifact hashes, and explicit `betaReleaseEligible: false` and `stableReleaseEligible: false` verdicts.
- `research-agent-release-v3.0.0-beta.1.json` records reproducible package contents for the same matrix job and version mapping. It does not carry a commit/tree by itself, so it must be evaluated with the two identity-bearing reports from that exact workflow run.

Acceptance requires the first two reports to agree with each other, the workflow `GITHUB_SHA`, and the replay record's source candidate commit/tree. The replay result commit/tree remains a separate upstream-compatibility identity and must not replace the original candidate identity. None of these artifacts substitutes for the real beta pilot or longitudinal study required by the release checklist.

## Ownership boundaries

Doro-only paths are:

- `packages/research-agent/**`
- `packages/research-agent-contracts/**`
- `.github/workflows/research-agent.yml`
- `.github/workflows/research-agent-transaction-diagnostics.yml`
- `.github/workflows/npm-audit.yml`
- `UPSTREAM.md`

Shared integration paths are limited to:

- `README.md`, `.gitignore`, `biome.json`, `tsconfig.json`, and `package-lock.json`
- `.github/workflows/ci.yml`
- `packages/coding-agent/src/core/auth-storage.ts`

Everything else under `packages/agent`, `packages/ai`, `packages/coding-agent`, `packages/tui`, `packages/server`, and `packages/storage` is upstream-owned. Do not edit those areas for a Research Agent feature unless the package boundary cannot implement the behavior and the compatibility review records the reason. Do not rename Pi packages for Doro branding.

## Sync procedure

1. Fetch upstream without switching the active Doro worktree.
2. Create a temporary worktree at the proposed upstream commit and verify its tree and package versions.
3. Export the Doro queue with `git format-patch --stdout 61628e574..CANDIDATE_SHA` and apply it to the temporary upstream worktree with `git am --3way`.
4. Resolve conflicts only in Doro-only or listed shared integration paths. An upstream-owned conflict requires an explicit compatibility decision; never accept either side wholesale.
5. Compare `git rev-parse HEAD^{tree}` with the expected candidate tree when replaying the recorded baseline. For a new upstream target, record the new tree as release evidence after review.
6. Run the compatibility matrix below. Only then replace the baseline fields and candidate evidence.

Required matrix:

- package check and deterministic tests on Ubuntu, macOS, and Windows;
- clean installs against the pinned Pi package baseline and the latest supported Pi package;
- sixteen-tool name/schema snapshot and Extension load;
- SDK/RPC read-only capability and host-path-redaction tests;
- model-egress, evidence-provenance, writer-lock, hostile-PDF, and public-corpus gates;
- package scan, reproducible pack, SBOM/NOTICE, production audit, and registry-signature audit.

## Conflict and rollback policy

- Keep the pre-sync Doro branch and upstream commit reachable until the new candidate passes every gate.
- Abort the temporary replay when a conflict touches an upstream-owned file not listed above; review that file separately.
- Never force-push or rewrite the published baseline.
- Roll back by returning consumers to the previous tested package tarballs and commit, then restore projects from verified backups only when a project-format migration occurred. Package-only rollback does not rewrite canonical project files.
