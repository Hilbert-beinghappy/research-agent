# Domain packages

Domain packages customize terminology, search synonyms, method rubrics, journal rules, and other discipline resources without patching the Research Agent core. v1.1 ships four Apache-2.0 manifests:

| Domain | Package ID | Priority status |
|---|---|---|
| Management | `pi-research-domain-management` | Initial priority |
| Public administration | `pi-research-domain-public-administration` | Initial priority |
| Sociology | `pi-research-domain-sociology` | Additional open package |
| Political science | `pi-research-domain-political-science` | Additional open package |

The manifests live under `domains/<domain>/domain.json`. They are data, not executable code.

## Manifest contract

Every `DomainPackageManifest` declares a stable package ID and version, domain ID and label, languages, package license, and at least one resource rule. Every rule has:

- a unique `ruleId` within the package;
- a `resourceType` and `key` that form its merge identity;
- a JSON value and integer precedence;
- provenance with origin, source title, source URL when applicable, license expression, and review date.

`loadDomainPackage` validates the JSON contract and rejects duplicate rule IDs. `resolveDomainResources` chooses the highest-precedence rule for each `resourceType:key`. Different values at equal precedence are a conflict and stop resolution. Resolved output is sorted by resource type, key, and package ID so the same inputs produce the same result.

## Activate a package

Initialize with a built-in domain:

```text
/research-init --domain sociology "Community participation"
```

Inspect or activate any validated manifest:

```text
/research-domain show
/research-domain set /path/to/domain.json
```

Activation changes `research-project.json`, so it requires interactive confirmation and records an Operation and Approval. The source manifest remains external read-only input; it is not copied into the project. If a referenced package is unavailable later, `/research-doctor` reports `DOMAIN_PACKAGE_ABSENT` and generic research guidance remains usable. The package absence never authorizes the model to invent domain rules.

For restart-safe third-party use, install a data-only npm package in the research project and export its manifest as `./domain.json`:

```json
{
  "name": "research-domain-example",
  "version": "1.0.0",
  "exports": { "./domain.json": "./domain.json" },
  "files": ["domain.json"]
}
```

Install third-party data packages only after review and disable lifecycle scripts where the package manager supports it. The loader resolves only that JSON export and never imports package code. Its manifest `packageId` and `packageVersion` must match the active project reference. During a running Pi process, `/research-domain set` uses a newly activated source manifest immediately; changing its content requires a new package version. After restart, a non-built-in package must be installed and resolvable from the project. Resource values are treated as data and cannot override system instructions or project policy.

## Authoring and distribution checklist

1. Use a new stable package ID and semantic package version.
2. Keep rules narrow and give deliberate precedence values; do not encode a global journal ranking in core code.
3. Record provenance and redistribution rights for every rule. `maintainer_authored`, `redistribution_approved`, `public_domain`, and `user_local` are distinct origins.
4. Do not copy proprietary Skill text, licensed taxonomies, subscription-only journal lists, personal paths, credentials, or private research data into a distributable package.
5. Run the domain loader, conflict tests, package check, release scan, and clean-install qualification before distribution.

A `user_local` rule can support a private installation, but its presence does not grant redistribution rights. Public packages must contain only material their publisher may lawfully distribute.
