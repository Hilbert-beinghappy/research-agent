# CLI, Skills, and Tools

## Pi commands

| Command | Actual v0.1 behavior | State change |
|---|---|---|
| `/research-version` | Show the loaded package version. | None |
| `/research-init [title]` | Initialize the current empty directory, create the bootstrap task and operation, and link the Pi Session. | Adds a project; no overwrite |
| `/research-open [path]` | Validate and link an existing current-schema project. | Session link only |
| `/research-status` | Return stage, revision, record counts, task/operation/full-text/evidence/citation status, and recorded budget totals. | None |
| `/research-resume` | Return incomplete or blocked tasks and operations with cursors and errors. | None |
| `/research-validate` | Validate schemas, hashes, references, portable paths, and pending transactions. | None |
| `/research-recover [commit|rollback] [transaction-id]` | Commit or roll back one pending transaction after interactive confirmation. | Confirmed recovery only |
| `/research-policy` | Show policy. `/research-policy set {"sensitivity":"internal"}` proposes a validated patch and records the decision. | Policy changes require confirmation |

All commands except the version notification return a canonical `ResearchResult` as JSON. In non-interactive mode, actions requiring confirmation return `PERMISSION_BLOCKED`; they do not infer consent.

There is no `/research-export` command in v0.1. Deterministic export is the `research_artifacts` Tool so that source references, operation state, output hashes, and gates remain in one path.

## Skills and prompts

| Resource | Purpose |
|---|---|
| `/skill:research-project-intake` | Clarify a management or public-administration topic, scope, concepts, and search intent. |
| `/skill:literature-evidence` | Plan discovery, imports, full-text checks, corpus queries, evidence cards, and citation verification. |
| `/skill:literature-review` | Synthesize claims, conflicts, evidence gaps, a matrix, and a bounded review. |
| `/scope-review` | Expand the topic/scope review prompt. |
| `/integrity-review` | Expand the evidence and citation integrity prompt. |

Skills orchestrate model judgment. They do not parse PDFs, decide dedup matches, validate excerpts, verify identifiers, or write canonical records themselves.

## Governed Tools

| Tool | Input responsibility | Output responsibility |
|---|---|---|
| `research_search_sources` | Frozen query plan, Crossref/OpenAlex selection, filters, result/request budget, cache policy. | Normalized and deduplicated SourceRecords, raw response references, usage and errors. |
| `research_import_sources` | Project-relative or explicitly selected RIS, BibTeX, CSL-JSON, or PDF inputs and copy/reference mode. | Imported candidates, immutable copies or references, parse issues, dedup decisions. |
| `research_documents` | `locate`, `acquire`, `parse`, or `retry_failed`, source IDs, acquisition policy. | Access, license, full-text, parser, locator, and structured failure states. |
| `research_query_corpus` | Bounded text query, record scope, filters, limit, character bound, cursor. | Deterministically paginated source-located hits. |
| `research_commit_evidence` | Strict EvidenceCard and Claim drafts plus expected project revision. | Validated canonical evidence/claims or a revision/provenance failure. |
| `research_verify_citations` | Source IDs, Crossref/OpenAlex providers, refresh rule, field thresholds. | Existence, metadata, publication-status checks and final verification state. |
| `research_artifacts` | Structured export or Markdown commit, source record refs, target status, optional portable output path. | Markdown/JSON/RIS/BibTeX output, hash, ArtifactRecord, warnings and blockers. |

Tool parameter schemas are registered with Pi from `src/extension/tools.ts`. Tool responses always distinguish `SUCCESS`, `PARTIAL_SUCCESS`, retryable/permanent failure, permission block, and data conflict.

## Minimal interactive flow

```text
/research-init "Algorithmic transparency and public trust"
/skill:research-project-intake
Define a bounded public-administration research question and a reproducible search plan. Use Crossref first, import my local RIS file if I provide one, and keep abstract-only evidence separate.
/skill:literature-evidence
Execute the confirmed plan, report duplicate and full-text states, then create located evidence cards with exact excerpts.
/skill:literature-review
Build the evidence matrix, verify cited sources, show contradictions and gaps, and produce an evidence-checked review. Do not mark it submission-ready if any gate fails.
```
