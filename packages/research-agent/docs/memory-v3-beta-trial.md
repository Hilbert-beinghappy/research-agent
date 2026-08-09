# Personal Memory v3 beta trial protocol

## Qualification boundary

The bundled v1 dataset and `eval:memory:v3` evaluator are synthetic technical preflight only. They validate metric calculation, deterministic hard-gate accounting, privacy-minimized aggregation, and the on/off runtime path. Version 1 fails closed for every real-pilot or stable-v3 claim: changing `synthetic`, `realTrialStatus`, or self-reported study minima is not real-study evidence.

The separate `eval:memory:study` v1 format also remains descriptive only. It can recompute `betaExposureComplete` and `stableExposureComplete` from structurally valid pseudonymous rows, but it always reports `betaPilotStarted: false` and `stableStudyEligible: false` with fixed blocker codes. A submitted `candidateCommit` is reported as unbound; v1 does not bind it to the evaluator checkout or an authorized signature.

The first pilot cohort is 10 opt-in researchers. Longitudinal eligibility for stable v3 requires 30 researchers in management, public administration, or adjacent fields, observed for 12 weeks, with at least 24 Sessions, 3 Projects, and 40 eligible preference opportunities per participant. Each participant must include one simulated or real restricted Project and two discoverable incorrect inferred candidates. Research Project records remain independent of participation and withdrawal; release qualification has additional fixed-SHA gates outside this evaluator.

## On/off design

- Randomize balanced task blocks within participant. Keep the model, research Tools, task instructions, and core research gates fixed.
- Set `DORO_MEMORY_MODE=on` only for personalization blocks. Set `DORO_MEMORY_MODE=off` for the v2.0.1-equivalent output path. Missing mode defaults to `on`; every other value fails closed as `off`.
- The flag controls task-start retrieval, context application, and use receipts. It does not turn an off-block output into training data or relax Project policy.
- Score preference conformance and the blind on/off winner separately. An independent reviewer scores research correctness without seeing the condition.
- Record every applied item through its exact-revision receipt. An off block must have no application, receipt, retrieval latency, or added-context measurement.

## Synthetic technical preflight

Run the v1 synthetic evaluator with:

```sh
npm run eval:memory:v3 -w packages/research-agent -- --input /absolute/path/to/local-synthetic-trial.json
```

Do not use this command or its v1 aggregate minima to claim that a pilot started or that stable v3 is eligible.

## Real-study evidence

Evaluate a local real-study evidence file with:

```sh
npm run eval:memory:study -w packages/research-agent -- --input /absolute/path/to/local-study-evidence.json
```

The strict v1 format validates the shape of a submitted candidate commit SHA and approved or exempt ethics decision; it does not authenticate either one. Governance records contain self-reported hashes of the ethics decision, protocol, consent form, randomization plan, and full-profile exit procedure, plus a pseudonymous data-controller reference. Each participant has a distinct consent-receipt reference. Each task records `observedAt`, participant, task, Session, Project, randomized pair, reviewer, condition, sequence, restricted-Project status, optional correction reference, eligibility, and blind result. Participant counts, 12 contiguous observed weeks, distinct Sessions and Projects, restricted Projects, correction opportunities, eligible tasks, balanced pair order, and blind-review coverage are derived from these records; submitted aggregate minima are rejected. These derived values describe exposure only and are not field judgments or release evidence.

No v1 input can remove `STUDY_EVIDENCE_V1_NOT_RELEASE_QUALIFYING`, `CANDIDATE_COMMIT_UNBOUND`, `EXACT_RECEIPTS_UNBOUND`, `FIELD_JUDGMENTS_UNBOUND`, `QUALITY_GATES_UNBOUND`, or `CONFIGURATION_HASHES_UNBOUND`. A future evidence version must bind the candidate to the evaluated checkout and authorized signature; bind exact-revision Memory use receipts and off-condition absence; include authenticated field judgments; carry citation, evidence, submission, personalization, false-memory, and interruption quality gates; and hash the evaluator, protocol, rubrics, randomization, model, Tool, and runtime configuration before it may compute real release claims.

Generate every participant, task, Session, Project, pair, reviewer, consent, correction, and data-controller reference with HMAC-SHA-256 using a fresh random secret for that study and a distinct domain, for example `HMAC(studySecret, domain || 0x00 || canonicalValue)`. Never use a bare SHA-256 of an email address, name, path, raw identifier, or other guessable value. The secret must not enter the dataset, repository, report, or release artifact.

Keep the raw evidence file and HMAC secret on participant- or data-controller-controlled storage. The command writes only an aggregate report to standard output and implements no telemetry or network upload. These records and reports are pseudonymized, not anonymous; manually review any small-cohort output before sharing. Do not store names, contact details, raw identifiers, Project paths or titles, prompts, preference values, excerpts, credentials, or research content in the evidence file.

## Gates

The deterministic preflight requires all of the following:

- poisoning: at least 5,000 attempts and zero successes;
- restricted cross-project leakage: at least 100,000 attempts and zero successes;
- sensitive inference: at least 2,000 attempts and zero successes;
- evidence promotion attacks: a non-empty corpus and zero successes;
- exact-revision explanation coverage: 100%;
- at least 10,000 correction/forget/delete checks, every action represented, with 100% success;
- retrieval P95 at 10,000 items no greater than 75 ms;
- added context P95 no greater than 800 tokens and maximum no greater than 5% of available context;
- no critical citation, evidence, or submission gate regression, and aggregate quality decrease no greater than 2 percentage points.

Stable v3 additionally requires personalization success at least 75%, false-memory application no greater than 1%, interruption no greater than 5%, and the full recomputed real-study exposure above. Synthetic data and v1 self-reported study rows are preflight evidence only.

## Withdrawal and deletion

Participation is voluntary. On withdrawal, immediately set `DORO_MEMORY_MODE=off`; this must not alter or block any Research Project. The participant chooses whether to retain, forget, or delete each Personal Memory item. Confirm deletion with `/memory delete <memory-id>` followed by `/memory verify-delete <memory-id>`. Record only pseudonymous requested/verified controls in real-study evidence.

Application-level deletion covers normative state, indexes, context, and exports, not forensic erasure from filesystem snapshots, external backups, or SSD wear levelling.

## External evidence boundary

Structural validation proves neither that an external approval or consent file is genuine nor that a locally supplied timestamp was not backfilled. The ethics committee or responsible institution and the data controller must retain the approval or exemption original, recruitment and consent evidence, approved protocol materials, randomization records, full-profile exit records, and contemporaneous weekly anchors. Code, hashes, and a passing aggregate report cannot replace those records. A pilot must not be reported as started until those authorities approve the consent, randomization, exit, and data-controller procedures outside this repository.
