---
name: knowledge-export
description: Export canonical research records to RIS, BibTeX, Obsidian, DOCX, PDF, XLSX, PPTX, or a user-owned Zotero library while preserving source IDs, adapter mappings, evidence gates, and retryable failures. Use when the user asks to export, sync, hand off, archive, or move a research project between tools.
---

# Knowledge Export

Use `research_knowledge` for reusable profiles, Zotero reconciliation, and cross-project catalogs. Use `research_artifacts` for a one-off deterministic file export.

## Workflow

1. Run `/research-status` and identify the exact canonical record revisions to export.
2. Create an export profile with `research_knowledge` and `action: "create_profile"`. File profiles must target a project-relative path. Zotero profiles must reference a credential alias, never a key value.
3. For RIS, BibTeX, Obsidian, DOCX, PDF, XLSX, or PPTX, call `action: "export_profile"`. Treat the returned Artifact record and hash as the export receipt.
4. For Zotero, show the destination library and source count, then call `action: "zotero_push"`. External writes require approval. Keep successful, failed, and unchanged item mappings separate.
5. Retry only failed mappings. A source with the same canonical content hash and a confirmed external item link is not sent again.
6. Use `action: "build_catalog"` only for a derived cross-project index. Query it with `action: "query_catalog"`; never merge projects automatically.
7. Reload exported files and confirm preserved source IDs, expected counts, and hashes before calling the handoff complete.

## Boundaries

- Canonical project records remain the source of truth; Zotero, Obsidian, and office files are adapters.
- Do not place credentials, absolute personal paths, restricted abstracts, or unapproved excerpts in exports.
- PDF currently rejects non-ASCII manuscript text; use DOCX for Unicode until a distributable font path is implemented.
- Do not overwrite an existing path, write externally, or transmit sensitive data without the recorded approval.
