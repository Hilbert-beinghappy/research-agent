# v3.0.0-beta.1 technical-candidate boundary

## Current verdict

This source tree is a technical beta candidate, not a beta release and not stable v3. Deterministic and synthetic qualification may pass while `betaReleaseEligible` remains false: the opt-in 10-person pilot has not started, its consent/data-controller/full-profile exit procedure is not approved here, and the 30-person/12-week longitudinal study is incomplete. No tag or publication is authorized by this document.

## Version and compatibility mapping

- `pi-research-agent` and SDK identity: `3.0.0-beta.1`;
- `@research-agent/contracts`: `2.1.0`;
- Personal Memory schema: `1.0.0`;
- Research Project schema: `1.5.1` (unchanged from v2.0.1);
- SDK capability: v2; RPC wire: v1;
- product form: one Pi Package/Profile, with no standalone `doro` executable.

The [migration and rollback guide](memory-v3-migration.md) preserves v2.0.1 Project state and treats Personal Memory as an optional separate store.

## Technical scope

The candidate includes strict Personal Memory contracts, a canonical JSON store with recovery, deterministic user-signal capture, quarantine/promotion rules, bounded retrieval, exact-revision use receipts, correction/forget/delete verification, encrypted offline transfer, confirmed `/memory` management, value-free model inspection, exact-user feedback, allowlisted explicit activation, task-start formatting application, a fail-closed on/off path, and privacy-minimized longitudinal evaluation.

The fixed-SHA workflow must run on Ubuntu, macOS, and Windows with Node 22.19.0. Each platform runs the complete contracts/Agent checks and tests, the 5,000-attempt poisoning corpus, transfer KAT and transfer rejection tests, the 10,000-transaction store qualification, 1k/10k/50k retrieval qualification, the synthetic longitudinal evaluator, reproducible packing, release scans, and clean-install probes. macOS transaction qualification and the licensed Ubuntu public-corpus job remain separate required checks.

## Evidence boundary

Tracked Darwin baselines bind the current store, transaction, retrieval, and qualification-script hashes. The longitudinal baseline is synthetic and proves metric arithmetic and hard-gate accounting only. The public crypto KAT fixes scrypt/AES-256-GCM parameters and expected bytes; randomized end-to-end tests separately verify authentication, import, replay, fork, traversal, collision, oversize, and interruption behavior.

The machine report `research-agent-v3-beta-qualification.json` records the checked commit/tree, artifact hashes, version mapping, technical checks, and explicit deferral codes. It must say `technical_preflight_passed`, `betaReleaseEligible: false`, `betaPilotStarted: false`, and `stableV3LongitudinalEligible: false` until real evidence exists.

## Known limitations and no-claims

- No real pilot outcome, personalization-benefit estimate, false-memory field rate, or stable-v3 result exists.
- The trial-wide consent, data-controller, randomization schedule, and full-profile exit procedure are external prerequisites, not repository evidence.
- Windows runs protocol and application tests but has no strong third-party process-isolation profile.
- Python/R qualification is platform-dependent; Stata remains an unqualified user-owned commercial runtime.
- Local success, a green prior SHA, an in-progress job, or an accepted GitHub API request is not same-SHA release evidence.
- A beta tag, npm publication, merge, deployment, provider call, or participant enrollment requires separate authorization and observed state.
