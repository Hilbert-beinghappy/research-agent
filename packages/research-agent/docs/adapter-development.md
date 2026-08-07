# Adapter development v1

Third-party Adapters extend Pi Research Agent without patching Pi or the Research Package core. Use `@research-agent/contracts` for types and schemas, and choose exactly one category: `source`, `analysis_runtime`, or `artifact`.

## Minimum package

```text
my-adapter/
  adapter.json
  entry.mjs
  SBOM.spdx.json      # optional, but recommended
```

`adapter.json` must declare contract version 1, package and Adapter identity/version, category, entry point, capability requirements, required Host brokers, supported isolation profiles, SPDX license expression, provenance, package hash, and optional SBOM path/hash. Paths are portable relative paths; symlinks, traversal, case collisions, empty packages, and a mismatched package or SBOM hash are rejected.

The package hash covers distributable regular files other than `adapter.json` and `node_modules`; a separate canonical manifest hash binds every `adapter.json` field. Recompute the package hash after changing the entry point, README, or SBOM. Four complete public examples are under `examples/adapters/`, including the brokered-HTTP Source Adapter used by Scenario E.

## Process behavior

The v2.0 package's Adapter v1 runner launches the entry point with the current Node.js runtime. The entry point reads one JSON object per line from stdin and writes one JSON object per line to stdout. It must answer:

- `capabilities`, then `search` for a Source Adapter;
- `capabilities`, then `execute` for an Analysis Runtime Adapter;
- `capabilities`, then `render` for an Artifact Adapter.

Do not write logs to stdout; stdout is the protocol channel. Use stderr for bounded diagnostics. Return a single terminal result for each request. Use broker requests only for declared `http`, `credential`, `project_read`, or `staged_output` needs.

## Conformance

From the repository root:

```sh
npm run conform:adapter -w packages/research-agent -- ./my-adapter
npm run conform:adapter -w packages/research-agent -- ./my-adapter --strong
```

The first command checks the package and contract through a separate JSONL process. It is portable but is not an OS security sandbox. `--strong` uses macOS Seatbelt or Linux bubblewrap. On Windows or when the native mechanism is unavailable, it returns a blocked isolation result; it never silently falls back.

Conformance validates the package hash, SPDX license declaration, provenance, optional SBOM, capability identity, and one category operation. The conformance broker denies all external effects, so a fixture must complete without network access, credentials, project reads, or committed output.

## Registration in Pi

Unknown third-party code is denied by the default project policy. A user who has reviewed the package must deliberately change that policy to `ask`, then register interactively:

```text
/research-policy set {"unknownThirdPartyCode":"ask"}
/research-adapter inspect ./my-adapter
/research-adapter register ./my-adapter
```

Registration is ordered and fail closed:

1. parse and hash-check the package without executing it;
2. bind an approval to the exact package ID, version, file-closure hash, manifest hash, and `strong_isolation` profile;
3. after approval, run conformance under strong isolation;
4. record the registration only when the matching report passes.

The built-in interactive registration path supports qualified macOS and Linux profiles. Windows has no strong profile. There is no automatic downgrade to `jsonl_process`. Direct library callers own their policy and approval boundary and must not represent an ordinary conformance result as governed Pi registration.

## Distribution checklist

- Use a redistributable SPDX license and include required notices.
- Include only public fixtures; do not package credentials, personal paths, private papers, or proprietary Skills.
- Pin direct runtime dependencies and publish an SBOM when present.
- Pass ordinary conformance on supported platforms and strong qualification on the platform claimed by the package.
- State broker, runtime, provider, commercial-software, and data-redistribution requirements explicitly.
