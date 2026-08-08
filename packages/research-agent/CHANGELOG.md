# Changelog

## [Unreleased]

### Added

- macOS Seatbelt and Linux bubblewrap strong process isolation for third-party Adapters and confirmed analysis scripts, with explicit host-user fallback approval only where requested.
- Single-writer project lease, parent-directory durability, multi-process/SIGKILL regressions, hash-pinned NIST public-corpus qualification, security-waiver validation, upstream replay policy, and a fixed-SHA release checklist.
- Opt-in, identifier-redacted transaction phase tracing plus a bounded manual scaling diagnostic for single- and dual-process writers.
- Offline Personal Memory export/import with scrypt-wrapped AES-256-GCM keys, encrypted manifests, bounded canonical containers, fast-forward lineage checks, and crash-recoverable atomic profile exchange.
- One `/memory` command family for confirmed first-use profile creation, status, inspection, explanation, correction/deletion, pause/resume, encrypted transfer, and deletion verification, with private profile roots, logical-path output, and restricted-value redaction.
- `research_memory_inspect` for bounded, scope-filtered, value/hash-free classified summaries that exclude restricted items, and `research_memory_feedback` for exact current-user correction, forgetting, or deletion with interactive confirmation and immutable feedback receipts.
- Host-only activation of allowlisted explicit writing/output preferences, plus fail-closed task-start application with bounded context, project/model egress checks, and exact-revision use receipts.
- Privacy-minimized Personal Memory longitudinal evaluation with a fail-closed on/off mode, bound synthetic metrics, a 5,000-attempt poisoning corpus, no-memory regression coverage, and the 30-person/12-week trial protocol.

### Changed

- The Agent package, Extension, SDK identity, clean-install probes, SBOM, and compatibility manifest advance to the unpublished `3.0.0-beta.1` technical candidate while contracts remain `2.1.0` and project schema remains `1.5.1`.
- Fixed-SHA CI now records machine-readable release identity and enforces three macOS 1,000-write passes, a 225-second budget, 2.6 growth ratios, and a sub-0.1% distinct-ID conflict rate.
- Doro terminal sessions replace Pi's generic startup help with a compact side-by-side identity panel showing a scaled-down Bocchi pet with the blue-yellow hair ornament preserved, the active model and effort, and current directory.
- Public package exports now load compiled `dist` modules and expose only contracts, Adapter protocol, SDK, RPC, schemas, and package metadata.
- Canonical schema 1.5.1 records semantic provenance and source verification separately; SDK/RPC defaults to logical project locators and advertises supported evidence-submission levels.
- The 16 model-visible tools share one egress guard; project mutations use the operation wrapper, while Personal Memory feedback uses its isolated profile transaction and confirmation record.
- Product language now describes Doro as a Pi profile, Zotero as an export/push adapter, Obsidian as a compatible Markdown export, and Stata as unqualified until a real licensed runner passes.

### Fixed

- Record-set hashes now use a manifest-bound, transactionally updated derived index that rebuilds from canonical records when missing, stale, corrupt, or forced into scan mode.
- Same-process concurrent writers now wait for the project lease while true nested lease acquisition remains fail-closed.
- Record mutations now hold the project writer lease from manifest validation through record-set hashing and commit, so stale concurrent requests fail before expensive index scans.
- Model-visible corpus and record payloads now fail closed under project/provider/data-class egress policy, and model-authored evidence can no longer claim deterministic or imported semantic provenance.
- PDF.js is pinned to 6.2.108; scripted PDFs are rejected through the official JavaScript-action check and hostile fixtures verify no network, process, or file side effects.
- Project backups serialize with canonical writers and restore the required empty directory layout before validation.

## [2.0.0] - 2026-08-07

### Added

- Stable inspection-only SDK and local stdio RPC v1 with seven parity-tested methods over explicitly configured projects.
- SDK/RPC request, response, and capability contracts plus generated v2.0 protocol schemas; canonical project schema remains v1.5.
- Public brokered-HTTP Source Adapter example, macOS Scenario E qualification, two-project replay, multi-project benchmark, reproducible-package check, and sanitized `deepseek-v4-flash` boundary baseline.
- SDK/RPC, release-boundary, and two-project example documentation plus clean-install probes for the SDK and RPC executable.

### Changed

- Package, Extension, and public contracts package versions advance to 2.0.0 without changing or migrating canonical project schema 1.5.0.
- Release CI replays v0.1–v2.0 gates, validates the public third-party Adapter, checks Scenario E on macOS, and packs both npm packages reproducibly.

### Known limitations

- The stable SDK/RPC subset is read-only; canonical mutations remain on Pi-governed Tool/command surfaces.
- Strong third-party Adapter isolation remains macOS-only. `jsonl_process` is not an operating-system sandbox.
- v2.0 adds no hosted service, network RPC server, database, account system, required custom UI, real-time CRDT, marketplace, automatic submission, or general multi-Agent runtime.

## [1.5.0] - 2026-08-07

### Added

- Data-only `@research-agent/contracts` package with seven public entry points, generated v1.5 schemas, and frozen Source, Analysis Runtime, Artifact, JSONL, exchange, collaboration, and model-route contracts.
- Third-party Adapter package verification, three-category conformance kit, bounded JSONL runner, macOS strong-isolation qualification, approval-bound Pi registration, and three independent public examples.
- Hash-verified portable Exchange Bundles, optional Ed25519 manifest signatures, record-only all-or-nothing Collaboration ChangeSets, and deterministic model-route decision records.
- v1.5 evaluation, 10,000-record exchange benchmark, strong-isolation attack fixture, public development/protocol/exchange/routing guides, and a sanitized `deepseek-v4-flash` boundary baseline.

### Changed

- New projects and generated schemas use v1.5; v0.1–v1.1 projects migrate directly by adding empty v1.5 record sets and directories without rewriting canonical records.
- Package and Extension versions advance to 1.5.0. Public Host integration exports now cover Adapter conformance/registration/runner and exchange/collaboration.
- Unknown third-party code remains denied by default. Interactive registration requires policy `ask`, an approval bound to exact package identity/hash/profile, and successful strong-isolation conformance before persistence.

### Known limitations

- Built-in strong isolation is macOS-only. Linux and Windows registration blocks rather than silently falling back; ordinary JSONL process separation is not an OS sandbox.
- The v1.5 conformance runner launches Node.js entry points; other runtime launchers are deferred.
- Default exchange excludes raw inputs, Session, credentials, and internal state but does not classify or redact sensitive text already present in canonical records, notes, or artifacts.
- Collaboration is record-only and not real-time sync. v1.5 adds no marketplace, hosted service, remote execution, database, CRDT, message queue, or separate UI.

## [1.1.0] - 2026-08-07

### Added

- Four data-only Domain Packages for management, public administration, sociology, and political science, with per-rule provenance, deterministic precedence, equal-precedence conflict rejection, and confirmed `/research-domain` activation.
- AccessPolicySnapshot, DownloadLimit, EntitlementCapability, and access-path contracts plus fail-closed authorization evaluation for metadata, abstract, full text, export, credential state, automation, and request/item/byte limits.
- Source-discovery access provenance, domain/authorized-source authoring guides, a 12-case access matrix, 10,000-rule/decision benchmark, and a sanitized `deepseek-v4-flash` routing boundary evaluation.

### Changed

- New projects and generated schemas use v1.1; `/research-init --domain` selects one of four built-in packages, while every v0.1–v1.0 project migrates without rewriting canonical records.
- Package and Extension versions advance to 1.1.0. Domain and authorization helpers are exported as public package entries.

### Known limitations

- No Chinese licensed-provider Adapter is shipped. Provider-specific work is deferred until a named provider, current contract, official interface, user-owned test entitlement, limits, and redistribution terms are available.
- Domain resources are maintainable starting rules, not authoritative disciplinary consensus. Installed Domain Package files are referenced rather than embedded in a portable project.
- Unknown third-party Adapter isolation remains v1.5 work; v1.1 adds no database, custom UI, hosted credential service, browser-login automation, CAPTCHA handling, or generic scraping.

## [1.0.0] - 2026-08-07

### Added

- Direct, backup-bound migration from every v0.1–v0.5 project, with a project lock, interruption recovery, immutable historical records, and Scenario D's 15-case migration matrix.
- Hash-bound project backup/restore, a categorized project doctor, deterministic policy-aware model routing, fast summary status, and rebuildable source/evidence/claim query indexes.
- Public v1 schemas and API documentation, Pi baseline/latest compatibility manifest, install/upgrade/recovery and support guides, threat model 1.0, governance policy, and RFC template.
- A 10,000-source/50,000-evidence performance gate and a sanitized `deepseek-v4-flash` recovery-routing boundary evaluation.

### Changed

- New projects and generated schemas use v1.0 while v0.1–v0.5 projects migrate directly without rewriting canonical records.
- Query cursors bind to the relevant canonical record-set fingerprint, so unrelated Operation writes no longer invalidate source, evidence, or claim pagination.
- Package and Extension versions advance to 1.0.0. Existing artifact generator algorithms retain their independent versions.

### Known limitations

- Public lifecycle and scale evidence uses synthetic, redistribution-safe fixtures; it does not establish external scholarly validity or independent-user usability.
- SourceAdapter remains experimental and in-process. Stable isolated third-party Adapters, exchange bundles, and SDK/RPC remain v1.5/v2.0 work.
- v1.0 has no database, custom UI, hosted service, account server, background Agent, or default multi-Agent scheduler.

## [0.5.0] - 2026-08-06

### Added

- AdapterExportProfile, ExternalItemLink, MonitorSubscription, and MonitorRun records with a recoverable v0.4-to-v0.5 manifest migration.
- `research_knowledge` and `research_monitor` aggregate Tools, `/research-monitor`, and bounded knowledge-export and literature-monitoring Skills.
- Zotero API v3 write intents and partial-result reconciliation; stable-ID RIS/BibTeX round trips; Obsidian vault/Bases, basic DOCX/PDF/XLSX/PPTX outputs, and a rebuildable cross-project catalog.
- Three failure cases, five checkpoint batches, a 10,000-source catalog benchmark, Office/Quick Look qualification, and a sanitized `deepseek-v4-flash` adapter/monitor boundary evaluation.

### Changed

- New projects and generated schemas use v0.5 while v0.1–v0.4 records and committed schemas remain readable.
- HTTP POST is governed as an external write before sensitive-read or paid-read classifications; identical project-file content is an idempotent no-op.
- Hash-verified staged files for new records commit by atomic rename, preserving transaction recovery while reducing the 1,000-segment Node 22.19 p95 from above five seconds to 2.239 seconds.
- Package, Extension, and Artifact generator versions advance to 0.5.0.

### Known limitations

- v0.5 has no background daemon, cloud sync, account service, real-time collaboration, vector database, or automatic manuscript update.
- Native PDF export supports ASCII text only; DOCX is the Unicode path. Office and Obsidian output is intentionally basic and rebuildable, not template-perfect.
- Zotero and provider state can drift externally; the package records and reconciles observed receipts but never treats the remote system as canonical.

## [0.4.0] - 2026-08-06

### Added

- Immutable Manuscript, Section, ClaimOccurrence, ReviewFinding, RevisionDecision, Disclosure, and SubmissionGate records with a recoverable v0.3-to-v0.4 manifest migration.
- `research_manuscript` and `research_review` aggregate Tools plus bounded academic writing, review, and revision Skills.
- Deterministic manuscript Markdown export, claim/evidence/citation/method/P0/disclosure/approval gates, revision diff and rollback audit, two synthetic manuscript examples, public review rubrics, and disclosure template.
- Twenty failure injections, a 50,000-word integrity benchmark, and a sanitized `deepseek-v4-flash` writing-boundary evaluation.

### Changed

- New projects and generated schemas use v0.4 while v0.1–v0.3 records and committed schemas remain readable.
- Package, Extension, and Artifact generator versions advance to 0.4.0.

### Known limitations

- v0.4 records submission-candidate readiness but never submits externally or claims human peer review.
- Deterministic gates prove declared provenance and invariants, not factual truth, narrative quality, or journal acceptance.
- Zotero/Obsidian, DOCX/PDF/XLSX/PPTX delivery adapters, monitoring, and cross-project catalogs remain v0.5 work.

## [0.3.0] - 2026-08-06

### Added

- Content-addressed CSV datasets, variable dictionaries, confirmed analysis specifications, and terminal Python/R/optional-Stata `AnalysisRun` records with command, runtime, logs, output hashes, and raw-input integrity checks.
- UTF-8 qualitative materials, stable paragraph locators, versioned codebooks, immutable model suggestions, explicit human accept/edit/reject decisions, supersession, negative cases, themes, and Markdown/JSON audit output.
- The `research_analysis` and `research_qualitative` aggregate Tools, quantitative/qualitative Skills, two public synthetic examples, runtime clean-room qualification, failure injection, method-boundary evaluation, and 1,000-row/segment benchmarks.
- Recoverable v0.2-to-v0.3 manifest migration that adds record sets and directories without moving data or inventing method records.

### Changed

- New projects and generated schemas use v0.3 while v0.1/v0.2 records and committed schemas remain readable.
- Batch record transactions use bounded concurrent file persistence while preserving hash verification and manifest-last commit order.
- Package, Extension, and Artifact generator versions advance to 0.3.0.

### Known limitations

- Local runtime scripts execute with the user's host account authority; v0.3 provides approval, copied inputs, immutable-original checks and audit records, not an OS sandbox.
- Python/R dependencies are detected or reported but never installed automatically. Stata is optional, user-owned, mock-qualified by default, and never bundled or license-inspected.
- CSV and UTF-8 plain text are the v0.3 canonical inputs; XLSX, notebooks, hosted compute, OCR, automatic coding acceptance, and significance-driven model selection are not included.

## [0.2.0] - 2026-08-06

### Added

- Versioned research questions, concepts, theory relations, critical design decisions, and quantitative or qualitative protocols.
- The `research_design` aggregate Tool, `research-design` Skill, deterministic design artifact, six public method fixtures, a frozen method-boundary rubric, and a replayable `deepseek-v4-flash` boundary check.
- Recoverable v0.1-to-v0.2 manifest migration with unchanged-project rollback and explicit interactive approval.
- Design status and pending-confirmation reporting through `/research-status` and `/research-resume`.

### Changed

- New projects use schema v0.2 while v0.1 records and committed schemas remain readable and immutable.
- Package, Extension, and Artifact generator versions advance to 0.2.0; the unchanged citation verifier retains its independent 0.1.0 algorithm version.

### Fixed

- Design artifacts retain evidence and claim closure without treating provenance Operations as renderable research content.
- Evidence-gap design input can begin with empty caller provenance because the kernel appends the current Operation before persistence.

### Known limitations

- v0.2 plans but does not run quantitative or qualitative analysis, contact participants, grant ethics approval, or register protocols externally.
- Critical design confirmation requires the interactive Pi terminal; headless calls remain recoverably pending.

## [0.1.0] - 2026-08-06

### Added

- File-based v0.1 research project contracts, atomic transactions, recovery, and validation.
- Governed Crossref, OpenAlex, Unpaywall, local bibliography, and local PDF workflows.
- Deterministic normalization, deduplication, PDF text location, evidence commits, citation checks, and artifact gates.
- Three research Skills, Scenario A replay, evidence-quality rubric, release scan, SBOM, and clean-install qualification.

### Fixed

- Windows transaction backup flushing and PDF.js asset URL resolution.

### Known limitations

- OpenAlex and Unpaywall require user-provided environment configuration and may be unavailable or changed independently of this package.
- Scanned PDFs are marked `OCR_REQUIRED`; v0.1 does not perform OCR.
- The SourceAdapter contract is experimental until v1.5.
- v0.1 has no database, custom UI, direct Zotero write, analysis runtime, monitoring service, or automated external submission.
