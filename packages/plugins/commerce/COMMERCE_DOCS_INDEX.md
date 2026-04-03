# Commerce plugin documentation index

## Operations and support

- [Paid order but stock is wrong (technical)](./PAID_BUT_WRONG_STOCK_RUNBOOK.md)
- [Paid order but stock is wrong (support playbook)](./PAID_BUT_WRONG_STOCK_RUNBOOK_SUPPORT.md)

## Architecture and implementation

- `AI-EXTENSIBILITY.md` — future vector/LLM/MCP design notes
- `HANDOVER.md` — current execution handoff and stage context
- `commerce-plugin-architecture.md` — canonical architecture summary

## Plugin code references

- `package.json` — package scripts and dependencies
- `tsconfig.json` — TypeScript config
- `src/kernel/` — checkout/finalize error and idempotency logic
- `src/handlers/` — route handlers (cart, checkout, webhooks)
- `src/orchestration/` — finalize orchestration and inventory/attempt updates

## Plugin HTTP routes

| Route | Role |
|-------|------|
| `cart/upsert` | Create or update a `StoredCart`; issues `ownerToken` on first creation |
| `cart/get` | Read-only cart snapshot; `ownerToken` when cart has `ownerTokenHash` |
| `checkout` | Create `payment_pending` order + attempt; idempotency |
| `checkout/get-order` | Read-only order snapshot; always requires matching `finalizeToken` |
| `webhooks/stripe` | Verify signature → finalize |
| `recommendations` | Disabled contract for UIs |

All routes mount under `/_emdash/api/plugins/emdash-commerce/<route>`.
