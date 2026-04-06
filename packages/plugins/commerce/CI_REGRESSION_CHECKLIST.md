# Minimal required regression checks for commerce plugin tickets

Use this as a ticket-ready acceptance gate for follow-on work.

## Reusable ticket template (copy/paste)

### Ticket: Strategy A — Provider Contract Hardening

**Summary**
- Scope: Strategy A only (contract drift hardening, no topology changes).
- Goal: centralize provider defaults/contracts/adapters without changing runtime behavior.

**Acceptance checklist**
- [ ] Scope lock verified (see section 0).
- [ ] T1 canonical provider contract source in place.
- [ ] T2 seam exports consolidated.
- [ ] T3 tests added/updated and passing.
- [ ] T4 regression proof executed.
- [ ] DoD (section 0) complete.

**Blocking assumptions**
- Do not include second-provider routing until a second provider is active.
- Do not include MCP command surfaces unless commerce MCP command package is actively scoped.

## 0) Strategy A (contract hardening, no topology change) — ticket checklist

### Scope lock (hard stop)

- [ ] Runtime behavior unchanged (`checkout`, `webhook`, `finalize`, diagnostics flow).
- [ ] No provider routing/registry introduced in this ticket.
- [ ] No MCP command surface added in this ticket.
- [ ] No runtime gateway branching changes.

### Contract hardening tasks (must complete in order)

- [ ] **T1 — Canonicalize payment default source**
  - [ ] Confirm shared default/payment provider constant is in `src/services/commerce-provider-contracts.ts`.
  - [ ] Confirm checkout-path resolution delegates to that shared contract.
  - [ ] Confirm webhook adapter input contract type is the shared contract.

- [ ] **T2 — Consolidate seam exports**
  - [ ] Ensure `commerce-extension-seams.ts` re-exports actor constants/types from the shared contract module.
  - [ ] Ensure `webhook-handler.ts` references shared adapter contracts for seam entry types.
  - [ ] Ensure plugin public exports surface contract symbols for integrations (`index.ts`).

- [ ] **T3 — Update acceptance tests**
  - [ ] `src/services/commerce-provider-contracts.test.ts`
    - [ ] `undefined`/blank provider input resolves to default.
    - [ ] explicit provider input is preserved.
    - [ ] actor map keys/values are stable (`system`, `merchant`, `agent`, `customer`).
  - [ ] `src/handlers/checkout-state.test.ts`
    - [ ] `resolvePaymentProviderId` behavior remains unchanged for missing/blank ids.
  - [ ] `src/handlers/webhook-handler.test.ts` and `src/services/commerce-extension-seams.test.ts`
    - [ ] adapter type/wiring contracts remain behavior-compatible.
    - [ ] contract refactor does not alter `createPaymentWebhookRoute` semantics.

- [ ] **T4 — Regression proof**
  - [ ] Execute targeted and package-level test passes documented below:
    - [ ] `pnpm --filter @emdash-cms/plugin-commerce test services/commerce-provider-contracts.test.ts`
    - [ ] `pnpm --filter @emdash-cms/plugin-commerce test`
  - [ ] Ensure existing baseline suite count is unchanged and no unrelated tests are required to pass newly.

### Definition of done

- [ ] Strategy A docs updated with scope/deferral statements in:
  - `COMMERCE_DOCS_INDEX.md`
  - `COMMERCE_EXTENSION_SURFACE.md`
  - `AI-EXTENSIBILITY.md`
  - `HANDOVER.md`
- [ ] No production logic change in payment, finalize, webhook ordering, or token/idempotency rules.
- [ ] Changes are additive and isolated to contract layering.
- [ ] Ticket is blocked for broader architecture changes unless one of the hard gates below is true:
  - a second payment provider is live, or
  - `@emdash-cms/plugin-commerce-mcp` command surface is actively in scope.

## 1) Finalization diagnostics (queryFinalizationState)

- Assert rate-limit rejection (`rate_limited`) when `consumeKvRateLimit` denies.
- Assert cache or in-flight coalescing: repeated or concurrent identical keys do not
  multiply `orders.get` / storage reads beyond one pass per cache window.

## 2) Concurrency / replay regression

- Add/extend a test that replays the same webhook event from two callers with shared
  `providerId` + `externalEventId` and asserts:
  - Exactly one settlement side-effect is recorded (`order` reaches paid once).
  - `queryFinalizationState` transitions to `replay_processed` or `replay_duplicate`.
  - No uncontrolled exceptions are emitted for second-flight calls.
- Ensure logs include `commerce.finalize.inventory_reconcile`, `payment_attempt_update_attempt`,
  and terminal `commerce.finalize.completed` / replay signal.

## 3) Inventory preflight regression

- Add/extend a test where cart inventory is stale/out-of-stock and checkout is rejected
  with one of:
  - `PRODUCT_UNAVAILABLE`
  - `INSUFFICIENT_STOCK`
- Verify preflight happens before order creation and idempotency recording.
- Verify stock/version snapshots (`inventoryVersion`) are checked by finalize before decrement.

## 4) Idempotency edge regression

- Add/extend a test for each new mutation path that verifies:
  - Same logical idempotency key replays return stable response when request payload hash
    is unchanged.
  - Payload hash drift (header/body mismatch or changed request body) is rejected.
  - Duplicate storage writes in an error/retry path do not create duplicate ledger rows.
- Ensure replay states still preserve all required idempotency metadata (`route`, `attemptCount`,
  `result`).

## 5) External-review memo action roadmap (next phase)

Use this section when continuing from the latest external review memo. Tickets are
narrow, high-signal, and ordered by failure risk.

### 5A) Concurrency and duplicate delivery safety

- [ ] Add/extend a race-focused test that drives same-event concurrent `webhooks/stripe`
  handlers with identical `providerId` + `externalEventId`.
- [ ] Assert exactly one terminal side-effect set is produced for the event:
  - one order-payment success
  - one ledger movement set at most
- [ ] Assert follow-up flights return replay-safe statuses (`replay_processed` or
  `replay_duplicate`) without duplicate stock/ledger side effects.
- [ ] Preserve diagnostic visibility for replay transitions and finalization completion log points.

### 5B) Pending-state contract safety

- [ ] Add/extend tests proving `pending` is a claim marker + resumable state boundary:
  - resume from `pending` with missing/late finalize token,
  - resume transition when order is already paid,
  - nonterminal writes are not forced into `error` unless expected terminal inventory condition is met.
- [ ] Assert each finalize branch keeps `resumeState` and `inventoryState` coherent for operator visibility.

### 5C) Ownership/possession boundary hardening

- [ ] Add/extend tests for possession failures at all relevant entrypoints:
  - `cart/get` with wrong/missing owner token,
  - `checkout` when cart ownership hash state is inconsistent,
  - `checkout/get-order` with missing/wrong finalize token.
- [ ] Assert unauthorized paths keep response shape stable and do not expose token-derived internals.

### 5D) Roadmap gate before money-path expansion

- [ ] Re-affirm the "narrow kernel first" guardrail in `HANDOVER.md` and
  `COMMERCE_DOCS_INDEX.md` before any new provider runtime expansion.
- [ ] Keep Scope lock active: no provider routing/MCP command surface expansion until a second
  provider or active `@emdash-cms/plugin-commerce-mcp` scope request.
- [ ] Keep ticket order:
  1. 5A
  2. 5B
  3. 5C
  4. 5D

### 5E) Deterministic lease/expiry policy for claim reuse

- [ ] Document claim lease semantics (`claimOwner`/`claimToken`/`claimVersion`/`claimExpiresAt`) in
  `COMMERCE_EXTENSION_SURFACE.md` and `FINALIZATION_REVIEW_AUDIT.md`.
- [ ] Ensure `assertClaimStillActive()` checks lease ownership + lease expiry at every mutable finalize
  boundary before performing:
  - inventory writes,
  - order settlement,
  - payment-attempt transition,
  - final receipt write.
- [ ] Verify behavior for malformed or missing claim state metadata returns safe replay semantics instead of
  partial mutation.
- [ ] Keep race-focused replay tests passing for:
  - stale claim reclamation,
  - in-flight claim steal,
  - stale lease preventing unsafe writes.

### 5F) Rollout and documentation follow-up

- [x] Confirm `HANDOVER.md`, `COMMERCE_DOCS_INDEX.md`, and `AI-EXTENSIBILITY.md` reflect finalized 5E status.
- [x] Prepare a staged rollout switch plan (`COMMERCE_USE_LEASED_FINALIZE`) so strict lease enforcement can
  be toggled predictably in staged environments.
- [x] Run and archive both rollout-mode command families before enabling strict mode broadly:
  - [x] Legacy behavior check (flag off): `pnpm --filter @emdash-cms/plugin-commerce test`.
  - [x] Strict lease check mode: `COMMERCE_USE_LEASED_FINALIZE=1 pnpm --filter @emdash-cms/plugin-commerce test`.
  - [x] Focused smoke on strict finalize regression:
    `COMMERCE_USE_LEASED_FINALIZE=1 pnpm --filter @emdash-cms/plugin-commerce test src/orchestration/finalize-payment.test.ts`.
  - [x] Proof artifacts are archived in:
    - `COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md` → [Legacy test output](./rollout-evidence/legacy-test-output.md)
    - `COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md` → [Strict test output](./rollout-evidence/strict-test-output.md)
    - `COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md` → [Strict finalize smoke output](./rollout-evidence/strict-finalize-smoke-output.md)
- [x] Record proof artifacts for:
  - command outputs for both modes,
  - `src/orchestration/finalize-payment.test.ts` passing in both modes,
  - docs updates in `COMMERCE_DOCS_INDEX.md`, `COMMERCE_EXTENSION_SURFACE.md`, and `FINALIZATION_REVIEW_AUDIT.md`.
- [x] Confirm environment promotion plan for `COMMERCE_USE_LEASED_FINALIZE` is written and that operations approval state is recorded before routing production-like webhook traffic through strict mode.
  - [x] Approval evidence block + table is in
    `COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md`.
  - [x] Broad webhook traffic remains blocked in this branch until explicit production operations clearance is attached.

### 6) Optional AI/LLM roadmap backlog (post-MVP)

- [ ] Treat `COMMERCE_AI_ROADMAP.md` as the source of truth for the next optional 5-item backlog:
  - Finalization incident forensics copilot.
  - Webhook semantic drift guardrail.
  - Reconciliation copilot for paid-but-wrong-stock events.
  - Customer-incident communication templates.
  - Catalog copy/type QA.
- [ ] Keep all five features advisory/read-only in initial implementation until evidence gates are added.
- [ ] Add execution tickets only after `Scope lock` and `Strategy A` obligations remain fully intact.
- [ ] Ensure every item includes an explicit review mode and explicit operator approval path before any write action.
