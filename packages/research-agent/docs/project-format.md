# Research project format v0.5

## Source of truth

`research-project.json` and the versioned JSON records under `.research/records/` are the canonical research state. Pi Session stores only a link to the project ID, manifest path, observed revision, and last operation. A Session can be discarded without losing research facts; a project can be reopened from another Session with `/research-open`.

The current schema version is `0.5.0`. Public JSON Schemas are under `schemas/v0.5`, generated from `src/contracts/schemas.ts`; the committed v0.1–v0.4 schemas remain immutable. Unknown fields are preserved where the persisted contract permits them. A v0.4 manifest opens read-only until `/research-migrate` is confirmed, and a newer schema remains read-only. Migrations never skip schema generations.

## Layout

```text
research-project.json
README.md
.research/
  records/
    sources/
    documents/
    evidence/
    claims/
    citations/
    design/
      questions/
      concepts/
      theory-relations/
      decisions/
      protocols/
    data/{datasets,variables,specifications}/
    qualitative/{materials,segments,codebooks,suggestions,decisions,themes}/
    writing/{manuscripts,sections,claim-occurrences,review-findings,revision-decisions,disclosures,submission-gates}/
    adapters/{export-profiles,external-links}/
    monitors/{subscriptions,runs}/
    analysis-runs/
    tasks/
    operations/
    artifacts/
    approvals/
  runs/<operation-or-analysis-run-id>/
  transactions/{pending,committed,failed}/
  migrations/{pending,committed,rolled-back,staging}/
  backups/
  locks/
  cache/
sources/
  originals/{datasets,materials}/
  imports/analysis/
  parsed/
notes/
artifacts/{reviews,matrices,manuscripts,exports,drafts,designs,final,catalogs,knowledge}/
```

Each analysis run has an independent `.research/runs/<analysis-run-id>/` directory containing copied inputs, outputs, stdout, and stderr. Canonical run facts live in `.research/records/analysis-runs`; the run directory alone is not evidence of success.

## Record boundaries

| Record | Canonical fact |
|---|---|
| `SourceRecord` | Bibliographic metadata, identifiers, discovery provenance, dedup state, metadata conflicts, publication status. |
| `DocumentRecord` | Access and license state, immutable local file hash, full-text/parser state, parsed block references. |
| `EvidenceCard` | Material level, locator, exact excerpt check, claim relation, rights, validity and supersession. |
| `ClaimRecord` | Scoped assertion, evidence links, conflicts, and derived support status. |
| `CitationVerification` | Existence, field checks, conflicts, publication status, provider receipts, expiry and final state. |
| `ResearchQuestionVersion` | Versioned question type, scope, rationale, boundaries, confirmation and supersession chain. |
| `ConceptRecord` | Construct definition, role, aliases, measurement notes, boundaries and confirmation. |
| `TheoryRelation` | Directed relation, hypothesis/proposition, alternatives, boundaries and linked concepts. |
| `DesignDecision` | Options, selection, rationale, trade-offs, limitations, evidence basis and explicit decision. |
| `ProtocolRecord` | Quantitative or qualitative method, sampling, measurement, identification/selection logic, analysis plan, ethics and feasibility boundaries. |
| `DatasetRecord` / `VariableRecord` | Content-addressed CSV input, sensitivity, dimensions, inferred data type and missingness dictionary. Inference is not substantive measurement validation. |
| `AnalysisSpecification` | Confirmed runtime, script, environment file, input snapshot, parameters, seed, arguments, expected outputs, timeout and claim mode. |
| `AnalysisRun` | Exact runtime/command context, copied inputs, script/environment hashes, logs, outputs, input-integrity results and terminal success/failure/non-convergence. |
| `QualitativeMaterial` / `QualitativeSegment` | Authorized UTF-8 material and half-open character locator with anchor hash; segmentation does not imply coding. |
| `CodebookVersion` / `ModelSuggestion` / `CodingDecision` | Versioned confirmed code definitions, immutable model proposals, and separate user accept/edit/reject decisions with supersession history. |
| `ThemeSynthesis` | Human-decision inputs, supporting segments, codes, negative cases, confirmation and supersession. |
| `ManuscriptRecord` / `SectionRecord` | Immutable paper revision, ordered section snapshots, bibliography, method snapshots, content hashes and supersession chain. |
| `ClaimOccurrence` | Exact section character range and anchor hash linking a core/non-core occurrence to Claim, EvidenceCard, and citation keys. |
| `ReviewFinding` / `RevisionDecision` | Deterministic or model/human review concern plus an explicit user disposition or active-revision change. |
| `DisclosureRecord` / `SubmissionGateReport` | Confirmed AI-use disclosure and deterministic readiness checks with coverage, P0 state, approval and publishability. |
| `AdapterExportProfile` / `ExternalItemLink` | Versioned destination/format/credential alias and the per-record external item/version/hash/reconciliation state. External systems are never canonical facts. |
| `MonitorSubscription` / `MonitorRun` | Immutable query/Adapter/budget/cursor revision and one confirmed batch's inputs, results, cost, errors, retry task, and next checkpoint. |
| `ProjectCatalog` / `CrossProjectSourceRef` | Rebuildable file index of strong identifiers across selected projects. It is hash-checked derived state, not a project record set. |
| `ResearchTask` | Workflow state, dependencies, attempts, cursor, budget and errors. |
| `OperationRecord` | Actor/model/Adapter execution, exact inputs and outputs, raw receipts, approvals, usage, cost and failure. |
| `ArtifactRecord` | Derived output file, input snapshot, generator version, hash, publishability and gate results. |
| `ApprovalRecord` | Exact action fingerprint, scope, destination/path/cost boundary and decision. |

Metadata, abstract, acquired full text, located full-text evidence, and verified citation are independent fields. An abstract can support an explicitly abstract-level statement only. A locator and exact-match result are required before a card can claim `fulltext_located`.

## Transactions and recovery

Canonical writes use expected manifest and record revisions. A multi-file transaction stages content, verifies old/new hashes, writes records, and updates the manifest last. Interrupted work remains under `.research/transactions/pending`; `/research-recover` requires an interactive choice to commit or roll it back. `/research-validate` reports mixed state, broken hashes, references, paths, or records rather than repairing them silently.

Original PDFs, imported CSV/text, analysis scripts/environments, and raw provider receipts are content-addressed immutable inputs. Analysis executes copies and rechecks every original hash afterward; a mutation attempt fails the run and restores the original bytes. Derived parsed text, outputs, exports, and indexes can be rebuilt from their input hashes and generator versions. Raw files and excerpts retain their access and redistribution status; project ownership does not imply public redistribution rights.

## v0.4 to v0.5 migration

Migration changes only the manifest schema version, revision, record-set declarations, and required adapter/monitor/artifact directories. It does not create profiles, infer external IDs, schedule searches, export data, advance a cursor, reinterpret an existing Artifact, or modify a v0.4 record. Preparation stores hash-bound before/after snapshots; an interrupted pending migration can resume. Rollback restores the v0.4 manifest only when the current manifest still exactly matches the migrated snapshot. Any later v0.5 manifest write makes rollback lossy and therefore blocked.

Design, analysis-specification, codebook, and theme confirmation are record states, not chat implications. Headless confirmation leaves the record at `awaiting_confirmation`; `/research-resume` returns its kind, ID, and revision. Rejected or superseded records remain auditable. A model suggestion is immutable and never becomes a human coding decision through confirmation by inference.

## Portability

Manifest paths and file references use normalized project-relative POSIX paths. Absolute paths, parent traversal, symlink escape, and case-colliding portable paths are rejected. A `reference` import can intentionally remain machine-local and is marked non-portable; use `copy` for a self-contained project when rights permit it.

Session files, credential values, caches, locks, installed Python/R packages, and commercial Stata binaries are not part of a portable project exchange. v0.5 includes only credential aliases and external item IDs/versions. Obsidian, Office, PDF, and project-catalog files are derived and may be deleted/rebuilt; Zotero remains external. v0.5 does not claim container-level reproducibility or define the v1.5 exchange bundle format.
