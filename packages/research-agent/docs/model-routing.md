# Deterministic model routing v1

The v1 router chooses among observed model candidates without calling a model. Input contains required capabilities, data classes, estimated input tokens, an optional request cost limit, and candidates with locality, availability, context, capability, and estimated-cost facts.

## Eligibility

A candidate is ineligible when any of these facts applies:

- unavailable;
- context window smaller than the estimated input;
- missing a required capability;
- remote while project model egress is disabled;
- remote provider not on the project allowlist;
- remote data class not allowed for egress;
- estimated cost exceeds the project or request limit, or uses another currency.

Every ineligible candidate retains machine-readable reasons. If no candidate is eligible, the route is `blocked`; privacy, capability, or cost constraints are not weakened to force a result.

Eligible candidates are ordered by local-first, then lower declared cost, then stable provider/model name. A lower-cost remote model does not compete if its egress or data-class boundary fails. If both a local and remote candidate are eligible, local-first is the deterministic policy.

## Audit record

`createResearchModelRouteDecision` creates a data-contract decision with the project ID, hash of the exact request, selected candidate or `null`, every candidate evaluation, and decision time. `/research-model-route` appends the corresponding canonical `ModelRouteDecision` and a successful Operation to the active project. Candidate capability, locality, availability, context, and price are host-supplied observations; the router does not verify provider marketing, current pricing, physical locality, or runtime availability.

The route decision is separate from model execution. Paid calls, sensitive egress, and provider requests still pass through project policy, budget, and approval before execution. A route therefore explains eligibility and preference; it is not a payment receipt or proof that a model ran.

## Example

For restricted interview data with model egress disabled, a local structured-output model can be selected while a cheaper remote structured-output model is marked ineligible with `model_egress_denied`. If egress and that exact data class are later permitted and both candidates meet the request budget, local-first still wins unless the local candidate is independently ineligible.
