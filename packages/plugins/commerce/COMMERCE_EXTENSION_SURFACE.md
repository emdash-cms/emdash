# Commerce kernel rules and extension surface

## Source of truth

- Runtime route surface: `src/index.ts routes` (authoritative for what is currently exposed).
- Platform status: `HANDOVER.md`.
- Stability contracts: this file and `src/catalog-extensibility.ts` for extension types.

## Closed-kernel rules

The money path is intentionally closed:

- `checkout` must remain the only place that creates order/payment attempt state in this stage.
- `webhooks/stripe` must be the only route that transitions payment state in production.
- `finalizePaymentFromWebhook` is the sole internal mutation entry for payment-success
  and inventory-write side effects.
- `queryFinalizationStatus` / `queryFinalizationState` are read-only observability views.
- Order/token authorization and idempotency checks must remain unchanged unless a proven
  bug justifies a narrow patch and regression test.

These rules are captured in `COMMERCE_KERNEL_RULES` in `src/catalog-extensibility.ts`.

## Approved extension seams

### Recommendation seam (read-only)

- `recommendations` route accepts an optional `CommerceRecommendationResolver`.
- Resolver contracts are defined in `CommerceRecommendationInput` / `CommerceRecommendationResult`.
- Resolver implementations must only return candidate `productIds` and must not mutate
  commerce collections.
- `createRecommendationsRoute()` exports a route constructor for this seam.

### Webhook adapter seam (provider integration)

- `CommerceWebhookAdapter<TInput>` and `handlePaymentWebhook` in
  `src/handlers/webhook-handler.ts` define the only supported adapter seam for
  third-party gateway integrations.
- Providers are responsible for request verification and input extraction.
- Core writes still happen in the shared finalize orchestration.
- `createPaymentWebhookRoute()` wraps an adapter into a route-level entry point.

#### Webhook adapter contract requirements

- verify authenticity and freshness before returning finalize inputs,
- return a stable `correlationId`,
- return a rate-limit suffix suitable for request burst protection.

Adapters MUST NOT perform commerce writes (`orders`, `paymentAttempts`,
`webhookReceipts`, `inventoryLedger`, `inventoryStock`). All mutation decisions
must pass through `finalizePaymentFromWebhook`.

#### Strategy A (contract drift hardening): active scope only

**Strategy A metadata**

- Last updated: 2026-04-03
- Owner: emDash Commerce platform/core team
- Scope owner: contract layer only, no behavior change

- Keep all checkout/webhook runtime behavior unchanged.
- Consolidate provider defaults, adapter shape, and MCP actor constants in a shared contract module (`src/services/commerce-provider-contracts.ts`).
- Do not introduce provider registry/routing multiplexing yet.
- Do not introduce an MCP command surface yet.
- Leave runtime gateway behavior on `webhooks/stripe` until a second provider is enabled.
- Hardening checkpoint in this branch: added regression assertions for same-event duplicate
  webhook finalization convergence (5A), pending-state resume-status visibility (5B),
  possession-guard coverage (5C), and deterministic claim lease/expiry behavior (5E)
  with active ownership revalidation on all critical finalize-write stages.
- 5F strict lease proof artifacts were specified and validated in docs+tests, with evidence tracked in `COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md` (historical record).
- Optional post-5F operational/AI work is tracked in `COMMERCE_AI_ROADMAP.md` and remains
  advisory until explicitly staged.
- Continue to enforce read-only rules for diagnostics via `queryFinalizationState`.

### Canonical claim lease enforcement

- Strict claim lease checks (ownership revalidation and malformed-lease replay behavior) are the active finalize path.
- `COMMERCE_USE_LEASED_FINALIZE` is retained only for rollout/evidence parity and
  for re-running the historical strict-mode command families when needed.
- `COMMERCE_USE_LEASED_FINALIZE` does **not** represent an alternative runtime mode in this branch; strict lease behavior remains canonical and should stay in production.
- Historical rollout steps and rollback criteria are retained for context in `COMMERCE_USE_LEASED_FINALIZE_ROLLOUT.md`, but operational controls should treat the strict behavior as baseline.

### Read-only MCP service seam

- `queryFinalizationState()` exposes a read-only status query path for MCP tooling.
- MCP tools should call this helper (or package HTTP route equivalents) rather than
  touching storage collections directly.

`queryFinalizationState` returns:

- `isInventoryApplied`
- `isOrderPaid`
- `isPaymentAttemptSucceeded`
- `isReceiptProcessed`
- `receiptStatus` (`missing|pending|processed|error|duplicate`)
- `resumeState` (`not_started`, `pending_inventory`, `pending_order`,
  `pending_attempt`, `pending_receipt`, `replay_processed`,
  `replay_duplicate`, `error`, `event_unknown`)

### Read-only validator and optional finalize-time invariants

Operators can combine:

- `queryFinalizationState` read model (order/receipt/attempt/ledger state), and
- read-only inventory/stock checks during incident review.

For deeper drift detection, set `COMMERCE_ENABLE_FINALIZE_INVARIANT_CHECKS=1` so
completed finalize calls also log warning-level invariant signals when order paid,
attempt success, and ledger/stock application are unexpectedly out of sync.
This flag should be used as a temporary safety net during incident response only,
 not as part of normal fast-path processing.

### Paid-vs-receipt semantics for storefront and support tooling

`isOrderPaid` is the order-facing signal. It should drive user-visible “payment
completed” messaging.

`receiptStatus` is event-facing signal. It should drive retry/recovery visibility:

- `missing`: there is no event receipt row yet.
- `pending`: event is in partial-finalization recovery and can be retried through safe re-invocation.
- `processed`: event has been handled once; duplicates should be treated as idempotent replay.
- `error`: explicit finalization failure; manual triage before more retries.
- `duplicate`: duplicate event replay path after idempotent precondition short-circuit.

Optional storefront-safe fields to show in support dashboards:

- `isReceiptProcessed` (boolean)
- `isPaymentAttemptSucceeded` (boolean)
- `resumeState` (action hint for support runbooks)
- `receiptErrorCode` when `receiptStatus === "error"` (operation-classified terminal error)

For Stage-1, `receiptStatus === "error"` is intentionally treated as a runbook-only recovery
signal (no built-in admin transition API yet). Recovery tooling should require an explicit
human operator decision using `receiptErrorCode` and related checkpoints.

This keeps storefront user messaging tied to order state while preserving webhook
forensics for operators.

**Option B (moderate polling):** this helper applies a per-client-IP KV rate limit
(`COMMERCE_LIMITS.defaultFinalizationDiagnosticsPerIpPerWindow` per
`defaultRateWindowMs`), a short KV read-through cache
(`finalizationDiagnosticsCacheTtlMs`, default 10s), and in-isolate in-flight
coalescing for identical `(orderId, providerId, externalEventId)` keys. Direct
`queryFinalizationStatus` calls bypass these guards and are intended for tests
or tightly controlled internal use only.

### How to tune Option B (when call volume grows)

Use this as a practical playbook before scaling to precomputed status projections:

- **Support/Admin polling (low frequency):**
  - Keep defaults.
  - Cache TTL: `10_000ms`.
  - IP diagnostics limit: `60 / 60s`.
- **Team dashboard with moderate polling:**
  - Raise `defaultFinalizationDiagnosticsPerIpPerWindow` in controlled increments (e.g. `120` or `180`) if rate-limit rejections appear in healthy workflows.
  - Keep cache at `10_000ms` first; increase only if read spikes remain after rate-limit tuning.
- **Agent-driven batch checks (multiple operators/tools):**
  - Increase cache TTL gradually (`15_000`–`30_000ms`) to flatten read spikes.
  - Prefer caller-side jitter/backoff over unlimited polling loops.

If you regularly see sustained saturation even after these knobs:
- move diagnostics calls to larger `finalizationDiagnosticsCacheTtlMs` window,
- or adopt the next step (snapshot projection) for high-throughput, always-on polling.

### Environment adapter checklist for `queryFinalizationState`

For EmDash-native integrations (HTTP routes, cron workers, and any EmDash-hosted
tooling surface), adapter code should preserve the shared semantics by passing a
single coherent `RouteContext` into the seam:

- Build a stable `Request` object and set `request.method` explicitly (the seam
  expects standard handler semantics).
- Populate `requestMeta.ip` from the platform edge/request context.
- Bind `ctx.kv` to the plugin KV access layer (same key namespace across
  environments).
- Keep `ctx.storage`, `ctx.log`, and `ctx.requestMeta` present and consistent.
- Forward auth/session context only as needed for route-level gates outside this seam;
  the seam itself is read-only and does not mutate commerce storage.
- Keep per-environment wrappers thin: all diagnostics caching, rate limiting, and
  coalescing live in `queryFinalizationState`.

This keeps `queryFinalizationState` portable: one kernel path, many transport
adapters.

### MCP-ready service entry point policy

- MCP integrations are expected to call the same service paths and error codes as HTTP
  route entry points.
- MCP-facing tools must not issue storage writes directly into commerce collections.
- Any future MCP command surface should treat this file’s rules as non-negotiable.

## Failure behavior expectations

- Receipt states remain:
  - `pending`: resumable/finalize-retry path.
  - `processed` or `error`: terminal and explicit.
- A finalized order must never be produced by third-party code; all finalize side effects
  come from kernel services.
- Extension errors should be observable but must not degrade kernel invariants.
- Read-only seams are the only extension path for payment-state inspection.
