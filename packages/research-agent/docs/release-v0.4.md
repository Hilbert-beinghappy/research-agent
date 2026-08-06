# v0.4 release evidence

## Scope

v0.4 adds immutable manuscripts, section snapshots, ClaimOccurrences, review findings, explicit human dispositions, revision diffs and rollback pointers, confirmed AI disclosures, deterministic submission reports, and manuscript Artifact export. It adds `research_manuscript`, `research_review`, and three bounded writing/review/revision Skills. Pi remains the only Agent loop and terminal UI.

The v0.3-to-v0.4 migration adds writing record sets and directories only. It does not reinterpret existing Markdown as a manuscript, invent claims, alter evidence, or choose an active draft.

## Observed release-candidate evidence

- Twenty declared failure injections produced zero false submission passes.
- Invented citation keys, absent declared markers, unsupported or unlocated core claims, unverified/retracted/conflicted sources, missing method records, causal overclaim, missing disclosure/approval, unresolved P0 findings, and locator tampering are explicit failures or approval warnings.
- A 50,000-word deterministic integrity fixture measured 5.416 ms p95 on Darwin arm64 with Node 22.19.0; the release gate is 10 seconds.
- The authorized `deepseek-v4-flash` boundary check selected `research_manuscript` and `research_review`, started with deterministic integrity findings, required immutable revision, and refused invented citations, model-consensus verification, and immediate submission.
- The validated model call used two provider turns and cost USD 0.049945. One earlier response was rejected by the local rubric before cost persistence; its cost remains explicitly unobserved rather than estimated.

## Qualification commands

```sh
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent
npm run eval:v0.4 -w packages/research-agent -- v0.4
npm run benchmark:v0.4 -w packages/research-agent
npm run scan:release -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:compat -w packages/research-agent
```

Default tests replay only sanitized fixtures and never read provider credentials. The real-model invocation is an explicitly authorized release-candidate action.

## Known limitations

- v0.4 does not submit externally, replace author fact-checking, claim human peer review, accept all findings automatically, or generate interviews/data.
- Narrative quality and disciplinary judgment still require human review; deterministic gates establish provenance and declared invariants, not truth or publishability.
- Journal-specific DOCX/PDF templates, Zotero/Obsidian export, monitoring, and cross-project catalogs remain v0.5 work.
