# CLI, Skills, and Tools

## Pi commands

| Command | Actual v2.0 behavior | State change |
|---|---|---|
| `/research-version` | Show the loaded package version. | None |
| `/research-init [--domain <id>] [title]` | Initialize the current empty directory with a built-in domain, create the bootstrap task and operation, and link the Pi Session. The default is public administration. | Adds a project; no overwrite |
| `/research-open [path]` | Validate and link an existing current-schema project. | Session link only |
| `/research-migrate [path]` | Create a verified backup, then migrate any supported v0.1–v1.1 manifest directly to v1.5 after confirmation. `/research-migrate rollback <id>` restores the backup only when no later write occurred. | Confirmed migration or unchanged rollback |
| `/research-backup [list \| create [label]]` | List backups or create a content-hashed snapshot of canonical project files and immutable inputs. | `create` adds a backup outside canonical record sets |
| `/research-restore <backup-id> <empty-destination>` | Verify a backup manifest, file hashes, root hash, and project identity, then restore into a new empty directory. | Adds files only to the empty destination |
| `/research-doctor [path]` | Diagnose schema compatibility, integrity, missing files, pending transactions/migrations, Adapter and Domain Package availability, and declared external drift. | None; repair actions are recommendations |
| `/research-adapter inspect <package-directory>` | Parse, validate, hash-check, and describe an Adapter package without running it. | None |
| `/research-adapter register <package-directory>` | After policy and interactive approval, run macOS strong-isolation conformance and record only a matching successful registration. | Operation, Approval, and AdapterRegistration records; blocks when strong isolation is unavailable |
| `/research-exchange pack [--include-raw] <new-directory>` | Create a hash-verified portable bundle. Raw originals/imports require explicit opt-in. | External destination and ExchangeRecord after approval |
| `/research-exchange unpack <json>` | Verify and import a bundle into a new destination; JSON contains `bundle` and `destination`. | New project directory and ExchangeRecord after approval |
| `/research-model-route <v1-json-input>` | Select or block one model deterministically under project policy, sensitivity, capability, context, and cost constraints. | Appends an Operation and ModelRouteDecision; no model call |
| `/research-status [full]` | Default summary reads the manifest only. `full` scans canonical records for task/operation/full-text/evidence/citation/design/analysis/writing/export-profile/monitor status and recorded budget totals. | None |
| `/research-monitor [list \| run <id>]` | List the latest monitor revision in each series or run one interactive, confirmed provider batch. | `list` is read-only; `run` records an Operation, MonitorRun, sources, and either a checkpoint or retry task. |
| `/research-resume` | Return incomplete or blocked work plus pending design/method records, open P0 findings, and the current manuscript revision. | None |
| `/research-validate` | Validate schemas, hashes, references, portable paths, and pending transactions. | None |
| `/research-recover [commit|rollback] [transaction-id]` | Commit or roll back one pending transaction after interactive confirmation. | Confirmed recovery only |
| `/research-policy` | Show policy. `/research-policy set {"sensitivity":"internal"}` proposes a validated patch and records the decision. | Policy changes require confirmation |
| `/research-domain [show \| set <manifest-path>]` | Show the active domain or validate and activate a Domain Package manifest. | Activation requires confirmation and records Operation/Approval state. |

All commands except the version notification return the v1 canonical `ResearchResult` JSON envelope. Its stable fields are `ok`, `status`, `value`, `errors`, and `meta`; `meta` carries `operationId`, `taskId`, and warnings. In non-interactive mode, actions requiring confirmation return `PERMISSION_BLOCKED`; they do not infer consent.

There is no `/research-export` command in v2.0. Deterministic research outputs use `research_artifacts`; profiles, Zotero reconciliation, and cross-project catalogs use `research_knowledge`; whole-project portability uses `/research-exchange`. Record-only collaboration is a TypeScript API rather than an automatic sync command. The optional `research-agent-rpc` executable is a separate inspection-only stdio interface documented in `sdk-rpc.md`; it adds no mutation command.

## Skills and prompts

| Resource | Purpose |
|---|---|
| `/skill:research-project-intake` | Clarify a management or public-administration topic, scope, concepts, and search intent. |
| `/skill:literature-evidence` | Plan discovery, imports, full-text checks, corpus queries, evidence cards, and citation verification. |
| `/skill:literature-review` | Synthesize claims, conflicts, evidence gaps, a matrix, and a bounded review. |
| `/skill:research-design` | Turn canonical evidence or an explicit gap into versioned questions, concepts, relations, decisions, and protocols that require user confirmation. |
| `/skill:quantitative-research` | Import a CSV, inspect its dictionary, confirm a Python/R/Stata specification, and audit immutable inputs, logs, output hashes, and failures. |
| `/skill:qualitative-research` | Import de-identified text, preserve stable locators, separate model suggestions from human coding, retain negative cases, and render an audit trail. |
| `/skill:academic-writing` | Create sectioned immutable manuscript revisions with ClaimOccurrence, bibliography, method, disclosure, and gate links. |
| `/skill:academic-review` | Apply deterministic and judgment rubrics without treating model roles as independent evidence. |
| `/skill:academic-revision` | Record user dispositions, create a new immutable revision, inspect diffs/rollback, and rerun the submission gate. |
| `/skill:knowledge-export` | Create an export profile, generate portable formats, reconcile Zotero writes, and query a rebuildable project catalog without changing canonical facts. |
| `/skill:literature-monitoring` | Create/revise a monitor and run one confirmed Crossref/OpenAlex batch with immutable cursors, budgets, deduplication, and retry state. |
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
| `research_artifacts` | Structured export or Markdown commit, source record refs, target status, optional portable output path. | Markdown, JSON, RIS/BibTeX, Obsidian ZIP, DOCX, PDF, XLSX, or PPTX output, hash, ArtifactRecord, warnings and blockers. |
| `research_knowledge` | Create an export profile; render it; push a bounded Zotero batch; build/query a selected-project catalog. | Profile/link/task records, portable Artifact, external-write reconciliation, or content-hashed catalog results. |
| `research_monitor` | Create/revise/list a subscription or run one confirmed provider page under its query, cursor, request, and cost bounds. | Immutable MonitorRun plus exactly one next checkpoint on success/partial success, or a retry task with unchanged cursor on failure. |
| `research_design` | Create a question, concept, relation, critical decision, or protocol; or confirm/reject an exact record revision. | Versioned design record, explicit confirmation state, Operation provenance, or a method/dependency/revision failure. |
| `research_analysis` | Import UTF-8 CSV, create/decide a frozen specification, detect Python/R/Stata, or run an approved local script. | Dataset/variable/specification records, terminal Task and AnalysisRun, command/cwd/runtime, logs, output hashes, raw-integrity checks, or explicit failure. |
| `research_qualitative` | Import UTF-8 text, segment, version/decide a codebook or theme, record a model suggestion or human coding decision, or render an audit. | Stable segment locators, immutable suggestions, human decisions/supersession, themes/negative cases, and Markdown/JSON audit output. |
| `research_manuscript` | Create/diff immutable revisions, confirm disclosure, or evaluate a submission candidate. | Manuscript/Section/ClaimOccurrence/Disclosure/SubmissionGate records and deterministic blockers. |
| `research_review` | Record deterministic or model findings, capture the user's disposition, or change the active revision pointer. | Deduplicated ReviewFinding and immutable RevisionDecision records with provenance. |

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
/skill:research-design
Turn the confirmed review and gaps into one quantitative and one qualitative design. Keep associational and causal wording separate, show alternatives and limitations, and ask me to confirm every critical record.
/skill:quantitative-research
Import my authorized CSV, show the inferred dictionary, freeze an associational Python or R specification, and do not run it until I confirm the exact command and inputs.
/skill:qualitative-research
Import my de-identified text, segment it once, propose a codebook, and keep every model suggestion separate until I explicitly accept, edit, or reject each coding decision.
/skill:academic-writing
Draft one immutable manuscript revision from confirmed project records. Map every core claim to located evidence and its citation, and do not invent missing support.
/skill:academic-review
Run deterministic integrity findings first, then apply the relevant method and evidence rubrics. Label all model findings as AI review.
/skill:academic-revision
Record my disposition for each finding, create a new revision, show the diff, confirm the disclosure, and stop before submission unless the gate passes and I approve it.
/skill:knowledge-export
Create a project-file export profile, generate an Obsidian vault and DOCX, then show the exact destination and records before any Zotero write.
/skill:literature-monitoring
Create a bounded Crossref monitor for the confirmed query. Run only one batch after I confirm; preserve the old cursor on any failure and do not edit the manuscript automatically.
```
