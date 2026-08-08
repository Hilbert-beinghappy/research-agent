# ADR 0002: Models have no Personal Memory write authority

- Status: accepted for implementation
- Created: 2026-08-08
- Target release: 3.0.0-beta.1

## Problem

Model output is untrusted and can contain prompt injection, unsupported inference, sensitive attributes, or text copied from documents. Allowing it to write, promote, correct, or delete Personal Memory would bypass provenance, scope, user intent, and deterministic policy.

## Decision

Only the Host's Memory Policy Controller mutates canonical Personal Memory. A model or Skill may return a `MemoryCandidateDraftV1` through a registered, data-only boundary; it receives no profile filesystem path, writer lease, transaction handle, encryption key, or generic write tool.

Every candidate passes one deterministic choke point before any state transition:

1. validate the exact public schema and reject unknown fields;
2. bind provenance to a Host-observed event and require `actor=user` for user preference claims;
3. apply category, scope, effect, and data-class allowlists;
4. reject protected-attribute, credential, restricted-text, and external-content inference;
5. calculate support, independence, contradiction, and promotion rules without model discretion;
6. choose reject, quarantine, or transactional activation;
7. append an audit event that contains rule identifiers and hashes, not rejected semantic text.

The model cannot:

- treat its own response, a Tool result, PDF, webpage, email, dataset, citation, or third-party Skill text as a user-authored signal;
- infer acceptance from silence;
- lower a sensitivity class or widen project scope;
- activate, supersede, forget, delete, restore, or export an item;
- write a Project fact, evidence level, method confirmation, approval, or external-effect authorization from memory.

Retrieval follows the same authority boundary. The controller selects active latest revisions with deterministic filters and ranking. The context builder emits a bounded section labelled `User preferences; not domain facts or research evidence.` The model can use that section only in the item revision's `allowedEffects`.

## Degradation

If model-based consolidation is unavailable, deterministic capture continues and inferred candidates are not created. If the controller is unavailable, no signal is persisted and the research workflow continues without personalization.

## Verification

Beta security tests must attempt direct filesystem writes, unregistered tool writes, model-authored promotion, sensitivity downgrade, prompt-injected candidate fields, and preference-to-evidence promotion. Any successful bypass is `NO_GO`.
