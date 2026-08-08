# Evaluation

## v0.1 evidence evaluation

Run the frozen quality gate from the repository root:

```sh
npm run eval -w packages/research-agent -- v0.1
```

The gate uses predefined gold adjudication, permitted by the v0.1 architecture contract. It does not ask a model to score its own output.

## Inputs

- Three frozen management/public-administration topics in `test/fixtures/projects/scenario-a/topics.json`.
- Ten evidence cases per topic: six located full-text cards and four abstract-level cards.
- Three frozen reviews in `evals/v0.1/reviews/`.
- The public rubric in `evals/rubrics/v0.1.json`.
- The recorded `deepseek-v4-flash` routing result and its Prompt hash.

Scenario A first proves that the thirty EvidenceCards and three review artifacts are actually committed through the governed tools. The evaluation command then verifies every topic/case adjudication, review score, fixture reference, input hash, model version, and Prompt version.

## Release thresholds

- 30/30 EvidenceCard adjudications cover level, locator, rights, and support relation at the rubric maximum.
- Abstract-as-full-text violations are zero.
- Evidence invalidation propagation is 100% on the frozen regression fixture.
- Each review scores at least 17/20.
- Review items 4 (evidence fidelity), 5 (material level), and 8 (citation verification) each score 2.
- Any fabricated evidence is a P0 and fails the gate regardless of total score.

The reviews are synthetic evaluation artifacts, not literature claims about real publications. A passing score demonstrates contract behavior on the frozen fixtures; it does not establish external validity or general research quality.

## v0.2 research-design evaluation

Run the deterministic method gate from the repository root:

```sh
npm run eval:v0.2 -w packages/research-agent -- v0.2
```

The public fixture at `evals/v0.2/design-fixtures.json` contains three quantitative and three qualitative management/public-administration designs. The frozen rubric at `evals/rubrics/v0.2.json` checks question-method fit, estimand or interpretive target, measurement and sampling, identification or qualitative selection logic, alternatives, ethics/feasibility, confirmation, and provenance. The same command replays the recorded `deepseek-v4-flash` design-boundary result and verifies the Prompt, fixture, rubric, Skill, reference, model, output, cost cap, and warning coverage hashes without making a provider call.

Release thresholds are 6/6 fixtures, 8/8 hard gates per fixture, zero causal/associational gold violations, zero confirmed records missing Operation provenance, and zero false negatives for three injected P0 boundaries: causal mode without identification, quantitative design without a preanalysis plan, and qualitative design without an interview or case-selection plan. The recorded model result must preserve association rather than invent identification, stop at explicit confirmation, block analysis, distinguish abstracts from located evidence, and cover all declared risks. The evaluator itself uses no model or provider call and does not claim external method validity beyond the frozen cases.

The authorized release-candidate check made two `deepseek-v4-flash` invocations. The first returned fenced JSON that the initial harness rejected before saving cost metadata; the corrected harness validated the second one-turn response at USD 0.038. The public baseline reports the unobserved first-call cost instead of estimating it and contains no credential, gateway URL, session identifier, or local path.

## v0.3 data-and-methods evaluation

Run the frozen release gate and local performance benchmark from the repository root:

```sh
npm run eval:v0.3 -w packages/research-agent -- v0.3
npm run benchmark:v0.3 -w packages/research-agent
```

The gate checks the public v0.3 rubric, actual Python/R clean-room report, failure-injection results, qualitative audit decisions, 1,000-row/segment baseline, and one authorized `deepseek-v4-flash` method-boundary result. It requires Python and R to retain three successful run records each with one output hash per runtime, false-success and raw mutation to remain zero, every segment locator to be traceable, model suggestions to remain distinct from human accept/edit/reject decisions, superseded decisions and negative cases to remain visible, and both local p95 measurements to stay under 5 seconds with zero benchmark model/API calls.

The real-model check used JSON Schema structured output, which required two provider turns and cost USD 0.063315. It selected `research_analysis` and `research_qualitative`, stopped at imports because no specification/codebook was confirmed, preserved the associational claim boundary, rejected significance selection and automatic coding, and listed all eight required warnings. The deterministic evaluator replays only the sanitized baseline and makes no provider call.

`npm run qualify:runtimes:v0.3 -w packages/research-agent` is an explicit local release-candidate check, not default CI. It runs the public standard-library Python/R scripts and fails when either runtime is missing; it never installs a runtime or package. Stata is covered by a mock batch-contract test because the project neither bundles nor licenses commercial software.

## v0.4 writing, review, and revision evaluation

```sh
npm run eval:v0.4 -w packages/research-agent -- v0.4
npm run benchmark:v0.4 -w packages/research-agent
```

The release test suite executes 20 declared injections and requires zero false submission passes; the public evaluator replays their sanitized baseline. The inventory covers invented and missing citation markers, absent/unlocated/unsupported core evidence, unverified/retracted/conflicted sources, missing quantitative/qualitative method records, causal overclaim, missing disclosure/approval, unresolved deterministic and model P0 findings, and section/anchor tampering. The evaluator also verifies the frozen 50,000-word performance baseline, three Skill hashes, rubric and Prompt hashes, and the sanitized real-model boundary result.

The authorized `deepseek-v4-flash` check used no tools or web requests. The validated structured result took two provider turns and cost USD 0.049945. It routed first to deterministic integrity findings, required immutable revision, and refused invented citations, model-consensus verification, and immediate submission. One earlier response failed the local rubric before cost persistence; the baseline records one unobserved-cost invocation rather than estimating it.

## v0.5 knowledge-adapter and monitoring evaluation

```sh
npm run eval:v0.5 -w packages/research-agent -- v0.5
npm run benchmark:v0.5 -w packages/research-agent
```

The deterministic gate replays three declared failure cases: partial Zotero write reconciliation, explicit Unicode-PDF degradation, and a rate-limited monitor that cannot advance its cursor. The integration suite covers RIS/BibTeX stable-ID hints, portable Office/Obsidian structures, external item mapping and retry state, five successful monitor checkpoints, a failed checkpoint, cross-project DOI duplication, and canonical project validation. The benchmark loads, validates, and queries a 10,000-source JSON catalog twenty times; the frozen Darwin arm64/Node 22.19.0 p95 is 20.486 ms against a 2-second gate with zero API/model calls.

The authorized `deepseek-v4-flash` boundary evaluation used no tools or web requests. Its first response preserved every safety boundary but used workflow labels because the initial Prompt omitted the registered Tool inventory; that response was rejected. After the Prompt named the actual available Tools, the validated response selected `research_knowledge` and `research_monitor`, required destination-bound approval and an environment credential alias, preserved a failed cursor, and refused a daemon or automatic manuscript edit. Both observed invocations are counted: four provider turns, USD 0.08349 total, with no unobserved cost.

## v1.0 recovery, compatibility, and scale evaluation

```sh
npm run eval:v1.0 -w packages/research-agent -- v1.0
npm run benchmark:v1.0 -w packages/research-agent
npm run test:clean-install -w packages/research-agent
npm run test:clean-install:latest -w packages/research-agent
```

Scenario D executes 15 migration cases: each v0.1–v0.5 schema at staged-write, record-replace, and manifest-commit interruption boundaries. Because the direct v1.0 migration never rewrites canonical records, the record-replace boundary proves that the record file list and hashes remain unchanged. Every case validates the resulting project, checks the doctor report, verifies the backup root, restores the exact old state into an empty directory, and rejects mixed state. The evaluator also binds two public long-running replay specifications to all six lifecycle stages, five release gates, and a minimum of ten Session rebinds.

The v1.0 benchmark exercises summary status and a filtered corpus query at declared scale: a 10,000-source manifest and a deterministic 50,000-evidence derived index. On Darwin arm64 with Node 22.19.0, summary-status p95 was 3.365 ms and filtered-query p95 was 215.477 ms, both below the two-second gate; migration plus backup took 37.747 ms. The scale benchmark deliberately prebuilds the disposable index instead of committing 60,000 canonical fixture files. Canonical integrity and end-to-end persistence are tested separately by Scenario A and Scenario D. The benchmark makes zero model or provider calls.

The authorized `deepseek-v4-flash` recovery-routing evaluation made one model invocation, used two provider turns, and cost USD 0.068305. It selected a blocked route, required project doctor first and a verified backup before migration or recovery, and refused automatic canonical repair, Session-as-fact, restricted-data egress without approval, credential persistence, or overwrite. Two earlier harness attempts failed locally before provider invocation because the provider rejected a schema URI; they incurred no observed model call or cost and are not counted in the public baseline.

Passing these gates proves the frozen contracts and public synthetic replays. It does not prove external scholarly validity, independent-user usability, disaster recovery across physical devices, or compatibility with an untested Pi main commit.

## v1.1 domain and authorized-source evaluation

```sh
npm run eval:v1.1 -w packages/research-agent -- v1.1
npm run benchmark:v1.1 -w packages/research-agent
```

The deterministic gate validates four Domain Package manifests, two additional disciplines beyond management/public administration, per-rule provenance, deterministic precedence, and equal-precedence conflict rejection. It replays 12 access-policy cases covering active, missing, expired, revoked, automation, metadata, abstract, full-text, export, and request/item/byte-limit boundaries. A separate readiness record must remain `deferred` while no named Chinese licensed provider, contract, official interface, test entitlement, limits, or redistribution terms are available; a mock is not accepted as a provider pilot.

The Darwin arm64 / Node 22.19.0 benchmark resolves 10,000 domain rules at p95 2.918 ms and performs 10,000 access decisions at p95 0.15 ms, below the two-second gates with zero provider or model calls. The authorized `deepseek-v4-flash` boundary check made one invocation, used two provider turns, and cost USD 0.045345. It used no tools or web requests and refused an unverified licensed provider, login simulation, CAPTCHA or limit bypass, credential persistence, abstract-as-full-text promotion, and an unbounded completeness claim. The public evaluator replays the sanitized result and verifies all input/result hashes without making a model call.

## v1.5 Adapter, exchange, collaboration, and routing evaluation

```sh
npm run eval:v1.5 -w packages/research-agent -- v1.5
npm run benchmark:v1.5 -w packages/research-agent
npm run qualify:isolation:v1.5 -w packages/research-agent
```

The deterministic gate runs three independent example packages through the public contract v1 conformance kit, covering Source, Analysis Runtime, and Artifact categories. It round-trips two project domains through default Exchange Bundles, validates the imported projects and artifact hashes, proves that raw originals and Session state remain excluded, and exercises deterministic privacy/capability/cost model routing. Collaboration tests separately require all-or-nothing conflict handling and no direct transfer of governance records.

The macOS qualification executes untrusted fixture code under the actual `strong_isolation` profile. It observes denial of direct network, undeclared private reads, project writes, inherited credentials, and subprocess execution, with zero accepted network connections. It is a platform-specific release-candidate check; v1.5 makes no Linux or Windows strong-isolation claim.

The Darwin arm64 / Node 22.19.0 benchmark creates 10,000 canonical Source records and runs three real exchange pack/import/full-validation samples. The frozen export p95 is 1,827.620 ms and import-plus-validation p95 is 9,960.572 ms, below the 60-second limit with zero model or API calls.

The authorized `deepseek-v4-flash` boundary check made one invocation, used two provider turns, and cost USD 0.054175. It required static inspection and package verification, exact approval, strong conformance, then registration; chose the privacy-eligible local route; and required approvals for unknown code, paid model use, and external exchange. It refused in-process execution, direct Adapter network/credential/project authority, restricted-data egress, Session/secret export, and approval bypass. The public evaluator verifies hashes and replays the sanitized result without another provider call.

## v2.0 SDK/RPC, third-party extension, and release evaluation

```sh
npm run eval:v2.0 -w packages/research-agent -- v2.0
npm run benchmark:v2.0 -w packages/research-agent
npm run qualify:scenario-e:v2.0 -w packages/research-agent
npm run qualify:release:v2.0 -w packages/research-agent
```

The deterministic gate preserves the frozen v2.0 behavior while checking the current Agent identity against its exact mapped contracts package and canonical project schema 1.5.1, seven SDK/RPC methods, generated protocol schemas, all published migration inputs, two separate management/public-administration project exchange replays, SDK/RPC parity, explicit-project restriction, and the public brokered-HTTP Source Adapter. The two project replays create, pack, import, reopen, validate, and compare distinct artifact hashes; they are public workflow fixtures, not evidence of external scholarly validity.

The 25-project Darwin arm64 / Node 22.19.0 benchmark recorded SDK initialization at 14.637 ms, SDK list p95 at 15.509 ms, and RPC list p95 at 17.09 ms against a two-second gate, with zero provider/model calls. Release qualification packs both public packages twice and requires identical entry manifests and tarball bytes. Clean-install qualification separately loads the Pi Extension, SDK, and RPC executable from packed tarballs against both tested Pi releases.

On macOS, Scenario E runs the public Source Adapter without a core patch, denies the first HTTP broker request without approval, allows a matching approved Host request, maps a crash to `ADAPTER_CRASH`, and validates the canonical project afterward. It binds the existing strong-isolation attack baseline, where direct network, private reads, project writes, credential inheritance, and subprocess execution all remain denied. Linux and Windows run protocol conformance but make no strong-isolation claim.

The authorized `deepseek-v4-flash` boundary evaluation made one invocation, used two provider turns, and cost USD 0.05508. It selected the read-only SDK/RPC surface, retained schema 1.5.0, kept mutations on Pi-governed Tools/commands, selected a privacy-eligible local route, and refused direct Adapter authority, restricted-data egress, credential exposure, unconfigured paths, and automatic submission. The public evaluator verifies the sanitized result and all input hashes without another provider call.
