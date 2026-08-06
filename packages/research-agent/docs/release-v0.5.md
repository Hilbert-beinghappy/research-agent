# v0.5 release evidence

## Scope

v0.5 adds export profiles, external item links, Zotero API v3 write reconciliation, deterministic RIS/BibTeX stable-ID round trips, Obsidian vault/Bases export, basic DOCX/PDF/XLSX/PPTX outputs, hash-checked cross-project catalogs, and user-confirmed Crossref/OpenAlex monitors. It adds `research_knowledge`, `research_monitor`, two bounded Skills, and `/research-monitor`; Pi remains the only Agent loop and terminal UI.

The v0.4-to-v0.5 migration only adds record sets and directories. It never sends data, invents external links, creates a monitor, or changes a cursor.

## Observed release-candidate evidence

- RIS/BibTeX preserve canonical source-ID hints and strong identifiers; Obsidian path/link escaping and source-ID reload pass on synthetic records.
- DOCX, XLSX, and PPTX archives pass ZIP validation and macOS recognizes their Office media types; DOCX/PDF/XLSX/PPTX all produced Quick Look previews. Native PDF explicitly rejects non-ASCII text instead of corrupting it; use DOCX for Unicode.
- Zotero partial success records one synced and one failed ExternalItemLink plus a retry task; an identical synced source is omitted from the next batch. Broker tests require approval for POST and bind credentials by alias.
- Five monitor batches advance five immutable checkpoints. A rate-limited batch keeps the last successful cursor, and validation rejects a checkpoint not produced by its referenced run.
- A two-project DOI fixture has duplicate recall 1.0. Loading, validating, and querying a 10,000-source file catalog measured 20.486 ms p95 on Darwin arm64/Node 22.19.0 against a 2-second gate.
- The authorized `deepseek-v4-flash` check used two invocations/four provider turns and USD 0.08349 total. The validated response chose both aggregate Tools and preserved approval, credential, cursor, daemon, and immutable-manuscript boundaries. No web or tool request ran.

## Qualification commands

```sh
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent
npm run eval:v0.5 -w packages/research-agent -- v0.5
npm run benchmark:v0.5 -w packages/research-agent
npm run scan:release -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:compat -w packages/research-agent
```

Default tests replay only sanitized fixtures and never read provider credentials. Live Zotero sandbox use is optional and requires a user-owned key plus explicit external-write approval; the release gate uses recorded responses.

## Known limitations

- No background daemon, cloud sync, account system, real-time collaboration, vector database, or automatic manuscript update.
- The built-in Office/PDF renderers produce simple portable outputs, not journal-template parity. Native PDF is ASCII-only in v0.5.
- A project catalog is an O(n) rebuildable JSON file. The 10,000-source gate is comfortably met; add an index only after measured larger projects require it.
- Provider cursors and remote items can drift. A successful write/run receipt is recorded provenance, not a guarantee of historical search completeness or remote permanence.
