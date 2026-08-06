# v0.1 example requests

These three examples are portable bootstrap specifications for the frozen Scenario A topics. They are intentionally small: run each in a new empty directory, initialize the title, ask the intake Skill to confirm the question and `searchToolInput`, then let the governed Tools create the canonical project. The example JSON is not a replacement for `research-project.json` and must never be copied into `.research/records` by hand.

```text
/research-init "<title from request.json>"
/skill:research-project-intake
Use the attached request.json as a proposal. Ask me to confirm its scope and search plan before executing it. Preserve abstract/full-text and verified/unverified boundaries.
```

The public E2E replay uses synthetic recorded provider/PDF fixtures. A live run may return different literature, costs, or availability and must retain those observed states.

`research-design` contains the v0.2 quantitative and qualitative design plans. `quantitative-synthetic` and `qualitative-synthetic` contain the public v0.3 method-workbench inputs. Generated project IDs, runtime paths, and local logs are intentionally not committed.
