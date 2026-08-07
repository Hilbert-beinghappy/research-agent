---
name: quantitative-research
description: Import a local UTF-8 CSV, inspect its deterministic data dictionary, freeze and confirm a Python, R, or optional Stata analysis specification, then run it with immutable inputs and reproducibility records. Use for descriptive statistics, associational models, causal designs with explicit identification assumptions, robustness checks, runtime diagnosis, or resuming a failed or non-converged analysis.
---

# Quantitative Research

Use `research_analysis` for canonical data, specification, runtime, and run records. The model may explain methods; the declared local script performs computation.

## Workflow

1. Run `/research-status` and `/research-resume`. Continue a pending analysis specification or failed run before creating a replacement.
2. Import only UTF-8 CSV with `action: "import_dataset"`. Inspect the returned row count, column count, variable names, inferred types, and missing counts. Treat inference as a dictionary draft, not substantive measurement validity.
3. Link the dataset to a confirmed research protocol when one exists. Keep descriptive, associational, and causal claims distinct. A causal specification requires a previously justified identification strategy and assumptions; a model name or significant coefficient is not identification.
4. Write a plain script for the selected runtime and an environment file. Use Python or R for the normal path. Use Stata only when the user has a legal local installation; never distribute Stata or inspect its license.
5. Call `action: "create_specification"` with the exact script, datasets, parameters, seed, arguments, expected outputs, timeout, and claim mode. Do not install missing packages.
6. Present the exact specification and limitations. Call `action: "decide_specification"` only after explicit user confirmation.
7. Call `action: "detect_runtime"`. Report missing runtime or packages as failures; do not substitute another method silently.
8. Before `action: "run"`, show the exact executable, arguments, isolated input/output boundary, and approval. Python/R use strong isolation by default. If the platform has no qualified profile, fail closed unless the user explicitly approves host-user execution after being told it can access the account's files and network. Stata always requires explicit commercial-runtime approval and remains unqualified until a real licensed runner passes.
9. Inspect `AnalysisRun`, stdout, stderr, output hashes, and input-integrity checks. Treat timeout, crash, missing variable/package, input mutation, or exit code 75 / `analysis-status.json` non-convergence as failure. Never report coefficients from a failed or non-converged run.
10. Rerun only from a confirmed specification. Compare output hashes and retain every prior Task, Operation, and AnalysisRun.

## Runtime Contract

Scripts receive copied inputs through `PI_RESEARCH_INPUT_0...` and `PI_RESEARCH_INPUTS`, an output directory through `PI_RESEARCH_OUTPUT_DIR`, canonical parameters through `PI_RESEARCH_PARAMETERS`, and the declared seed through `PI_RESEARCH_SEED`. Strong runs receive an isolated home/tmp, minimal environment, denied network, read-only inputs, and only the output directory as writable project data. Write `analysis-status.json` with `{"status":"succeeded"}` or `{"status":"non_converged"}` when convergence applies.

## Stop Conditions

- Stop when the specification is unconfirmed or the execution approval is denied.
- Do not edit raw inputs, choose a model for significance, suppress failed specifications, reinterpret association as causation, or install dependencies automatically.
- Do not claim full reproducibility merely because a seed exists. Report the recorded environment file, runtime version, hashes, and remaining platform limits.
