# Changelog

## [Unreleased]

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
