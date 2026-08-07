# Threat model v2.0

## Assets

- Canonical project records, manifest revisions, input/output hashes, transaction ledger, and recovery state.
- Local papers, excerpts, bibliographic imports, provider responses, research questions, datasets, qualitative materials, scripts, runtime logs, and model-authored drafts or coding suggestions.
- Provider credentials, approval decisions, action budgets, publication-status checks, and provenance.
- External item mappings, export bundles, monitor queries/cursors, backups, migration journals, model-routing decisions, and derived cross-project catalogs or corpus indexes.
- Explicitly configured SDK/RPC project roots, project identifiers, inspection requests, and machine-readable responses.

## Trust boundaries

1. **Pi host and user account:** trusted to read and modify accessible files. Pi Extensions have full host-process authority.
2. **Research Package kernel:** trusted built-in code validates schemas, paths, revisions, hashes, policy, transactions, migration locks, backups, and deterministic model routes.
3. **Model and Skills:** untrusted decision inputs. They can request only registered Tools while governed mode is active; their text is not canonical state.
4. **Built-in Adapters and external services:** built-in Adapter code is trusted in process; provider data and availability are untrusted. Network side effects go through the HTTP broker.
5. **Third-party Adapter process:** untrusted code communicates through JSONL. Ordinary process separation contains protocol failure but is not an OS sandbox. Governed registration requires the built-in macOS strong-isolation profile and Host-mediated effects.
6. **Imported files:** untrusted bytes. Format, size, path and PDF parser outcomes are validated before evidence use.
7. **Local analysis runtimes and scripts:** user-confirmed but not sandboxed code. They receive copied inputs and a designated output directory, while the host verifies immutable originals before and after execution.
8. **SDK/RPC client:** trusted as part of the host user boundary. It can inspect only startup-configured projects through a local stdio protocol; it is not a network service or OS sandbox.

Tool hooks and `setActiveTools` enforce the intended Pi workflow, but they are not an OS sandbox. A malicious Extension, Adapter, dependency, host user, or compromised Pi process can bypass them.

## Enforced controls

| Threat | v2.0 control | Residual risk |
|---|---|---|
| Model writes canonical files directly | Governed mode removes write/edit/bash tools; canonical mutations use transactions and expected revisions. | Other host code can still write files. |
| Path escape or overwrite | Portable relative-path validation, symlink checks, protected paths, action fingerprints, confirmation for overwrite/delete. | Host-level changes outside Pi are not prevented. |
| Unknown Adapter executes before review | Static manifest/hash/license/provenance/SBOM checks occur before execution; default policy denies unknown code; registration binds interactive approval to package identity/hash/profile before conformance. | A user can approve malicious code; only the documented strong profile is intended to contain it. |
| Adapter escapes process authority | macOS strong isolation strips the environment, denies direct network/subprocess/private reads/project writes, allows declared package/runtime reads, and limits writes to staging. Host brokers mediate effects. | Linux and Windows strong isolation are not shipped in v2.0. `jsonl_process` alone is not an OS sandbox, and a compromised host is out of scope. |
| SDK/RPC reads an unintended project or bypasses approval | Project roots are fixed at startup, requests use canonical project IDs, additional path fields are rejected, and the stable seven-method subset is inspection-only. | A malicious same-account process can read files directly outside this protocol; the local host and configured clients remain trusted. |
| Malformed or crashed Adapter harms the Host | Exact executable/no shell, JSONL schema and ID validation, one terminal result, timeout, abort, output cap, and canonical failure mapping. | Resource exhaustion outside configured time/output limits remains an OS responsibility. |
| Tampered portable exchange | Portable/case/symlink checks, file size/hash verification, file-list root hash, optional Ed25519 signature, staging, empty-destination import, and full project validation. | An unsigned root hash does not authenticate every manifest metadata field; default exchange does not redact sensitive derived content. |
| Concurrent file collaboration loses work | Base/proposed hashes, consecutive revisions, successful author Operation, governance-record exclusion, and all-or-nothing conflict handling. | ChangeSets are not real-time synchronization and referenced files travel separately. |
| Partial or mixed project state | Staged multi-file transactions, manifest-last commit, hashes, pending recovery, explicit validate/recover. | Disk or filesystem failure can still require manual recovery. |
| Concurrent or interrupted migration | One exclusive project lock, a pre-migration hash-bound backup, immutable before/after snapshots, manifest-last commit, and interruption-matrix tests. | A stale lock after process termination needs diagnosis and explicit operator removal; the doctor never guesses that the process is dead. |
| Corrupt or incomplete backup | Per-file hashes, a root hash, project identity check, and restore only into an empty destination. | Backup storage on the same failed physical device is not disaster recovery; copy a verified project backup to separate storage under the user's own policy. |
| Secret leakage | Project stores credential aliases only; broker rejects raw credential headers/query fields and records redacted intent. Release tarball scans common secret and personal-path patterns. | Environment, model prompts, or provider bodies can contain sensitive data if the user supplies them. |
| Unapproved network or spend | Policy evaluation, destination/action scope, explicit budgets, approval ledger, request/cost accounting and hard stop. | External pricing and provider behavior can drift after the snapshot date. |
| Paywall or license bypass | Unpaywall/local authorized inputs only; access and license states are separate; unknown rights do not become export permission. | Users remain responsible for lawful access and downstream use. |
| Licensed-provider access exceeds entitlement | AccessPolicySnapshot records terms version, access path, automation permission, entitlement capabilities, limits, and redistribution state; the evaluator blocks missing/expired/revoked credentials, absent capability, or limit overrun. | A snapshot can become stale or misrepresent a private contract; provider-specific packages need current legal and technical review. |
| Browser login, CAPTCHA, or rate-limit circumvention | No generic browser-scraping or login Adapter is shipped; official API, supported export, and user-authorized file are the only access paths. | Users can operate external software outside this package; those actions are not validated or claimed by the project. |
| Proprietary discipline resource enters a public package | Every Domain Package rule declares provenance and license; release scanning and authoring rules exclude private Skills, credentials, paths, and restricted content. | A false provenance declaration still requires maintainer and rights-holder review. |
| Evidence fabrication or promotion | Evidence-level enum, locator invariants, exact excerpt match, source/parser hashes, citation state and artifact gates. | Model interpretation can still be wrong; human review remains required. |
| Malicious/corrupt PDF | Signature/content/size checks, isolated parser result states, no automatic OCR upload. | PDF.js remains a complex dependency; process-level sandboxing is not provided. |
| Dependency or proprietary asset leakage | Exact direct pins, lock-derived SPDX SBOM/notices, allowed Skill list, package-content scan. | A newly disclosed dependency vulnerability requires a new review/release. |
| Script mutates raw research data | Content-addressed originals are read-only, copied for execution, hash-checked afterward, and restored from an external temporary backup when mutation is detected. | A host process with the same account can still race or alter files outside this transaction boundary. |
| Failed analysis reported as a finding | Terminal status, exit code, logs, expected-output checks, timeout/abort and explicit non-convergence are canonical `AnalysisRun` facts; failed outputs are not success artifacts. | A successful script can still implement a scientifically invalid method; confirmation and review remain required. |
| Model coding replaces human judgment | `ModelSuggestion` is immutable and separate; `CodingDecision` requires an explicit user accept/edit/reject action and preserves supersession and negative cases. | Human coding can still be inconsistent or biased; v0.3 does not calculate intercoder reliability automatically. |
| Model invents support or treats reviewer consensus as verification | ClaimOccurrences require canonical Claim/Evidence/citation links; deterministic integrity runs first; reviewer roles are rubrics; immutable revisions, user dispositions, disclosure, P0 blocking, and explicit submission approval remain recorded. | Narrative quality, interpretation, and factual truth still require author review and external scholarly scrutiny. |
| Unapproved or duplicate Zotero write | Credential aliases are resolved only by the broker; POST is classified as external write; approval is bound to destination/action/data; a write token and ExternalItemLink hash reconcile retries and partial responses. | Zotero can change or delete items outside this package; a remote service may accept a request but fail before returning a receipt. Reconciliation remains required. |
| Monitor skips, duplicates, or advances after failure | Query hash, immutable subscription revisions, latest-revision check, canonical dedup, one-page confirmed runs, atomic run/checkpoint commit, and retry task. Failed runs retain the previous cursor. | Provider cursors can expire or providers can reorder results; source discovery is not a guarantee of historical completeness. |
| Derived export or catalog becomes a second source of truth | Office/Obsidian/catalog outputs carry stable IDs or input hashes and are explicitly rebuildable; validators follow canonical records, not exports. | Users can edit exported files; reimport treats them as external input and does not silently overwrite canonical facts. |
| Derived corpus cache replaces canonical evidence | Cache entries are bound to the corresponding canonical record-set fingerprint and a content hash; stale or corrupt files rebuild, while PDF blocks are checked live. | A malicious same-account process can rewrite cache and hashes; malicious local users and compromised hosts are out of scope. Delete the cache and validate the project when in doubt. |
| Sensitive request routed to an unsafe or unaffordable model | The deterministic router filters by project egress policy, data class, required capability, context, availability, and budget before preferring local and lower-cost candidates. No eligible candidate returns `blocked`. | Candidate capability, pricing, and locality are supplied observations; stale or dishonest metadata can yield a poor route and must be refreshed by the host. |
| Commercial software/license leakage | Stata is detected by executable path only, never bundled, and its license content is not inspected. Every run requires commercial-runtime approval. | Users remain responsible for installation, licensing and permitted use. |

## Privacy defaults

Low-risk local reads, deterministic profiling, and new project outputs can run automatically. Executing a Python/R script is governed as unknown code; Stata uses the commercial-runtime action class. Unknown third-party Adapter code is denied by default; a user must change policy to `ask`, approve the exact package, and pass strong conformance before registration. Paid calls, sensitive egress, external writes, overwrites, deletion, dependency installation, commercial runtimes, and publish/submit actions require explicit approval or are denied by project policy. Disabling model egress blocks qualitative model suggestions for the linked project.

Project exports, exchange bundles, manuscripts, review findings, runtime logs, Zotero payloads, Obsidian notes, backups, catalogs, and SDK/RPC responses can contain titles, authors, excerpts, research notes, variable names, participant text, parameters, and filenames. Review them before sharing. A restricted project should disable model egress and external writes unless a destination-bound approval explicitly permits them. v2.0 has no general host-process sandbox, secret vault, participant-data de-identification service, telemetry, network RPC server, background daemon, cloud sync, automated email, or automated submission.

## Security non-goals

- Protecting against a malicious local user, root/administrator, compromised OS, compromised Pi host, or malicious in-process extension.
- Protecting unknown Adapters outside the documented macOS strong-isolation profile or after a Host broker grants an unsafe action.
- Circumventing authentication, robots controls, CAPTCHAs, paywalls, or provider terms.
- Certifying academic correctness, legal compliance, privacy compliance, or publication readiness without human review.

Unknown third-party code requires OS/container sandboxing with denied network, restricted mounts, no inherited secrets, resource limits, and Host-mediated staging. v2.0 claims this only for the tested built-in macOS strong-isolation profile; unsupported platforms block registration rather than falling back.
