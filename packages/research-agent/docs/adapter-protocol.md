# Adapter process protocol and isolation

Adapter protocol v1 is newline-delimited JSON over stdin/stdout. Each message has `protocol: "pi-research-adapter-jsonl"`, `version: 1`, and a non-empty `messageId`.

## Message flow

1. The Host sends one `request` with a method and JSON payload.
2. The Adapter may send zero or more `broker_request` messages linked to that request.
3. The Host answers each accepted request with a `broker_response`.
4. The Adapter sends exactly one terminal `result` linked to the Host request and exits successfully.

The runner rejects malformed JSON, unknown shapes, duplicate results, mismatched request IDs, inconsistent success/error fields, oversized output, timeout, abort, stdin/launch failure, and a process that crashes or exits without a valid result. A malformed Adapter produces a canonical failure; it does not crash the Pi host.

## Host brokers

| Broker | Intended boundary |
|---|---|
| `http` | A destination-, policy-, budget-, and approval-governed request. |
| `credential` | Resolve an approved credential alias without persisting the secret in project state. |
| `project_read` | Read declared, validated project data through Host mediation. |
| `staged_output` | Write only to Host-controlled staging for later schema/path/hash validation and commit. |

Subprocess execution is not a broker. An Adapter cannot request arbitrary Host command execution through protocol v1.

## Isolation profiles

| Profile | Process separation | Direct network | Inherited secrets | Project/private read | Project write | Platform claim |
|---|---|---|---|---|---|---|
| `jsonl_process` | Yes | Possible under the user account | Environment is stripped by the runner | Possible where OS permissions allow | Limited by the supplied working directory, not an OS sandbox | Protocol/conformance portability only |
| `strong_isolation` | Yes | Denied | Environment is stripped | Only declared package roots, runtime libraries, and staging are readable | Staging only | Built-in implementation and qualification on macOS |
| `legacy_trusted` | No public untrusted-code guarantee | Host authority | Host authority | Host authority | Host authority | Trusted legacy declaration only |

Strong isolation currently uses the native macOS sandbox profile. Qualification demonstrates denial of direct network, undeclared private reads, project writes, credential inheritance, and subprocess execution. Linux and Windows strong profiles are not claimed in v1.5. If the requested profile is unavailable, the operation is blocked; the runner does not weaken isolation automatically.

The isolation profile controls direct process authority. Governed effects still require Host broker policy and approval. Conversely, `jsonl_process` is a protocol boundary, not protection from malicious code.

## Resource and output limits

The Host sets a positive timeout and combined stdout/stderr byte limit for every invocation. It launches an exact executable without a shell, supplies an absolute working directory, and passes a minimal environment. Broker replies and terminal results are schema checked. Staged files are not canonical output until the Host validates paths, hashes, schemas, permissions, and the project transaction.
