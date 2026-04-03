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
