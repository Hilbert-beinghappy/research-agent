# Research project format 1.5 in package v2.0

## Source of truth

`research-project.json` and the versioned JSON records under `.research/records/` are the canonical research state. Pi Session stores only a link to the project ID, manifest path, observed revision, and last operation. A Session can be discarded without losing research facts; a project can be reopened from another Session with `/research-open`.

The current schema version is `1.5.0`. Package v2.0 adds SDK/RPC protocol schemas under `schemas/v2.0` but does not change canonical project state. Public project JSON Schemas are under `schemas/v1.5`, generated from `@research-agent/contracts`; the committed v0.1–v1.1 schemas remain immutable. Unknown fields are preserved where the persisted contract permits them. An older manifest opens read-only until `/research-migrate` is confirmed, and a newer schema remains read-only. All supported v0.1–v1.1 versions migrate directly to the v1.5 manifest shape without rewriting canonical record files.

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
    plugins/adapters/
    exchanges/
    collaboration/merges/
    model-routes/
    analysis-runs/
    tasks/
    operations/
    artifacts/
    approvals/
  runs/<operation-or-analysis-run-id>/
  transactions/{pending,committed,failed}/
  migrations/{pending,committed,rolled-back,staging}/
  backups/{staging,committed}/
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
| `SourceRecord` | Bibliographic metadata, identifiers, discovery provenance including access path/policy snapshot, dedup state, metadata conflicts, publication status. |
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
| `AdapterRegistrationRecord` | Exact package manifest, successful conformance report, isolation profile, status, package hash, and registration provenance. |
| `ExchangeRecord` | Packed/imported bundle identity, manifest hash, peer project/revision, raw-material flag, status, and Operation provenance. |
| `CollaborationMergeRecord` | ChangeSet hash, applied/skipped records, exact conflicts, and all-or-nothing merge status. |
| `ModelRouteDecision` | Hash of the request, selected candidate or block, per-candidate reasons, and decision time. It is not proof of model execution. |
| `ProjectCatalog` / `CrossProjectSourceRef` | Rebuildable file index of strong identifiers across selected projects. It is hash-checked derived state, not a project record set. |
| `ResearchTask` | Workflow state, dependencies, attempts, cursor, budget and errors. |
| `OperationRecord` | Actor/model/Adapter execution, exact inputs and outputs, raw receipts, approvals, usage, cost and failure. |
| `ArtifactRecord` | Derived output file, input snapshot, generator version, hash, publishability and gate results. |
| `ApprovalRecord` | Exact action fingerprint, scope, destination/path/cost boundary and decision. |

Metadata, abstract, acquired full text, located full-text evidence, and verified citation are independent fields. An abstract can support an explicitly abstract-level statement only. A locator and exact-match result are required before a card can claim `fulltext_located`.

## Transactions and recovery

Canonical writes use expected manifest and record revisions. A multi-file transaction stages content, verifies old/new hashes, writes records, and updates the manifest last. Interrupted work remains under `.research/transactions/pending`; `/research-recover` requires an interactive choice to commit or roll it back. `/research-validate` reports mixed state, broken hashes, references, paths, or records rather than repairing them silently.

Original PDFs, imported CSV/text, analysis scripts/environments, and raw provider receipts are content-addressed immutable inputs. Analysis executes copies and rechecks every original hash afterward; a mutation attempt fails the run and restores the original bytes. Derived parsed text, outputs, exports, and indexes can be rebuilt from their input hashes and generator versions. Raw files and excerpts retain their access and redistribution status; project ownership does not imply public redistribution rights.

## v0.1–v1.1 to v1.5 migration

Migration changes only the manifest schema version, revision, record-set declarations, required directories, and the default built-in Domain Package reference when it is absent. v1.5 adds empty Adapter-registration, exchange, collaboration-merge, and model-route record sets. It does not create records, infer missing facts, move data, register code, or reinterpret a historical record. Preparation creates a full hash-bound project backup and hash-bound before/after manifest snapshots. One project-scoped migration lock prevents concurrent writers. An interrupted staged directory is discarded and prepared again; an interrupted pending migration resumes. Rollback verifies the backup and restores the old manifest only when no later v1.5 write occurred.

Scenario D keeps the frozen v1.0 matrix covering v0.1–v0.5 at staged-write, record-replace, and manifest-commit interruption points. v1.5 additionally tests direct migration from every prior schema through v1.1, including the default Domain Package reference and new empty record sets. No migration rewrites canonical records.

## Domain and access policy state

The manifest stores the active domain ID/label and Domain Package ID/version. Domain manifests remain package inputs rather than copied project facts. Activating another package is a confirmed manifest transaction with Operation and Approval records. A missing package degrades domain guidance and is reported by the doctor; it does not corrupt the project.

New source-discovery events may store an `accessPath` and immutable `AccessPolicySnapshot`. The snapshot is the observed policy boundary for that discovery, not a credential or a legal conclusion. Historical discovery events without these optional fields remain readable. v1.1 production discovery paths always populate them.

Design, analysis-specification, codebook, and theme confirmation are record states, not chat implications. Headless confirmation leaves the record at `awaiting_confirmation`; `/research-resume` returns its kind, ID, and revision. Rejected or superseded records remain auditable. A model suggestion is immutable and never becomes a human coding decision through confirmation by inference.

## Portability

Manifest paths and file references use normalized project-relative POSIX paths. Absolute paths, parent traversal, symlink escape, and case-colliding portable paths are rejected. A `reference` import can intentionally remain machine-local and is marked non-portable; use `copy` for a self-contained project when rights permit it.

Session files, credential values, caches, locks, installed Domain Packages, installed Python/R packages, and commercial Stata binaries are not part of a portable project exchange. v1.5 stores package references/hashes, policy snapshots, credential aliases, and external item IDs/versions. The Exchange Bundle includes canonical records, parsed sources, notes, and artifacts; raw originals/imports require explicit opt-in. Default exclusion does not redact sensitive text already present in records, notes, or artifacts. Obsidian, Office, PDF, project-catalog, and corpus-index files are derived and may be deleted/rebuilt; Zotero remains external. A project backup includes canonical state and project-local immutable inputs but excludes caches, locks, and nested backups.

## Derived corpus index

Source, evidence, and claim queries may use `.research/cache/corpus-*-v1.json`. Each file is bound to the relevant canonical record-set fingerprint and its own content hash. A missing, corrupt, or stale cache is rebuilt from canonical files. PDF blocks remain hash-checked from their live parsed documents. The cache is never a source of truth and may be deleted; v1.5 does not require SQLite or another database.
