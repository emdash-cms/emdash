# 3rd Party Technical Review Request Pack

## Executive Summary

This workspace is implementing a first-party **EmDash commerce plugin** as a correctness-first, kernel-centric slice before broader platform expansion. The objective is to avoid the complexity and fragility that comes with external CMS integrations (for example WooCommerce parity work) by owning the commerce core in EmDash with a provider-first abstraction that supports a pragmatic path to additional providers.

This is not a full-feature commerce platform yet. It is intentionally narrowed to a **single provable end-to-end path**:

- one canonical order lifecycle model,
- idempotent cart/checkout/payment operations,
- fixed-window rate limiting,
- strict provider execution contracts,
- deterministic finalize behavior for webhook-driven payment confirmation.

The current edits align the code with the architectural contracts in the handover and architecture documents by tightening error semantics, clarifying rate-limit semantics, and hardening finalize decision logic.

---

## Why this approach was chosen

### Problem framing
- EmDash can support digital-first and traditional products in one place, but the previous path in many stacks starts with broad integration layers and only later fixes correctness issues.
- Mission-critical commerce systems fail most on correctness gaps: duplicate capture, non-idempotent checkout, replaying webhook side effects, inconsistent state transitions, and poor observability.
- The strategy here is therefore: **kernel-first, correctness-first, payment-first, then feature expansion**.

### What makes this path robust
- A single source of truth for commerce behavior in `packages/plugins/commerce/src/kernel`.
- Canonical enums + contracts for errors, states, and policies.
- Strongly typed provider interfaces with explicit extension boundaries.
- Storage-backed behavior for idempotency and state transitions as code evolves.

### Why this is “phase 1” rather than full marketplace
- Full merchant/platform features are intentionally deferred.
- The current scope is to prove one safe path in production-like conditions before adding:
  - admin dashboards,
  - additional providers,
  - complex settlement workflows,
  - multi-provider orchestration,
  - advanced fraud/rate-limit controls.

---

## Source documents and governing references

You can evaluate alignment quickly by reading in this order:

1. `HANDOVER.md` (current operating plan and open questions).
2. `commerce-plugin-architecture.md` (authoritative architecture contract).
3. `emdash-commerce-deep-evaluation.md` and `emdash-commerce-final-review-plan.md` (risk framing and recommended sequencing).
4. `3rdpary_review_2.md` and `3rdpary_review.md` (historical review context).
5. `AGENTS.md` and `skills/creating-plugins/SKILL.md` (implementation guardrails and plugin standards).

---

## Current target architecture

### 1) Plugin model and execution assumptions

- EmDash supports both native and standard plugins.
- This implementation is positioned as a **native plugin** for depth and local behavior in phase 1.
- Provider support is built on a registry + typed interface with policy controls.
- The long-term path allows provider adapters in-process (first-party) or delegated execution (worker/HTTP route) without changing the kernel’s contract.

### 2) Commerce core principles in code

- **Kernel owns invariants**: state transitions, checks, and decision points live in core utility + schema modules.
- **Provider is a service**: providers perform external-facing operations and return canonical events/results.
- **Persistence + idempotency are required**, not optional.
- **Finalize is single path**: one authoritative function decides whether payment finalization should proceed, become noop, or conflict.

### 3) Domain model direction

- Product typing follows a discriminated union pattern (`type + typeData`) to avoid null/optional ambiguity.
- Order/payment/cart models are intentionally explicit state machines with narrow allowed transitions.
- Inventory is tracked with snapshot/ledger thinking to support reconciliation and deterministic replay behavior.

### 4) Error contract strategy

- Error codes are canonicalized (`snake_case`) and mapped to `(httpStatus, retryable)` metadata.
- Consumers should treat error code + status as compatibility surface; message wording is secondary.

---

## Changes completed in this review cycle

The recent corrections focused on three mismatches that had direct correctness impact:

### A. Canonical commerce errors

File: `packages/plugins/commerce/src/kernel/errors.ts`

- Replaced the partial internal map with the canonical `COMMERCE_ERRORS` set from `commerce-plugin-architecture.md`.
- This makes error handling predictable across modules and aligns code expectations with the design document.

### B. Rate-limit semantics correction

Files:
- `packages/plugins/commerce/src/kernel/limits.ts`
- `packages/plugins/commerce/src/kernel/rate-limit-window.ts`
- `packages/plugins/commerce/src/kernel/rate-limit-window.test.ts`

- Confirmed implementation is fixed-window.
- Clarified comments so docs no longer describe a sliding window.
- Added/updated tests to validate boundary behavior of fixed-window counters.

### C. Finalization decision logic hardening

Files:
- `packages/plugins/commerce/src/kernel/finalize-decision.ts`
- `packages/plugins/commerce/src/kernel/finalize-decision.test.ts`

- Expanded `OrderPaymentPhase` coverage for robust state reasoning.
- Expanded finalize outcomes for webhook receipt states (`processed`, `duplicate`, `pending`, `error`).
- Ensured explicit precedence for already-paid/cached replay conditions and non-finalizable states.
- Added unit tests for the full decision matrix.

---

## Why this matters for third-party review

This bundle is designed to let an external reviewer validate:

1. **Specification-conformance**
   - Does implementation match the architecture claims?
   - Are ambiguous comments/assumptions removed?

2. **Failure behavior**
   - How the system reacts under duplicate webhook, replay, and out-of-order events.
   - Whether idempotency controls produce bounded behavior.

3. **Operational safety**
   - Whether rate-limiting semantics are consistent and test-anchored.
   - Whether state transitions prevent accidental double-completion.

4. **Expansion readiness**
   - Whether abstractions are sufficient for local Stripe slice now and future provider adapters later.

---

## Suggested review checklist for external reviewer

1. Validate the contract mapping end-to-end:
   - Compare `commerce-plugin-architecture.md` vs `packages/plugins/commerce/src/kernel/errors.ts` and finalize decision behavior.
2. Validate idempotency assumptions in kernel helpers:
   - `packages/plugins/commerce/src/kernel/idempotency-key.ts` and existing tests.
3. Validate rate limiting behavior under burst and window edge cases:
   - `packages/plugins/commerce/src/kernel/rate-limit-window.ts` + tests.
4. Validate finalize decision precedence:
   - `packages/plugins/commerce/src/kernel/finalize-decision.ts` + tests.
5. Validate provider boundary and policy behavior:
   - `packages/plugins/commerce/src/kernel/provider-policy.ts`.
6. Validate integration style:
   - Compare with EmDash plugin reference implementations in `packages/plugins/forms/src/*`.
7. Validate that development constraints and conventions are observed:
   - `AGENTS.md` and `skills/creating-plugins/SKILL.md`.

---

## Potential risk areas to watch closely

- **Scope drift**: It is easy to add provider-agnostic abstractions before state and payload contracts are fully stable.
- **State explosion**: `OrderPaymentPhase` and webhook status unions must remain explicit; hidden values can create silent transitions.
- **Replay semantics**: Webhook handling must be deterministic across retries, including explicit memoization behavior around already-processed and duplicate signatures.
- **Operator UX coupling**: As soon as admin tooling starts writing states, they must enforce the same kernel transitions and not bypass invariants.

---

## Open assumptions requiring confirmation

- At least one external webhook/event source (likely Stripe in phase 1) will be handled via a stable reconciliation strategy that surfaces both `processed` and `error` receipt states to finalize logic.
- Inventory decrement should remain finalize-gated (not merely cart-authorized) in the first stable slice.
- Storage-backed idempotency and webhook receipt persistence is planned in the next coding phase as stated in the handover document.
- Analytics/financial reporting is intentionally excluded from phase 1 to avoid unverified derived state.

---

## Suggested immediate next milestones (so review feedback can be verified)

1. Implement/finish storage-backed persistence for:
   - webhook receipts,
   - payment attempts,
   - idempotency key replay windows,
   - finalized order snapshots.
2. Integrate the Stripe provider slice end-to-end with kernel contracts.
3. Implement the canonical checkout and webhook endpoints.
4. Add replay/conflict tests that assert idempotent finalization under duplicate webhook deliveries.
5. Provide minimal admin visibility for failure and reconciliation status.

---

## Included files in this review package

This package contains:

- Architecture and directive documents: `HANDOVER.md`, `commerce-plugin-architecture.md`, `emdash-commerce-deep-evaluation.md`, `emdash-commerce-final-review-plan.md`, `high-level-plan.md`, `commerce-vs-x402-merchants.md`, `3rdpary_review.md`, `3rdpary_review_2.md`.
- Coding guardrails and plugin conventions: `AGENTS.md`, `skills/creating-plugins/SKILL.md`.
- Commerce plugin metadata and kernel code: `packages/plugins/commerce/package.json`, `packages/plugins/commerce/tsconfig.json`, `packages/plugins/commerce/vitest.config.ts`, `packages/plugins/commerce/src/kernel/errors.ts`, `packages/plugins/commerce/src/kernel/finalize-decision.ts`, `packages/plugins/commerce/src/kernel/finalize-decision.test.ts`, `packages/plugins/commerce/src/kernel/limits.ts`, `packages/plugins/commerce/src/kernel/rate-limit-window.ts`, `packages/plugins/commerce/src/kernel/rate-limit-window.test.ts`, `packages/plugins/commerce/src/kernel/idempotency-key.ts`, `packages/plugins/commerce/src/kernel/idempotency-key.test.ts`, `packages/plugins/commerce/src/kernel/provider-policy.ts`.
- Plugin reference implementation for pattern comparison: `packages/plugins/forms/src/index.ts`, `packages/plugins/forms/src/storage.ts`, `packages/plugins/forms/src/schemas.ts`, `packages/plugins/forms/src/handlers/submit.ts`, `packages/plugins/forms/src/types.ts`.

---

## Delivery

This document is named `3rdpary_review_4.md` and should be reviewed before `latest-code_4.zip`.

