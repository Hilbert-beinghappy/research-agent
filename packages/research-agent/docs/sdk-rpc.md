# SDK and stdio RPC v1

`pi-research-agent` 2.0.1 exposes the same inspection dispatcher through a TypeScript SDK and a local newline-delimited JSON RPC process. Both surfaces operate only on project roots supplied by the caller at startup. They do not accept arbitrary filesystem paths in requests and do not expose canonical mutation methods.

The package and SDK report 2.0.1 while `@research-agent/contracts` remains 2.0.0. The canonical research project schema is 1.5.1. A 1.5.0 project opens read-only until its provenance migration is confirmed.

## SDK

```ts
import { createResearchSdk } from "pi-research-agent/sdk";

const sdk = await createResearchSdk([
  "/absolute/path/to/management-project",
  "/absolute/path/to/public-administration-project",
]);

const projects = await sdk.invoke({
  protocol: "pi-research-rpc",
  version: 1,
  requestId: "projects-1",
  method: "projects.list",
  params: null,
});
```

`createResearchSdk` opens every configured root, indexes it by canonical `projectId`, and rejects duplicate IDs that point to different roots. Reopening occurs for each request, so the SDK observes committed project state instead of keeping a second canonical cache.

Project summaries return `projectId` and `research-project:<projectId>` by default, not an absolute root. A trusted local embedder that specifically needs host paths can opt in with `createResearchSdk(roots, { includeHostPaths: true })`.

## RPC

```sh
research-agent-rpc \
  --project /absolute/path/to/management-project \
  --project /absolute/path/to/public-administration-project
```

The executable reads one `pi-research-rpc` v1 request per stdin line and writes one response per stdout line. Blank lines are ignored. The default maximum request line is 1 MiB. It opens no socket, daemon, database, account, or cloud service.

`--include-host-paths` is an explicit local-host opt-in. Without it, RPC output and capabilities report host paths as redacted.

```json
{"protocol":"pi-research-rpc","version":1,"requestId":"list-1","method":"records.list","params":{"projectId":"prj_replace_with_manifest_id","kind":"source"}}
```

```json
{"protocol":"pi-research-rpc","version":1,"requestId":"read-1","method":"records.read","params":{"projectId":"prj_replace_with_manifest_id","kind":"source","id":"src_replace_with_record_id"}}
```

Every response has the following envelope. `result` is the same `ResearchResult` contract used by the SDK and deterministic Research Tools.

```json
{"protocol":"pi-research-rpc","version":1,"requestId":"list-1","result":{"ok":true,"status":"SUCCESS","value":[],"errors":[],"meta":{"operationId":null,"taskId":null,"warnings":[]}}}
```

## Stable methods

| Method | Params | Result value |
|---|---|---|
| `system.capabilities` | `null` | Package/schema versions, method list, access/mutation/path boundary, and supported/unsupported evidence submission levels |
| `projects.list` | `null` | Summaries of all configured projects |
| `project.open` | `{ projectId }` | Current summary and canonical manifest |
| `project.validate` | `{ projectId }` | Full deterministic validation report |
| `project.doctor` | `{ projectId }` | Read-only doctor report and manual repair plan |
| `records.list` | `{ projectId, kind }` | Sorted canonical record IDs |
| `records.read` | `{ projectId, kind, id }` | One validated canonical record |

Malformed JSON, an invalid method/parameter shape, an unconfigured project ID, a missing record, or a read-only legacy project returns a structured failure. One failed request does not terminate the RPC stream.

## Permission boundary

The stable SDK/RPC subset is inspection-only by design. Project creation, migration, Adapter registration, external writes, paid calls, deletion, overwrite, exchange, collaboration merge, and publication stay on Pi-governed commands and Tools, where policy checks create Approval and Operation records. An external UI may render SDK/RPC results, but it must return users to those governed surfaces for mutations.

This boundary does not sandbox the external UI or authenticate against the host user. A malicious process running as the user may still access files allowed by the operating system. Adapter/analysis isolation is separate: `jsonl_process` is only a protocol boundary; strong process profiles use macOS Seatbelt or Linux bubblewrap and block on Windows.

The seven methods, request/response envelopes, Adapter v1, sandbox protocol v1, Exchange v1, core records, Result/Error, Operation/Approval, and migration policy are stable v2.0 surfaces. Model-routing heuristics, real-time collaboration, and UI widgets remain experimental and are not canonical dependencies.
