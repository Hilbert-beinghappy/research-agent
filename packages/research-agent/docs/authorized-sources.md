# Authorized academic sources

v1.1 defines a fail-closed contract for provider access. It does not claim that possession of a credential permits automation, bulk download, export, or redistribution.

## Access paths and policy snapshots

Each new source-discovery event records an `AccessPolicySnapshot` beside its access path:

- `official_api`: a documented provider API;
- `supported_export`: an export path the provider documents for the user's entitlement;
- `user_authorized_file`: a local file the user is entitled to process.

The snapshot records provider and policy versions, capture time, terms reference, whether automation is allowed, request/item/byte limits, entitlement capabilities, and redistribution status. It records no password, API key, session cookie, or bearer token. Credential values stay in the environment or OS credential mechanism; project records may contain only aliases and observed authorization state.

Metadata, abstract, full text, export, and redistribution are independent capabilities. `evaluateAuthorizedSourceAccess` checks automation permission, credential state, the exact requested capability, and declared limits in that order. Missing, expired, or revoked authorization; forbidden automation; absent entitlement; or a limit overrun returns an explicit blocked decision. No fallback turns an abstract into full text or a provider failure into complete coverage.

## Optional licensed-provider package requirements

A provider-specific package can be considered only after all of these are available:

1. the named provider and product;
2. current contract and automation terms;
3. official API or supported export documentation;
4. a user-owned test entitlement;
5. request, item, byte, and time-window limits;
6. explicit metadata, abstract, full-text, export, storage, and redistribution rights;
7. sanitized fixtures that contain no restricted provider records.

The adapter must use the governed HTTP broker, credential aliases, destination-bound approvals, immutable request receipts, explicit pagination/cursor state, and per-action entitlement checks. Authentication expiry, revocation, rate limits, partial results, provider drift, and unavailable full text must remain visible.

## v1.1 provider status

No Chinese licensed-database adapter is shipped in v1.1. No named provider, contract terms, official automation interface, test entitlement, or redistribution grant was supplied, so implementing one would fabricate legal and technical assumptions. The public contract and conformance fixtures are present; provider-specific implementation is deferred until the required inputs exist.

The package never simulates browser login, bypasses CAPTCHA, evades rate or download limits, stores credential values in project files, redistributes restricted records, or claims complete Chinese-database coverage. A user-supported export may be imported as an authorized local file, with its rights and evidence level preserved.
