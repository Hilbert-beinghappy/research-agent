# Governance

Pi Research Agent uses maintainer review and Developer Certificate of Origin sign-off; it does not require a contributor license agreement.

## Decisions

Focused fixes and compatible additions use normal pull-request review. A public contract break, project-schema major, default security-policy change, new network or credential boundary, database, custom UI, hosted service, or third-party execution model requires an RFC based on `docs/rfcs/0000-template.md`.

An RFC records the problem, measured trigger, alternatives, migration and rollback, privacy and license impact, compatibility evidence, and rejection conditions. Acceptance authorizes implementation review; it does not waive tests, user confirmation, or release gates.

## Assets and evaluations

Every fixture, Skill, Prompt, rubric, and Adapter must have redistribution rights and provenance. Proprietary local Skills and restricted research data are excluded from releases. Evaluation-gold changes are reviewed separately from implementation and must explain why they correct an error or expand coverage rather than reduce a threshold.

## Releases and security

Maintainers publish tested support ranges, migrations, SBOM, known limitations, and observed release evidence. Security reports use the private process in `SECURITY.md`. A verified evidence-level promotion, secret leak, unauthorized egress, canonical data loss, or sandbox escape claim is a release blocker until contained and reviewed.

## Academic scope

Core maintainers guarantee software contracts and declared evaluation behavior, not the academic correctness of every domain template, method, model output, or conclusion. Domain packages must state their review status and evidence basis.
