---
name: research-design
description: Turn a canonical literature review, evidence ledger, or explicit evidence gap into versioned research questions, concepts, theory relations, design decisions, and quantitative or qualitative protocols. Use when the user asks to formulate or revise a research question, compare methods, state hypotheses or propositions, prepare a preanalysis/interview/case plan, or resume a pending design confirmation.
---

# Research Design

Build an auditable proposal. The model may compare and explain choices; `research_design` performs canonical writes and user confirmation.

For management or public-administration work, read [management-public-admin.md](references/management-public-admin.md) before proposing concepts or methods.

## Workflow

1. Run `/research-status` and `/research-resume`. Continue any `designAwaitingConfirmation` record before proposing a replacement.
2. Inspect the relevant Claim, EvidenceCard, citation status, and review gap. Keep metadata, abstract, unlocated full text, located evidence, and verified citation status distinct.
3. Create a `ResearchQuestionVersion`. State its type, scope, rationale, and boundary conditions. Cite exact Evidence/Claim revisions in `basis.provenance`; if the ledger is insufficient, set `evidenceGap: true` and say what is missing.
4. Create concepts before theory relations. Define each construct, role, measurement notes, aliases, and boundaries. A relation must identify both concepts, direction, hypotheses or propositions, alternatives, and boundary conditions.
5. Record every material method, sampling, measurement, identification, data-source, ethics, and feasibility choice as a `design_decision`. A critical decision needs at least two options, a selected option, rationale, alternatives considered, and limitations.
6. Create the protocol only after its question, concepts, relations, and decisions exist. Do not execute analysis.
7. Present the exact record and its limitations, then call `research_design` with `action: "confirm"`. Never infer confirmation from silence. A rejected version remains in history.
8. Generate a `research-design` artifact with `research_artifacts` after the required records are confirmed.

## Method Boundaries

For quantitative protocols, define population, unit, sampling, measurement, data collection, analysis, exclusions, and a preanalysis plan. Use `claimMode: "causal"` only with a named identification strategy and explicit assumptions; an estimator name alone is not identification.

For qualitative protocols, define the interpretive or comparative target, material or participant selection, interview or case-selection plan, coding/audit approach, negative or rival explanations, and source locators. Do not turn participant accounts into population frequencies or causal effects without a separate justified design.

For every protocol, retain inclusion and exclusion criteria, alternative explanations, feasibility limits, boundary conditions, and an ethics/data-protection checklist. The checklist does not constitute IRB or legal approval.

## Stop Conditions

- Stop at `awaiting_confirmation` when no interactive UI is available.
- Do not fabricate provenance, evidence adequacy, access permission, ethics approval, preregistration, or data availability.
- Do not contact participants, register a plan externally, import sensitive data, or run analysis in this skill.
- Do not replace a confirmed record in place. Create a later version with the appropriate `supersedes...Id` link.
