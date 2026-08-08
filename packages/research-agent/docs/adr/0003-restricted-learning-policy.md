# ADR 0003: Restricted learning and prohibited inference policy

- Status: accepted for implementation
- Created: 2026-08-08
- Target release: 3.0.0-beta.1

## Problem

Research workflows contain third-party text, confidential project material, participant data, and temporary task instructions. Naive profile learning can misattribute external text to the user, infer protected attributes, or leak a restricted project's subject matter into unrelated work.

## Eligible signals

The Host may capture only structured observations of:

- an explicit preference statement authored by the user;
- an explicit correction, rejection, or restoration action against an exact revision;
- an explicit acceptance event;
- a sanitized user edit diff with quotations and external document text removed;
- a real Host-observed tool or workflow choice;
- a user-selected final artifact format.

Single behavioral observations remain candidates. Silence, repetition within one Session, model summaries, and inferred personality do not increase authority.

## Prohibited sources and categories

PDFs, webpages, emails, datasets, reference text, Tool or Adapter output, model output, and third-party Skill instructions cannot directly become user preference signals. They may be research inputs in a Project under existing evidence controls.

No category exists for psychological or health state, political or religious belief, sexual orientation, protected identity, unrelated life history, credentials, raw key material, or personality diagnosis. A candidate key must come from a fixed low-risk allowlist. A prohibited candidate is discarded without retaining semantic content; audit retains only rule ID, output hash, producer identity, and time.

## Restricted project rules

- Capture is off by default while a Project sensitivity is `restricted`.
- Restricted observations never promote to domain or global scope.
- Explicit project-scoped opt-in can record only a low-risk preference plus hash-only/logical provenance; it cannot record project text, title, path, topic, method, result, or summary.
- Sensitivity follows the highest source classification and cannot be lowered by a model or user-facing draft.
- Export and import exclude restricted source references by default.
- Retrieval performs a final canonical scope and sensitivity check after cache lookup.
- A task-local instruction overrides only the current task unless the user explicitly states that it is a lasting preference.

The manually confirmed profile remains authoritative over learned candidates. Automated PDF or reading-history extraction may update a separate learned profile only; it never overwrites confirmed base preferences.

## Allowed effects

Low-risk active items may adjust language, format, length, non-destructive defaults, tool ordering, or artifact presentation. Domain, theory, method, and evidence preferences may only rank options. They cannot confirm a research design, promote evidence, choose a causal claim, bypass a gate, spend money, disclose data, or perform an external write.

## Verification

Beta qualification requires adversarial fixtures for PDF/web/Tool/Skill injection, protected-attribute prompts, restricted cross-project combinations, sensitivity downgrade, task-local persistence, and manual-profile overwrite. Randomized cross-project tests must cover at least 100,000 scope/data-class combinations with zero leakage. One reproduced leak is `NO_GO`.
