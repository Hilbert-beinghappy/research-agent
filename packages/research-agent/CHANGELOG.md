# Changelog

## [Unreleased]

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
