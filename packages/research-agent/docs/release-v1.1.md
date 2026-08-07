# v1.1 release evidence and limitations

v1.1 adds replaceable discipline resources and the authorization contract required for lawful provider adapters. It keeps Pi core unchanged, uses the Pi terminal, stores canonical state in versioned files, and introduces no database or separate UI.

## Delivered

- Four validated Apache-2.0 Domain Packages for management, public administration, sociology, and political science.
- Deterministic resource precedence and equal-precedence conflict rejection.
- `/research-init --domain`, `/research-domain show`, and confirmed, audited domain activation.
- `AccessPolicySnapshot`, `DownloadLimit`, `EntitlementCapability`, access paths, and fail-closed access evaluation.
- Source-discovery provenance that distinguishes official APIs, supported exports, and user-authorized files.
- Direct migration from v1.0 and every supported v0.x project to schema 1.1 without rewriting historical records.
- Public authoring, authorization, evaluation, benchmark, and migration documentation.

## Release evidence

| Gate | Observed result |
|---|---|
| Domain inventory | 4/4 manifests validate; sociology and political science provide two additional disciplines; each package has at least three provenance-bearing rules. Two independently installed data-only fixture packages resolve through the public loader without a core patch. |
| Authorization matrix | 12/12 frozen cases pass for active, missing, expired, revoked, capability, automation, and request/item/byte-limit states. |
| Deterministic tests | 112 unit/contract, 64 integration, 17 E2E, and 2 Pi compatibility tests pass. |
| Clean install | The packed package loads with 15 commands under Pi 0.83.0 and 0.84.0 on Node 22.19.0. |
| Performance | 10,000-rule resolution p95 2.918 ms; 10,000 access decisions p95 0.15 ms on Darwin arm64 / Node 22.19.0; zero model/API calls. |
| Model boundary | One authorized `deepseek-v4-flash` invocation, two provider turns, USD 0.045345; no tools or web requests. It refused unverified provider use, login simulation, CAPTCHA/limit bypass, credential persistence, abstract promotion, and unbounded completeness. |
| Provider readiness | `deferred`: no provider-specific licensed adapter is shipped because the required contract, API, entitlement, limits, and redistribution evidence were not supplied. |

The default deterministic evaluator replays only sanitized public inputs and the recorded model result. It does not call a provider.

## Exit status and limitations

The domain-package and authorized-source contracts are release-qualified. The architecture's real licensed-source pilot remains open: v1.1 does not pretend that a mock provider satisfies it. A future provider package must pass the checklist in `authorized-sources.md` with the user's lawful entitlement and sanitized fixtures.

Domain rules are maintainer-authored starting resources, not authoritative disciplinary consensus. Search completeness remains bounded by recorded queries, dates, adapters, cursors, entitlements, and failures. v1.1 does not add scraping, browser-login automation, CAPTCHA handling, hosted credentials, proprietary database content, unknown Adapter isolation, a database, a separate UI, or background agents.
