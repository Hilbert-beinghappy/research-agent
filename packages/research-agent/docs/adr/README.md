# Personal Memory architecture decisions

These decisions define the v3 Personal Memory boundary accepted for implementation toward `3.0.0-beta.1`. They do not claim that Personal Memory is released or that a real beta pilot or stable-v3 study has completed.

| ADR | Decision |
|---|---|
| [0001](0001-personal-memory-state-boundaries.md) | Separate Session, Research Project, Personal Memory, Team Memory, and derived cache state. |
| [0002](0002-model-no-write-authority.md) | Models and Skills can draft candidates but cannot write or promote memory. |
| [0003](0003-restricted-learning-policy.md) | Restrict eligible signals, sensitive categories, and cross-project promotion. |
| [0004](0004-memory-forget-delete-semantics.md) | Define correction, forgetting, deletion, verification, and restoration semantics. |
| [0005](0005-memory-transfer-cryptography.md) | Define the only v3 cross-machine transfer envelope and atomic import rules. |

`personal-memory-threat-controls.json` is the machine-readable threat-to-control map. `npm run validate:memory-threat-model -w packages/research-agent` fails when a required high-risk threat lacks an owner, control, machine-test identifier, implementation state, or `NO_GO` failure verdict.

All currently mapped tests are implemented, and the validator requires every named file to exist. Mapping and file presence do not prove that the tests passed on a release candidate or that the v3 beta or stable-v3 gates pass. The [beta trial protocol](../memory-v3-beta-trial.md) defines the synthetic/real evidence boundary and longitudinal thresholds.

## Shared constraints

- Personal Memory remains optional. Its absence, pause, corruption, or recovery state cannot block Research Project work.
- No v3 decision introduces a database, vector store, daemon, cloud sync, Team Memory, Provider ecosystem, or standalone Doro process.
- Project schema 1.5.1 remains independent from Personal Memory schema 1.0.0.
- Preferences can affect ordering, formatting, routing, and non-destructive defaults. They cannot promote evidence, confirm a method, alter canonical research facts, or authorize an external effect.
- Stable v3 is outside this milestone. It still requires the specified longitudinal user study after beta qualification.
