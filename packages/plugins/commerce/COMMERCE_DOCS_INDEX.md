# Commerce plugin documentation index

## Operations and support

For a quick reviewer entrypoint: `external_review.md` → `SHARE_WITH_REVIEWER.md`.

- [Paid order but stock is wrong (technical)](./PAID_BUT_WRONG_STOCK_RUNBOOK.md)
- [Paid order but stock is wrong (support playbook)](./PAID_BUT_WRONG_STOCK_RUNBOOK_SUPPORT.md)

## Architecture and implementation

- `AI-EXTENSIBILITY.md` — future vector/LLM/MCP design notes
- `HANDOVER.md` — current execution handoff and stage context
- `commerce-plugin-architecture.md` — canonical architecture summary
- `COMMERCE_EXTENSION_SURFACE.md` — extension contract and closed-kernel rules
- `FINALIZATION_REVIEW_AUDIT.md` — pending receipt state transitions and replay safety audit
- `CI_REGRESSION_CHECKLIST.md` — regression gates for follow-on tickets

## Plugin code references

- `package.json` — package scripts and dependencies
- `tsconfig.json` — TypeScript config
- `src/services/` and `src/orchestration/` — extension seams and finalize logic
- `src/handlers/` — route handlers (cart, checkout, webhooks)
- `src/orchestration/` — finalize orchestration and inventory/attempt updates
- `src/catalog-extensibility.ts` — kernel rules + extension seam contracts

## Plugin HTTP routes

| Route                | Role                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `cart/upsert`        | Create or update a `StoredCart`; issues `ownerToken` on first creation                           |
| `cart/get`           | Read-only cart snapshot; `ownerToken` when cart has `ownerTokenHash`                             |
| `checkout`           | Create `payment_pending` order + attempt; idempotency; `ownerToken` if cart has `ownerTokenHash` |
| `checkout/get-order` | Read-only order snapshot; always requires matching `finalizeToken`                               |
| `webhooks/stripe`    | Verify signature → finalize                                                                      |
| `recommendations`    | Disabled contract for UIs                                                                        |

## Diagnostics and runbook surfaces

- `queryFinalizationState` (via `src/services/commerce-extension-seams.ts`) for runbook and MCP reads — applies per-IP rate limit, ~10s KV cache, and in-isolate in-flight coalescing (see `COMMERCE_LIMITS` / `finalization-diagnostics-readthrough.ts`).
- `queryFinalizationStatus` (via `src/orchestration/finalize-payment.ts`) returns the same shape but **without** those guards; prefer `queryFinalizationState` for HTTP/MCP polling unless you are in a controlled test or internal path.

All routes mount under `/_emdash/api/plugins/emdash-commerce/<route>`.

Implementation note: `src/index.ts` is the active source of truth for what the plugin exposes over HTTP today.
