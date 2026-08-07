# v1.5 release evidence and limitations

v1.5 freezes the public Source, Analysis Runtime, and Artifact Adapter contract v1; publishes `@research-agent/contracts`; adds JSONL process execution, macOS strong isolation, package conformance and governed registration; adds Exchange Bundle and record-only Collaboration ChangeSet v1; and records deterministic model-route decisions.

## Upgrade

Projects from v0.1 through v1.1 migrate directly to schema `1.5.0` through the existing backup-bound migration command. The migration adds the v1.5 record-set declarations and directories, updates the manifest schema/revision, and preserves every historical canonical record byte-for-byte. It does not register an Adapter, create an exchange, infer a route, or execute third-party code. Rollback uses the verified migration backup and is allowed only before a later v1.5 project write.

The project schema, Research Package version, Adapter contract version, and `@research-agent/contracts` package version are recorded separately. They happen to ship together in this release but are not defined as permanently identical version streams.

## Release gates

```sh
npm run check -w packages/research-agent-contracts
npm test -w packages/research-agent-contracts
npm run scan:release -w packages/research-agent-contracts
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent
npm run test:compat -w packages/research-agent
npm run eval:v1.5 -w packages/research-agent -- v1.5
npm run benchmark:v1.5 -w packages/research-agent
npm run qualify:isolation:v1.5 -w packages/research-agent
npm run scan:release -w packages/research-agent
```

Three independent example packages cover Source, Analysis Runtime, and Artifact categories and pass ordinary conformance. The macOS qualification executes an attack fixture and observes zero successful direct-network connections, private reads, project writes, inherited credentials, or subprocess launches.

The 10,000-record Darwin arm64 / Node 22.19.0 benchmark uses three real pack/import/full-validation samples. Its frozen p95 is 1,827.620 ms for export and 9,960.572 ms for import plus full project validation, both below the 60-second gate. It makes no model or provider call.

The authorized `deepseek-v4-flash` boundary check made one model invocation, used two provider turns, and cost USD 0.054175. It selected static inspection and package verification before approval, strong-isolation conformance before registration, a privacy-eligible local model, and approval for unknown code, paid model use, and external exchange write. It refused in-process unknown code, direct network/credential/project authority, restricted-data egress, Session/secret export, and approval bypass. The public evaluator replays the sanitized, hash-bound result without making another model call.

## Known limitations

- Built-in strong isolation is macOS-only in v1.5. Linux and Windows run protocol/conformance tests but have no claimed strong profile; registration blocks instead of downgrading.
- The shipped conformance runner launches Node.js entry points; additional runtime launchers are not part of Adapter contract v1.5.
- `jsonl_process` separates protocol failures from the Host but is not an OS sandbox.
- Unsigned exchange root hashes bind files, not every manifest metadata field; use and verify an Ed25519 signature when origin authentication is required.
- Default exchange excludes raw inputs, Session, credentials, and internal state but does not classify or redact sensitive text inside canonical records, notes, or artifacts.
- Collaboration is deterministic record transfer, not real-time synchronization. Referenced files must be exchanged separately.
- Model-route quality depends on current, honest candidate metadata. Routing does not execute a model or approve a paid/sensitive call.
- v1.5 adds no marketplace, hosted service, remote code execution, CRDT, message queue, database, or separate UI.
