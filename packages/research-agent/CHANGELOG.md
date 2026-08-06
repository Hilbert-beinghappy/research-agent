# Changelog

## [Unreleased]

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
