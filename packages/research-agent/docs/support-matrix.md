# v2.0 support matrix

| Capability | Ubuntu | macOS | Windows |
|---|---|---|---|
| Pi package load, project state, discovery, evidence, writing | Required CI | Required CI | Required CI |
| Project migration, doctor, backup/restore, path and lock behavior | Required CI | Required CI | Required CI |
| Built-in Domain Packages and authorized-source policy evaluation | Required CI | Required CI | Required CI |
| Pi 0.83.0 baseline and 0.84.0 latest-stable clean install | Required CI | Required CI | Required CI |
| Python analysis runtime | Required real execution under Linux bubblewrap | Required real execution under macOS Seatbelt | Strong isolation unavailable; host-user fallback requires explicit approval and is not qualified |
| R analysis runtime | Real runtime qualification under Linux bubblewrap when installed | Real runtime qualification under macOS Seatbelt when installed | Explicit capability skip unless installed; no strong-isolation claim |
| Stata runtime | Contract only; real licensed runner not qualified | Same | Same |
| DOCX/PDF/XLSX/PPTX and Obsidian-compatible Markdown outputs | Deterministic structure tests | Deterministic structure tests and optional local preview | Deterministic structure tests |
| Licensed Chinese provider Adapter | Deferred until a named provider, contract, official interface, test entitlement, limits, and redistribution terms are supplied | Same | Same |
| Adapter contract v1 and ordinary JSONL conformance | Required CI; process boundary is not a sandbox | Required CI; process boundary is not a sandbox | Required CI; process boundary is not a sandbox |
| Strong-isolation Adapter qualification and governed registration | Required bubblewrap qualification: direct network/private read/project write/credential denied and child processes contained | Required Seatbelt qualification with the same boundary | Not claimed; registration blocks |
| Exchange Bundle and record-only collaboration | Required deterministic tests | Required deterministic tests plus 10,000-record benchmark | Required deterministic tests |
| Inspection-only SDK and local stdio RPC v1 | Required type/schema, parity, malformed-request, and clean-install tests | Same plus 25-project benchmark | Required type/schema, parity, malformed-request, and clean-install tests |
| Public brokered-HTTP Source Adapter example | Ordinary conformance plus strong-isolation qualification | Ordinary conformance plus Scenario E approval/crash and strong-isolation qualification | Ordinary JSONL conformance; direct process authority is not sandboxed |
| Hash-pinned licensed public-corpus workflow | Required NIST PDF import→parse→evidence→analysis→manuscript→review→restore | Covered by deterministic components; network workflow runs on Ubuntu | Covered by deterministic components; network workflow runs on Ubuntu |
| Reproducible Agent/contracts tarballs | Two-pack byte and entry-manifest comparison | Same | Same |

Node.js 22.19.0 or newer is required. Python, R, and Stata are discovered capabilities, never installed by this package. The default CI uses synthetic or redistribution-approved fixtures and no provider credentials. Live provider availability, prices, entitlements, and user runtime packages remain outside the static support promise.

Unknown third-party code never runs in-process through the v1 Adapter runner. Strong registration has no automatic fallback: macOS and Linux use qualified native profiles; Windows blocks. SDK/RPC trusts the host user, opens no socket, accepts only configured projects, redacts host paths by default, and exposes no canonical mutation method.
