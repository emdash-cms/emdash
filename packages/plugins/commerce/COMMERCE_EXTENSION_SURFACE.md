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
