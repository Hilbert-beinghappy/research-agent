# v1.5 support matrix

| Capability | Ubuntu | macOS | Windows |
|---|---|---|---|
| Pi package load, project state, discovery, evidence, writing | Required CI | Required CI | Required CI |
| Project migration, doctor, backup/restore, path and lock behavior | Required CI | Required CI | Required CI |
| Built-in Domain Packages and authorized-source policy evaluation | Required CI | Required CI | Required CI |
| Pi 0.83.0 baseline and 0.84.0 latest-stable clean install | Required CI | Required CI | Required CI |
| Python analysis Adapter | Capability test when Python is present | Capability test when Python is present | Capability test when Python is present |
| R analysis Adapter | Capability test when R is present | Capability test when R is present | Capability skip is explicit when R is absent |
| Stata Adapter | Mock contract; user-owned licensed runtime only | Same | Same |
| DOCX/PDF/XLSX/PPTX and Obsidian outputs | Deterministic structure tests | Deterministic structure tests and optional local preview | Deterministic structure tests |
| Licensed Chinese provider Adapter | Deferred until a named provider, contract, official interface, test entitlement, limits, and redistribution terms are supplied | Same | Same |
| Adapter contract v1 and ordinary JSONL conformance | Required CI; process boundary is not a sandbox | Required CI; process boundary is not a sandbox | Required CI; process boundary is not a sandbox |
| Strong-isolation Adapter qualification and governed registration | Not claimed; registration blocks | Required qualification: direct network, private read, project write, credential inheritance, and subprocess denied | Not claimed; registration blocks |
| Exchange Bundle and record-only collaboration | Required deterministic tests | Required deterministic tests plus 10,000-record benchmark | Required deterministic tests |

Node.js 22.19.0 or newer is required. Python, R, and Stata are discovered capabilities, never installed by this package. The default CI uses synthetic or redistribution-approved fixtures and no provider credentials. Live provider availability, prices, entitlements, and user runtime packages remain outside the static support promise.

Unknown third-party code never runs in-process through the v1 Adapter runner. Strong registration has no automatic fallback: Linux and Windows remain blocked until a platform profile passes the same attack qualification.
