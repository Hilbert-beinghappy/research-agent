# v2.0 full-workflow acceptance example

This example links the existing public inputs into one installable-package acceptance flow. It uses synthetic or recorded management/public-administration material and proves workflow and provenance behavior, not an external empirical claim.

## 1. Create and inspect the project

Start Pi in an empty directory with the installed `pi-research-agent` package, then run:

```text
/research-version
/research-init --domain public-administration "Algorithmic transparency and public trust"
/skill:research-project-intake
Use examples/algorithm-transparency-public-trust/request.json as a proposal. Ask me to confirm scope and the search plan before using governed Tools.
```

Use `/research-status full`, `/research-validate`, and `/research-resume` after each stage. Do not copy example JSON into `.research/records`.

## 2. Evidence and research design

Run the `literature-evidence` and `literature-review` Skills against the confirmed request. A live provider run may differ from the recorded Scenario A corpus; missing full text, abstract-only material, conflicts, and unverified citations must remain explicit. Continue with `research-design` only after the review and evidence gaps are confirmed.

The deterministic CI replay uses the public Scenario A fixture and requires source records, deduplication, document state, located evidence, citation status, an evidence matrix, and a review artifact before design records are added.

## 3. Quantitative, qualitative, writing, and delivery paths

Reuse these public inputs rather than inventing new fixtures:

- `examples/quantitative-synthetic` for confirmed Python/R analysis with immutable CSV input;
- `examples/qualitative-synthetic` for locators, codebook versions, separate model suggestions and human decisions, negative cases, and an audit artifact;
- `examples/manuscripts` for claim-to-evidence writing, review, revision, disclosure, and submission-gate checks;
- `examples/knowledge-vault` for rebuildable Obsidian/Office-style delivery output.

External writes, paid calls, unknown code, overwrites, deletion, and submission remain approval-bound. The acceptance flow stops before automatic submission.

## 4. Third-party Adapter and SDK/RPC

Run the public Source Adapter conformance without changing core:

```sh
npm run conform:adapter -w packages/research-agent -- examples/adapters/community-http-source
```

On macOS, Scenario E additionally proves that direct Adapter authority is denied and a legal HTTP intent succeeds only through the Host approval/broker path. Adapter denial or crash must leave project validation usable.

Finally start `research-agent-rpc --project <project-path>` and issue `projects.list`, `project.validate`, and `records.list` requests from `docs/sdk-rpc.md`. SDK and RPC must return the same canonical state. All mutations remain in the Pi terminal.
