# Research project format v0.2

## Source of truth

`research-project.json` and the versioned JSON records under `.research/records/` are the canonical research state. Pi Session stores only a link to the project ID, manifest path, observed revision, and last operation. A Session can be discarded without losing research facts; a project can be reopened from another Session with `/research-open`.

The current schema version is `0.2.0`. Public JSON Schemas are under `schemas/v0.2`, generated from `src/contracts/schemas.ts`; the committed v0.1 schemas remain immutable. Unknown fields are preserved where the persisted contract permits them. A v0.1 manifest opens read-only until `/research-migrate` is confirmed, and a newer schema remains read-only.

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
    tasks/
    operations/
    artifacts/
    approvals/
  runs/<operation-id>/
  transactions/{pending,committed,failed}/
  migrations/{pending,committed,rolled-back,staging}/
  backups/
  locks/
  cache/
sources/
  originals/
  imports/
  parsed/
notes/
artifacts/{reviews,matrices,exports,drafts,designs,final}/
```

The public contract also defines `AnalysisRun`, but v0.2 does not create an analysis record set or execute Python, R, or Stata. That runtime starts in v0.3.

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
| `ResearchTask` | Workflow state, dependencies, attempts, cursor, budget and errors. |
| `OperationRecord` | Actor/model/Adapter execution, exact inputs and outputs, raw receipts, approvals, usage, cost and failure. |
| `ArtifactRecord` | Derived output file, input snapshot, generator version, hash, publishability and gate results. |
| `ApprovalRecord` | Exact action fingerprint, scope, destination/path/cost boundary and decision. |

Metadata, abstract, acquired full text, located full-text evidence, and verified citation are independent fields. An abstract can support an explicitly abstract-level statement only. A locator and exact-match result are required before a card can claim `fulltext_located`.

## Transactions and recovery

Canonical writes use expected manifest and record revisions. A multi-file transaction stages content, verifies old/new hashes, writes records, and updates the manifest last. Interrupted work remains under `.research/transactions/pending`; `/research-recover` requires an interactive choice to commit or roll it back. `/research-validate` reports mixed state, broken hashes, references, paths, or records rather than repairing them silently.

Original PDFs and raw provider receipts are immutable inputs. Derived parsed text, exports, and indexes can be rebuilt from their input hashes and generator versions. Raw files and excerpts retain their access and redistribution status; project ownership does not imply public redistribution rights.

## v0.1 to v0.2 migration

Migration changes only the manifest schema version, revision, record-set declarations, and required directories. It does not invent a research question, rewrite a v0.1 record, or treat prior evidence as confirmed design. Preparation stores hash-bound before/after snapshots; an interrupted pending migration can resume. Rollback restores the v0.1 manifest only when the current manifest still exactly matches the migrated snapshot. Any later v0.2 manifest write makes rollback lossy and therefore blocked.

Design confirmation is a record state, not a chat implication. Headless confirmation leaves the record at `awaiting_confirmation`; `/research-resume` returns its kind, ID, and revision. Revisions rejected or superseded remain auditable.

## Portability

Manifest paths and file references use normalized project-relative POSIX paths. Absolute paths, parent traversal, symlink escape, and case-colliding portable paths are rejected. A `reference` import can intentionally remain machine-local and is marked non-portable; use `copy` for a self-contained project when rights permit it.

Session files, credentials, caches, locks, and external provider secrets are not part of a portable project exchange. v0.2 does not yet define the v1.5 exchange bundle format.
