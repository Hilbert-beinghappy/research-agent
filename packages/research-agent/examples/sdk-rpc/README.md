# Two-project SDK/RPC example

Start the local RPC process with two existing research projects. Replace the paths and project IDs with values from each `research-project.json`.

```sh
research-agent-rpc \
  --project /absolute/path/to/management-project \
  --project /absolute/path/to/public-administration-project
```

Send newline-delimited requests on stdin:

```json
{"protocol":"pi-research-rpc","version":1,"requestId":"capabilities","method":"system.capabilities","params":null}
{"protocol":"pi-research-rpc","version":1,"requestId":"projects","method":"projects.list","params":null}
{"protocol":"pi-research-rpc","version":1,"requestId":"validate","method":"project.validate","params":{"projectId":"prj_replace_with_manifest_id"}}
{"protocol":"pi-research-rpc","version":1,"requestId":"sources","method":"records.list","params":{"projectId":"prj_replace_with_manifest_id","kind":"source"}}
{"protocol":"pi-research-rpc","version":1,"requestId":"source","method":"records.read","params":{"projectId":"prj_replace_with_manifest_id","kind":"source","id":"src_replace_with_record_id"}}
```

The SDK uses identical requests and results:

```ts
import { createResearchSdk } from "pi-research-agent/sdk";

const sdk = await createResearchSdk([
  "/absolute/path/to/management-project",
  "/absolute/path/to/public-administration-project",
]);

const result = await sdk.invoke({
  protocol: "pi-research-rpc",
  version: 1,
  requestId: "projects",
  method: "projects.list",
  params: null,
});
```

This surface is inspection-only. Return to the Pi terminal for any canonical write, approval, migration, Adapter registration, external exchange, or submission workflow.
