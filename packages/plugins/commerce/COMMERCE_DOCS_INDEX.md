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
- `src/handlers/` — route handlers (checkout/webhooks)
- `src/orchestration/` — finalize orchestration and inventory/attempt updates
