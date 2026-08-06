# Adapter capability matrix v0.3

Capabilities are runtime observations, not permanent claims about an external service. Dates and prices below are the implementation snapshot used by v0.1; run health checks and inspect operation receipts before relying on a provider.

| Adapter/component | v0.1 capability | Credential | Cost model | Pagination/resume | Data egress | Explicit degradation |
|---|---|---|---|---|---|---|
| Crossref `0.1.0` | Health, DOI search/lookup, bibliographic metadata, update/retraction relations. | Optional `CROSSREF_MAILTO`. | Recorded as USD 0 for the public endpoint. | Cursor pages; cursor expires after five minutes. | Query and identifiers sent to Crossref. | Missing/invalid fields, 429/5xx, cursor loss, status ambiguity and parse errors are structured. |
| OpenAlex `0.1.0` | Health, search/lookup, OpenAlex/DOI IDs, retraction flag, topic and OA metadata. | Required `OPENALEX_API_KEY`. | Search snapshot USD 0.001/call as of 2026-08-06; explicit request budget and broker accounting. | Cursor pages and resumable spend cursor. | Query and identifiers sent to OpenAlex. | No key degrades to Crossref/local; price drift, budget exhaustion, auth, rate limit and provider-cost conflict block or warn. |
| Unpaywall `0.1.0` | DOI OA location, version, host, license and best-location selection. | Required `UNPAYWALL_EMAIL`. | Recorded as USD 0. | No pagination. | DOI sent to Unpaywall. | No email, no DOI, closed work, unknown license, service or parse failure remain explicit; no paywall bypass. |
| Local import | RIS, BibTeX, CSL-JSON, PDF signature detection, copy/reference mode, raw hash. | None. | None. | File batch only. | None. | Bad encoding/format can be partial success; bare PDF requires later bibliographic matching. |
| PDF parser | Text-layer PDF blocks with page/section locators and parser/input hashes. | None. | None. | Per document. | None. | Scans report `OCR_REQUIRED`; encrypted, corrupt, oversized or non-PDF content reports structured failure. |
| Artifact renderer | Deterministic Markdown, JSON, RIS and BibTeX with input snapshot and gates. | None. | None. | Not applicable. | None unless the user later moves/submits output. | Unlocated evidence, unresolved source state and unverified citations block submission-candidate status. |
| Local Python/R runtime | Detect an existing executable and run a confirmed script against copied, hash-checked inputs in a per-run directory. | None. | Local compute only. | One terminal `AnalysisRun` per attempt. | None by the adapter; the script has the host process account's authority. | Missing runtime/package/variable/output, crash, timeout, abort, non-convergence and raw mutation are explicit failures. No dependency installation. |
| Optional Stata runtime | Detect a user-owned `stata-mp`, `stata-se`, or `stata` executable and use the declared batch `-b do` contract after approval. | User's lawful local installation. | Commercial runtime outside this package. | One terminal `AnalysisRun` per attempt. | None by the adapter. | No bundled binary, license-file inspection, automatic installation, or CI claim of real Stata execution. |
| Qualitative workbench | UTF-8 text import, paragraph locator indexing, codebook/suggestion/decision/theme records, Markdown/JSON audit. | None. | None. | Immutable records and explicit supersession. | Model suggestions follow project model-egress policy. | No automatic coding acceptance, de-identification service, saturation claim, or participant contact. |

## Trust and contract status

Crossref and OpenAlex implement the exported experimental `SourceAdapter` contract and receive only an `AdapterContext` with a governed HTTP broker. Unpaywall uses the same capability snapshot and broker context for document location. Analysis and qualitative components are built-in internal tools, not the stable third-party Adapter v1 contract planned for v1.5. Built-in code is reviewed and runs in process.

The TypeScript contract cannot prevent arbitrary third-party in-process code from calling Node filesystem, network, environment, or process APIs directly. v0.1 therefore does not load unknown Adapters or call them sandboxed. The stable third-party contract, conformance kit, and strong-isolation protocol are v1.5/v2.0 work.

## Not present in v0.3

No Semantic Scholar, CORE, DataCite, Europe PMC, licensed Chinese database, direct Zotero API/write, OCR service, notebook server, hosted compute, dependency installer, Obsidian, DOCX, XLSX, PPTX, monitoring, or generic web-scraping Adapter is shipped. Local proprietary Skills are neither copied nor included in the tarball.
