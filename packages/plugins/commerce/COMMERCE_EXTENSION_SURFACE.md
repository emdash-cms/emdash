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
- `queryFinalizationStatus`/`receiptToView` are read-only observability views.
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

### Read-only MCP service seam

- `queryFinalizationState()` exposes a read-only status query path for MCP tooling.
- MCP tools should call this helper (or package HTTP route equivalents) rather than
  touching storage collections directly.

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
