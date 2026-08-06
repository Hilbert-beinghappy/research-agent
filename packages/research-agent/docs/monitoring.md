# Literature monitoring and scheduling

v0.5 monitoring is a bounded command, not a resident Agent. A subscription stores one exact Crossref/OpenAlex query, Adapter version, request/cost caps, and cursor. Each `/research-monitor run <id>` executes one provider page only after an interactive confirmation, deduplicates through canonical SourceRecords, and atomically writes a MonitorRun plus the next subscription revision. A failed run writes a retry task and retains the previous cursor.

## Pi terminal

```text
/skill:literature-monitoring
Create a Crossref monitor for the confirmed query with at most two requests and zero paid cost.
/research-monitor list
/research-monitor run <latest-monitor-subscription-id>
```

Always run the latest revision shown by `list`. A query, Adapter version, budget, pause, or retirement change creates another immutable subscription revision. Monitoring results enter the source ledger only; they do not edit a review or manuscript.

## External trigger boundary

Pi SDK/RPC clients may invoke the registered `research_monitor` Tool or `/research-monitor` command, but v0.5 does not accept inferred or unattended consent. A headless run returns `PERMISSION_BLOCKED/MONITOR_RUN_CONFIRMATION_REQUIRED`. The client must present the exact query, provider, cursor, and budget to a user in an interactive Pi context. Do not insert `confirmedAt` directly or edit monitor records by hand.

OS schedulers should therefore schedule a reminder or open a user-facing Pi session, not bypass confirmation:

- cron: run a local reminder script that prints the project and monitor ID, then execute the Pi command interactively.
- launchd: use a user LaunchAgent to display a notification or open the project terminal at the desired time.
- Windows Task Scheduler: select “Run only when user is logged on” and start the project terminal with the monitor ID visible.
- SDK/RPC: keep the client process short-lived, surface the approval prompt, wait for the Result, then exit.

Scheduler configuration, executable paths, project paths, credentials, and notification tooling are machine-local and never belong in a portable project. Add an unattended service only after a later version defines revocable pre-authorization, missed-run semantics, and the same ledger/policy boundary; v0.5 intentionally has no daemon.
