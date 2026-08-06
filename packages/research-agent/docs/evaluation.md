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
