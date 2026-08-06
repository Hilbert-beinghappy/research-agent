# v0.1 evaluation

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
