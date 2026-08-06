# Synthetic qualitative example

This public fixture contains three fictional, de-identified interview excerpts about explanations in a public service. It demonstrates the audit boundary; it is not participant data and does not establish saturation, prevalence, representativeness, or intercoder reliability.

1. Import `interviews.txt` as public, de-identified material.
2. Segment it once into three paragraph locators.
3. Create and explicitly confirm the codebook in `codebook.json`.
4. Record one model suggestion per segment, then record separate human accept, edit, and reject decisions.
5. Revise one human decision through `supersedesCodingDecisionId`.
6. Create a theme with the third segment retained as a negative case, confirm it, and render the Markdown/JSON audit.

The model suggestions are deliberately imperfect. They never become human coding decisions automatically, and reruns retain every prior suggestion, decision, and supersession link.
