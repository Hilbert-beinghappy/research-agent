---
name: literature-monitoring
description: Create and run versioned Crossref or OpenAlex literature monitors with explicit user confirmation, bounded cost and requests, deterministic deduplication, immutable cursor checkpoints, and retryable failure records. Use when the user asks for alerts, new-paper checks, recurring searches, or ongoing literature surveillance.
---

# Literature Monitoring

Monitoring is a user-triggered search workflow, not a background daemon. Use `research_monitor` or `/research-monitor run <monitor-subscription-id>` for one confirmed batch.

## Workflow

1. Run `/research-monitor list` and reuse the latest revision of an existing series when its query still matches.
2. Create a monitor with `research_monitor` and `action: "create"`. Freeze the adapter, query, filters, maximum results, request limit, and cost limit.
3. Revise rather than overwrite when the query, budget, or status changes. A query change resets the cursor; a budget-only change preserves it.
4. Before `action: "run"`, show the adapter, query, current cursor, and budget. Continue only after the user confirms.
5. Inspect created and reused Source IDs, raw response files, request count, cost, errors, and the next MonitorSubscription revision.
6. On partial success, preserve both sources and errors. On failure, use the retry task; the prior cursor must remain unchanged.
7. Use `literature-evidence` for full-text acquisition, close reading, evidence cards, and citation verification of newly found sources.

## Boundaries

- Do not claim a zero-result search when the adapter failed, rate-limited, or exhausted its budget.
- Do not infer that monitoring is exhaustive across licensed databases or historical literature.
- Do not run unattended scheduling inside Pi. External cron, launchd, or Task Scheduler may invoke a user-owned command only after the project has a suitable non-interactive approval policy.
- Do not advance a stale subscription revision or silently change adapter versions.
