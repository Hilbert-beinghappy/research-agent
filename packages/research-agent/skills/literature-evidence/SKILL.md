---
name: literature-evidence
description: Build auditable literature evidence from open academic sources and local files. Use for searching or importing literature, obtaining lawful full text, close reading, evidence cards, claim-evidence links, citation verification, or requests mentioning 检索、筛选、精读、证据卡、引文核验.
---

# Literature Evidence

Build canonical evidence without allowing metadata, abstracts, or model memory to masquerade as located full text. Reply in the user's language.

## Workflow

1. Confirm that the project scope is usable. If it is still ambiguous, use the `research-project-intake` skill first.
2. Retrieve or import sources with `research_search_sources` or `research_import_sources`. Report possible duplicates and metadata conflicts instead of choosing silently.
3. Use `research_documents` to locate, lawfully acquire, and parse documents. Do not bypass a paywall, authentication boundary, license restriction, size limit, or approval decision.
4. Use `research_query_corpus` to inspect bounded source, document, evidence, and claim hits. Continue pagination explicitly; do not infer unseen results.
5. Draft evidence at the level actually returned:
   - metadata supports only bibliographic or discovery statements;
   - abstract evidence must be described as what the abstract reports;
   - `fulltext_unlocated` cannot support an exact quotation or page claim;
   - located full text requires the returned document, page or section locator, and anchor;
   - table, figure, dataset, and appendix evidence must keep their specific level.
6. Use `research_commit_evidence` with strict validation and the current project revision. On a revision conflict, reread current state and rebuild the request; never patch canonical records directly.
7. Use `research_verify_citations` before treating an identifier, citation field, or publication status as verified. Service failure, not-found, conflict, expiry, retraction, or correction remains explicit.
8. Use `research_artifacts` to generate an evidence matrix after the relevant ClaimRecord and EvidenceCard snapshots exist.

## Evidence decisions

- Keep evidence statements separate from the synthesis recorded in claims.
- Record `supports`, `qualifies`, and `contradicts` relationships as observed; do not flatten disagreement.
- Preserve limitations, boundary conditions, missing full text, and uncertain metadata.
- Never invent an excerpt, locator, DOI, author, year, result, sample, or method.
- If evidence is insufficient, say what is missing and name the next bounded action.

## Completion report

Report completed and failed operations separately. List sources without usable full text, unverified citations, unresolved conflicts, unsupported or mixed claims, evidence gaps, and the next action. Do not call a source screened, read, verified, or complete unless the corresponding tool result records that state.
