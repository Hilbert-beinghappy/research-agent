# v1.0 support matrix

| Capability | Ubuntu | macOS | Windows |
|---|---|---|---|
| Pi package load, project state, discovery, evidence, writing | Required CI | Required CI | Required CI |
| Project migration, doctor, backup/restore, path and lock behavior | Required CI | Required CI | Required CI |
| Pi 0.83.0 baseline and 0.84.0 latest-stable clean install | Required CI | Required CI | Required CI |
| Python analysis Adapter | Capability test when Python is present | Capability test when Python is present | Capability test when Python is present |
| R analysis Adapter | Capability test when R is present | Capability test when R is present | Capability skip is explicit when R is absent |
| Stata Adapter | Mock contract; user-owned licensed runtime only | Same | Same |
| DOCX/PDF/XLSX/PPTX and Obsidian outputs | Deterministic structure tests | Deterministic structure tests and optional local preview | Deterministic structure tests |
| Unknown third-party Adapter isolation | Not provided in v1.0 | Not provided in v1.0 | Not provided in v1.0 |

Node.js 22.19.0 or newer is required. Python, R, and Stata are discovered capabilities, never installed by this package. The default CI uses synthetic or redistribution-approved fixtures and no provider credentials. Live provider availability, prices, entitlements, and user runtime packages remain outside the static support promise.

The architecture's strong-isolation profiles are deferred to the v1.5 Adapter protocol. Until then, unknown in-process code is unsupported on every operating system.
