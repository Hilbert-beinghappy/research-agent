# Contributing

Pi Research Agent accepts focused changes that preserve evidence boundaries, deterministic project state, and Pi upstream compatibility.

## Development requirements

- Node.js 22.19.0 or newer.
- Install from the repository root with `npm ci --ignore-scripts`.
- Never place API keys, provider responses containing private data, copyrighted full text, or personal absolute paths in fixtures.
- Use synthetic or redistribution-approved fixtures. Record provenance and license notes beside any external fixture.

Run the checks appropriate to a package change:

```sh
npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent
npm run scan:release -w packages/research-agent
```

Run `npm run generate:schemas -w packages/research-agent` after changing the TypeBox contract source, and `npm run generate:release-metadata -w packages/research-agent` after changing production dependencies.

Compatibility changes must also run both supported install lanes:

```sh
npm run test:clean-install -w packages/research-agent
npm run test:clean-install:latest -w packages/research-agent
npm run test:compat -w packages/research-agent
```

## Change rules

- Keep canonical research facts in versioned project records, not Pi Session entries or generated prose.
- Keep deterministic parsing, hashing, validation, deduplication, policy, and export logic in code rather than Skills.
- Never promote metadata or an abstract to located full-text evidence.
- Preserve structured failure, partial-success, cost, provenance, and publication-status records.
- Do not bypass paywalls, authentication, user confirmation, or provider terms.
- Do not add a database, custom UI, multi-Agent runtime, or broad compatibility layer without a measured release trigger.
- Keep v1.x public result and project contracts backward-readable. A breaking schema, default security-policy, or public-contract change requires an accepted RFC and migration plan.
- Modify evaluation gold separately from implementation changes and explain why the change does not lower a gate.

An Adapter contribution needs a capability snapshot, recorded contract tests, failure semantics, credential and policy documentation, fixture provenance, and a distributable license. A licensed-provider contribution also needs the inputs in `docs/authorized-sources.md`. The v1.1 in-process source contract remains experimental and does not confer sandbox isolation. Governance and the RFC process are documented in `GOVERNANCE.md` and `docs/rfcs/0000-template.md`.
