# v2.0.1 release-candidate boundary

v2.0.1 is an unpublished hardening candidate for the existing Pi Research Agent architecture. It preserves Pi Core, fourteen model-visible aggregate Tools, eleven Skills, file-based canonical project state, and the inspection-only SDK/RPC boundary.

## Product and version identity

Doro is the branded Pi Research Agent profile/package. It starts through Pi with the Research Agent Extension; this candidate does not provide or claim a standalone `doro` executable. The root monorepo version, Pi packages, `pi-research-agent`, `@research-agent/contracts`, SDK/RPC protocol, and project schema are separately versioned. The candidate package remains unpublished until the release checklist is completed on one fixed commit.

The canonical project schema is 1.5.1. Schema 1.5.0 is the direct migration input; migration snapshots and hash-verifies each provenance rewrite and uses `unknown_legacy` when historical semantic origin cannot be established. Older published schemas remain supported migration inputs.

## Hardening scope

- fail-closed authorization for every model-visible payload;
- host-derived model semantic provenance and deterministic source-verification fields;
- fixed PDF.js release plus scripted-PDF rejection and hostile fixtures;
- project writer lease, parent-directory durability, multi-process stress, and backup consistency;
- compiled public exports, reproducible packages, Pi 0.83.0/0.84.0 clean install/uninstall probes, and read-only SDK/RPC path redaction;
- strong local process isolation on macOS Seatbelt and Linux bubblewrap, with explicit host-user fallback approval; Windows has no strong profile;
- a hash-pinned, redistribution-permitted NIST public-corpus workflow;
- PR/main/tag security gates, waiver validation, upstream replay policy, release checklist, and Skill provenance.

Python and R are qualified only where their real runtime and strong isolation gate pass. Stata remains an optional user-owned commercial runtime and is not qualified by a mock executor. Zotero is an export/push adapter, and Obsidian support is an Obsidian-compatible Markdown export; neither is claimed as a verified bidirectional desktop integration.

## Transaction diagnostics

Set `RESEARCH_TX_TRACE=1` before process startup to emit identifier-redacted JSON Lines on stderr for writer-lease wait/renew/release, project open, record hashing, journal preparation, data and manifest commit, post-commit verification, archive, worker progress, and failure codes. The trace contains counts, timings, short identifier hashes, and a hashed process identifier; it does not contain project paths, record content, credentials, or raw operation/transaction/worker identifiers.

Run the bounded scaling harness with `npm run diagnose:transactions -w packages/research-agent -- --counts 100,250,500 --processes 1,2 --repetitions 5`. The manual `Research Agent Transaction Diagnostics` workflow applies the same harness to Ubuntu, a fixed macOS image, and `macos-latest`, with a ten-minute job limit and a 240-second watchdog snapshot. Diagnostic completion does not qualify a release and does not replace the unchanged 300-second, 1,000-write deterministic test or its consistency assertions.

## Remaining external evidence

Local success is not fixed-commit release qualification. Stable-candidate status additionally requires the candidate SHA's remote three-platform jobs, required branch-protection checks, and same-SHA release tag. Those remote actions require explicit user authorization.
