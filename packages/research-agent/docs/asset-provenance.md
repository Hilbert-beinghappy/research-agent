# Asset provenance and redistribution decisions

The package was implemented as new Apache-2.0 code against public Pi Extension/Package APIs and the public architecture contract. Existing local research Skills were used only to enumerate desired capabilities and failure boundaries; their source, prompts, templates, private paths, and bundled assets were not copied.

| Capability source considered | Distribution decision | What entered the package |
|---|---|---|
| `research-paper-orchestrator`, `deep-research`, `academic-pipeline` | Requirements-only `ADAPT`; no source redistribution. | Newly written bounded workflow Skills. No Agent Team or parallel orchestrator. |
| `academic-citation`, `citation-verifier`, `vericite` | Clean-room `REWRITE`; original implementation excluded. | One deterministic identifier/metadata/publication-status verification path with recorded provider fixtures. |
| `paper-analyze`, `paper-search` | Clean-room `ADAPT/REWRITE`; original implementation excluded. | Page-located PDF blocks, bounded corpus query, EvidenceCard validation, and exact-excerpt checks. |
| Local PDF/DOCX/XLSX/PPTX Skills | Proprietary implementation `EXCLUDE_FROM_DISTRIBUTION`. | PDF.js-based text-layer parsing only. No proprietary prompt, template, renderer, or Office implementation. |
| `extract-paper-images`, local Obsidian Markdown/Bases tooling | Implementation `EXCLUDE`; format requirements only. | Newly written deterministic Obsidian-compatible Markdown/Bases export; no local Skill source or asset. |

## Bundled Skill manifest

All eleven directories below are original package documentation under Apache-2.0. They contain no copied model weights, private corpus, credential, executable, proprietary template, or third-party runtime.

| Skill | Origin decision | Runtime boundary |
|---|---|---|
| `research-project-intake` | Clean-room original | Scope guidance only |
| `literature-evidence` | Clean-room original informed by evidence requirements | Uses governed literature/document/evidence Tools |
| `literature-review` | Clean-room original | Synthesizes canonical records; bundled references are original |
| `research-design` | Clean-room original | Proposes; confirmed records are written by governed Tools |
| `quantitative-research` | Clean-room original | Uses confirmed, isolated local runtime execution |
| `qualitative-research` | Clean-room original | Keeps model suggestions separate from human decisions |
| `academic-writing` | Clean-room original | Drafts only from canonical claim/evidence/method records |
| `academic-review` | Clean-room original | Reviewer roles are rubrics, not independent evidence |
| `academic-revision` | Clean-room original | Preserves immutable revisions and user dispositions |
| `knowledge-export` | Clean-room original | Zotero export/push and Obsidian-compatible Markdown only |
| `literature-monitoring` | Clean-room original | User-triggered bounded batches; no daemon |

## Included original assets

- Package code, schemas, prompts, Skills, examples, and documentation: newly written for this package under Apache-2.0.
- Scenario A PDFs and bibliographic/provider fixtures: synthetic or minimized recorded test material documented by the adjacent fixture README files.
- Evaluation reviews and gold decisions: synthetic frozen Scenario A outputs under Apache-2.0.
- Public-corpus qualification manifest: NIST AI RMF 1.0 metadata, official URL, byte length, SHA-256, DOI, and NIST technical-publication rights reference. The PDF is fetched and hash-verified during the gated test; it is not vendored.

## Third-party software

Exact direct dependencies and their transitive production/optional closure are listed in `SBOM.spdx.json` and `THIRD_PARTY_NOTICES.md`. Host-provided Pi peers are listed separately and are not bundled. The release scanner permits only the eleven reviewed Skill directories and fails on unknown Skill content, test implementation directories, private config, personal paths, credential patterns, or unknown declared dependency licenses.

Any future proposal to reuse rather than clean-room rewrite an existing asset must add an immutable source hash, owner/license and modification rights, embedded asset inventory, dependency/license review, personal-data/secret scan, exact reused regions, and reviewer decision before code enters the release tree.
