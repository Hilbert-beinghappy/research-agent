# Asset provenance and redistribution decisions

v0.1 was implemented as new Apache-2.0 code against the public Pi Extension/Package APIs and the public architecture contract. Existing local research Skills were used only to enumerate desired capabilities and failure boundaries; their source, prompts, templates, private paths, and bundled assets were not copied into this package.

| Capability source considered | v0.1 distribution decision | What entered the package |
|---|---|---|
| `research-paper-orchestrator`, `deep-research`, `academic-pipeline` | Requirements-only `ADAPT`; no source redistribution. | Three newly written, bounded Skills for intake, evidence workflow, and review synthesis. No Agent Team or parallel orchestrator. |
| `academic-citation`, `citation-verifier`, `vericite` | Clean-room `REWRITE`; original implementation excluded. | One deterministic identifier/metadata/publication-status verification path with recorded provider fixtures. |
| `paper-analyze`, `paper-search` | Clean-room `ADAPT/REWRITE`; original implementation excluded. | Page-located PDF blocks, bounded corpus query, EvidenceCard validation, and exact-excerpt checks. |
| Local PDF/DOCX/XLSX/PPTX Skills | Proprietary implementation `EXCLUDE_FROM_DISTRIBUTION`. | PDF.js-based text-layer parsing only. No proprietary prompt, template, renderer, or Office implementation. |
| `extract-paper-images`, Obsidian Markdown/Bases | `EXCLUDE` from v0.1 runtime. | No code or asset. Re-evaluate only in the scheduled later version with a separate license review. |

## Included original assets

- Package code, schemas, prompts, Skills, examples, and documentation: newly written for this package under Apache-2.0.
- Scenario A PDFs and bibliographic/provider fixtures: synthetic or minimized recorded test material documented by the adjacent fixture README files.
- Evaluation reviews and gold decisions: synthetic frozen Scenario A outputs under Apache-2.0.

## Third-party software

Exact direct dependencies and their transitive production/optional closure are listed in `SBOM.spdx.json` and `THIRD_PARTY_NOTICES.md`. Host-provided Pi peers are listed separately and are not bundled. The release scanner permits only the three reviewed Skill directories and fails on unknown Skill content, test implementation directories, private config, personal paths, credential patterns, or unknown declared dependency licenses.

Any future proposal to reuse rather than clean-room rewrite an existing asset must add an immutable source hash, owner/license and modification rights, embedded asset inventory, dependency/license review, personal-data/secret scan, exact reused regions, and reviewer decision before code enters the release tree.
