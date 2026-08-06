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
