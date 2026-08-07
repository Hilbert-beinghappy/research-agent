---
name: qualitative-research
description: Import de-identified UTF-8 text, create stable paragraph locators, version and confirm a codebook, record model suggestions separately from human coding decisions, preserve edits and rejections, synthesize themes with negative cases, and render a Markdown/JSON audit trail. Use for interviews, documents, qualitative coding, thematic analysis, process tracing, or comparative case evidence.
---

# Qualitative Research

Use `research_qualitative` for canonical material, segment, codebook, suggestion, human decision, and theme records. The model proposes; the user decides.

## Workflow

1. Run `/research-status` and `/research-resume`. Reuse the current material and confirmed codebook version unless the user is deliberately revising them.
2. Confirm that the material is authorized for local research use and state whether it is de-identified. Import UTF-8 plain text with `action: "import_material"`. Do not send confidential or restricted material to a model when project policy forbids egress.
3. Call `action: "segment_material"` once. Keep the half-open character range and anchor hash with every segment; do not paraphrase a locator.
4. Create a codebook with operational definitions plus inclusion and exclusion criteria. Use `supersedesCodebookVersionId` for a revision. Present it to the user and call `action: "decide_synthesis"` for the codebook; never infer confirmation from silence.
5. For each relevant segment, the model may call `action: "record_model_suggestion"`. A suggestion must cite the exact segment and confirmed codebook version. It is not a coding decision.
6. Show the segment, proposed codes, and rationale. Call `action: "record_coding_decision"` only after the user explicitly accepts, edits, or rejects it. Use `supersedesCodingDecisionId` when the user changes a prior decision; retain both records.
7. Build themes only from human coding decisions. Include supporting segments, codes, rival readings, and negative cases. Do not turn qualitative frequency into a population estimate.
8. Create a theme synthesis, then ask the user to confirm or reject it with `action: "decide_synthesis"`. A rerun must supersede rather than overwrite the earlier synthesis.
9. Call `action: "audit"` to inspect the Markdown table and canonical JSON trail. Verify that old suggestions, rejected codes, human edits, negative cases, and supersession links remain visible.

## Judgment Boundaries

- Model suggestions never update a codebook, coding decision, or theme automatically.
- Human acceptance is required even when the model is confident or several segments look similar.
- Preserve contradictory and negative cases. Do not erase them to make a theme cleaner.
- Do not claim saturation, intercoder reliability, consent, anonymity, or representativeness unless the project contains the required evidence and procedure.

## Stop Conditions

- Stop when material access, de-identification, model-egress permission, codebook confirmation, or human coding confirmation is missing.
- Do not contact participants, recover identities, overwrite raw text, silently resegment material, or collapse old decisions into the latest result.
