# Synthetic quantitative example

This public fixture studies an associational question: whether a visible service explanation is associated with reported trust in a fictional public-service sample. It is not evidence about a real population and does not identify a causal effect.

Import `data.csv`, create one confirmed `AnalysisSpecification` for `analysis.py` and one for `analysis.R`, then run each through `research_analysis`. Both scripts use only their runtime standard library, read the copied input exposed as `PI_RESEARCH_INPUT_0`, and write `result.json` plus `analysis-status.json` under `PI_RESEARCH_OUTPUT_DIR`.

- Python environment: `requirements.txt` (no third-party packages).
- R environment: `renv.lock` (base R only).
- Seed: `17`.
- Expected output: `result.json`.
- Claim mode: `associational`.

The release qualification runs each confirmed specification three times and requires identical output hashes within the same runtime. Cross-runtime byte equality is not claimed.
