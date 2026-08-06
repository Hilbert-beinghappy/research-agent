---
name: academic-revision
description: Close the loop between review findings, explicit human dispositions, immutable manuscript revisions, revision diffs, rollback, disclosure, and the submission gate. Use when the user asks to revise a paper, respond to findings, compare drafts, roll back, or prepare a submission candidate.
---

# Academic Revision

Use `research_review` for human decisions and active-revision changes, then use `research_manuscript` for a new immutable revision.

## Workflow

1. List unresolved findings for the exact manuscript revision. Separate P0 blockers from P1 and P2 advice.
2. Present each finding with its evidence and proposed response. Call `research_review` with `action: "decide_finding"` only after the user explicitly chooses a disposition and rationale.
3. Create the revised manuscript with `research_manuscript` and `action: "create_revision"`; set `supersedesManuscriptId` and preserve unchanged ClaimOccurrences and bibliography links.
4. Run `action: "diff"`. Verify accepted findings are reflected, rejected or deferred findings retain the user's rationale, and no new unsupported core claim or citation key was introduced.
5. Use `research_review` with `action: "set_active_revision"` for adoption or rollback. This changes the auditable pointer; it never overwrites either revision.
6. Update and confirm the AI disclosure when model use changed. Re-run the submission gate after every manuscript revision.
7. Generate the final manuscript artifact only when the deterministic gate passes and the user approves submission-candidate status.

## Stop Conditions

- Do not silently accept all findings, erase rejected advice, rewrite raw evidence, or alter prior revisions.
- Do not bypass unresolved P0 findings, missing evidence locators, unverified citations, method failures, or disclosure confirmation.
- Do not submit or write to an external system.
