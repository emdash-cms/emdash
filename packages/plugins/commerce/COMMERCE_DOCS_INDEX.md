# Commerce plugin documentation index

## Operations and support

For a quick reviewer entrypoint: `@THIRD_PARTY_REVIEW_PACKAGE.md` → `external_review.md` → `SHARE_WITH_REVIEWER.md`.

- [Paid order but stock is wrong (technical)](./PAID_BUT_WRONG_STOCK_RUNBOOK.md)
- [Paid order but stock is wrong (support playbook)](./PAID_BUT_WRONG_STOCK_RUNBOOK_SUPPORT.md)

## Architecture and implementation

- `AI-EXTENSIBILITY.md` — future vector/LLM/MCP design notes
- `COMMERCE_AI_ROADMAP.md` — post-MVP LLM/AI feature roadmap (5 scoped items)
- `HANDOVER.md` — current execution handoff and stage context
- `commerce-plugin-architecture.md` — canonical architecture summary
- `COMMERCE_EXTENSION_SURFACE.md` — extension contract and closed-kernel rules
- `FINALIZATION_REVIEW_AUDIT.md` — pending receipt state transitions and replay safety audit
- `CI_REGRESSION_CHECKLIST.md` — regression gates for follow-on tickets

### Strategy A (Contract Drift Hardening) status

**Strategy A metadata**

- Last updated: 2026-04-03
- Owner: emDash Commerce plugin lead (handoff-ready docs update)
- Current phase owner: Strategy A follow-up only
- Status in this branch: 5A (same-event duplicate-flight concurrency assertions), 5B (pending-state resume-state visibility and non-terminal branch behavior), 5C (possession boundary assertions), 5D (scope lock reaffirmed), 5E (deterministic claim lease/expiry policy), and 5F (staged rollout check/reporting for strict claim lease mode).

- Scope: **active for this iteration only** and **testable without new provider runtime**.
- Goal: keep `checkout`/`webhook` behavior unchanged while reducing contract drift across payment adapters.
- Constraint: no broader provider runtime refactor yet.
- Activation guardrail: defer provider- and MCP-command architecture work until either:
  - a second payment provider is actively onboarded, or
  - an `@emdash-cms/plugin-commerce-mcp` command surface is shipped.
- Relevant files:
  - `src/services/commerce-provider-contracts.ts`
  - `src/services/commerce-provider-contracts.test.ts`

## Plugin code references

- `package.json` — package scripts and dependencies
- `tsconfig.json` — TypeScript config
- `src/services/` and `src/orchestration/` — extension seams and finalize logic
- `src/handlers/` — route handlers (cart, checkout, webhooks)
- `src/orchestration/` — finalize orchestration and inventory/attempt updates
- `src/catalog-extensibility.ts` — kernel rules + extension seam contracts

### Ticket starter: Strategy A (contract hardening)

Use this when opening follow-up work:

1) Set scope to Strategy A only (contract drift hardening, no topology change).
2) Execute the Strategy A checklist in `CI_REGRESSION_CHECKLIST.md` sections 0–5, with optional 5F follow-through.
3) Confirm docs updates are in scope:
   - `COMMERCE_DOCS_INDEX.md`
   - `COMMERCE_EXTENSION_SURFACE.md`
   - `AI-EXTENSIBILITY.md`
   - `HANDOVER.md`
   - `FINALIZATION_REVIEW_AUDIT.md`
4) Run proof commands:
   - `pnpm --filter @emdash-cms/plugin-commerce test services/commerce-provider-contracts.test.ts`
   - `pnpm --filter @emdash-cms/plugin-commerce test`
5) Rollout for strict lease enforcement:
   - Default path keeps strict lease checks disabled for compatibility.
   - Enable `COMMERCE_USE_LEASED_FINALIZE=1` in staged environments to enforce malformed/missing lease metadata replay
     before turning it on for broader webhook-driven traffic.
   - Keep a command log and attach strict-mode and default-mode test outputs to release notes.

## External review continuation roadmap

After the latest third-party memo, continue systematically with
`CI_REGRESSION_CHECKLIST.md` sections 5A–5E (in order) before broadening
provider topology.
5A/5B/5C/5D/5E have been implemented in this branch; 5F documents rollout/testing follow-up and requires
environment promotion controls for strict lease mode before broader traffic exposure.

For post-5F planning, follow `COMMERCE_AI_ROADMAP.md` as the optional
reliability-support-catalog extension backlog.

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
