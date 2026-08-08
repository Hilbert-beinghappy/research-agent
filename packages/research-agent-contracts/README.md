# @research-agent/contracts

Versioned TypeScript and TypeBox contracts for Pi Research Agent projects, results, adapters, exchange bundles, collaboration changes, model-route decisions, Personal Memory, and the SDK/RPC v1 inspection protocol.

The package contains data contracts only. It performs no network access, filesystem writes, model calls, or adapter execution.

Personal Memory schema 1.0.0 is published through `@research-agent/contracts/memory`, encrypted snapshot envelopes through `@research-agent/contracts/memory-transfer`, and deterministic structural/invariant validators through `@research-agent/contracts/memory-validators`. `MEMORY_KEY_ALLOWLIST` defines the fixed low-risk v1 keys; validators accept only bounded structured values for those keys. Personal Memory is independent from Research Project schema 1.5.1.
