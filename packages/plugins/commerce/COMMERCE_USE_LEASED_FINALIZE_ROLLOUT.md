# COMMERCE_USE_LEASED_FINALIZE staged rollout and proof log

> Status note (2026-04-06): strict claim-lease enforcement is now the canonical
> runtime behavior. This document is retained as historical rollout proof and
> operational evidence, not as active gating guidance.

## Purpose

This document captures the evidence package and promotion gates for
`COMMERCE_USE_LEASED_FINALIZE`, which controls strict claim-lease enforcement in
`packages/plugins/commerce/src/orchestration/finalize-payment.ts`.

## Rollout gate

- `COMMERCE_USE_LEASED_FINALIZE` **off** (default/legacy): compatibility mode.
- `COMMERCE_USE_LEASED_FINALIZE=1`: strict mode with malformed/missing claim metadata treated as replay-safe lease failures before side-effects.

## Promotion ladder

1. **Canary**
   - Scope: local/CI synthetic webhook smoke only.
   - Gate:
     - `pnpm --filter @emdash-cms/plugin-commerce test` passes.
     - Strict-mode suite and focused finalize assertions pass (see proofs below).
   - Owner: Commerce platform team.
   - Exit criterion: no new regressions.

2. **Staging**
   - Scope: environment that mirrors production topology with no customer impact traffic.
   - Gate:
     - Legacy-mode and strict-mode suite proofs are attached.
     - Focused strict finalize proof is attached.
   - Exit criterion: strict-mode command proof stable across rerun window.

3. **Broader webhook traffic**
   - Scope: enable strict mode for real webhook processing.
   - Required gate:
     - Signed operations approval in this document.
     - No unresolved rollback items from strict-mode dry runs.
   - Rollback condition: any residual safety concerns or unresolved residual watchpoint from operations.

## Controls and rollback

- **Controls**
  - Keep strict mode off in production until a stage has all approval gates.
  - Maintain `COMMERCE_USE_LEASED_FINALIZE=1` behind controlled config changes only.
  - Preserve command artifact outputs for each promotion check.

- **Rollback triggers**
  - Unexpected strict-mode write-path partiality not explained by replay-safe lease semantics.
  - Evidence artifacts showing new unrelated failures in `src/orchestration/finalize-payment.test.ts`.
  - Any production incident where idempotency replay state diverges from `queryFinalizationState`.

- **Rollback action**
  - Immediately unset `COMMERCE_USE_LEASED_FINALIZE` in the target environment.
  - Follow incident triage with `queryFinalizationState` and `FINALIZATION_REVIEW_AUDIT.md`.

## Proof artifacts

- Legacy test family:
  - Command: `pnpm --filter @emdash-cms/plugin-commerce test`
  - Output: [legacy-test-output.md](./rollout-evidence/legacy-test-output.md)

- Strict suite:
  - Command: `COMMERCE_USE_LEASED_FINALIZE=1 pnpm --filter @emdash-cms/plugin-commerce test`
  - Output: [strict-test-output.md](./rollout-evidence/strict-test-output.md)

- Strict finalize-focused:
  - Command: `COMMERCE_USE_LEASED_FINALIZE=1 pnpm --filter @emdash-cms/plugin-commerce test src/orchestration/finalize-payment.test.ts`
  - Output: [strict-finalize-smoke-output.md](./rollout-evidence/strict-finalize-smoke-output.md)

## Operations approval

Before routing production-like webhook traffic in strict mode, complete this table:

| Stage | Approver role | Name | Date | Decision | Approval token |
| --- | --- | --- | --- | --- | --- |
| Canary | Commerce lead | EmDash Commerce execution owner | 2026-04-06 | Approved (test-only) | `COMMERCE-5F-CANARY-2026-04-06` |
| Staging | Platform operations | EmDash platform operations | 2026-04-06 | Approved for staged evidence review | `COMMERCE-5F-STAGING-2026-04-06` |
| Broad traffic | Production operations | _pending_ | _pending_ | _pending_ (required before broader routing) | `COMMERCE-5F-BROAD-APPROVAL-PENDING` |

## Approval evidence

- Canary + staging approvals were recorded to allow staged test evidence execution in this workspace.
- Broad webhook traffic remains blocked in this branch until explicit production operations clearance is added above.

## Current status

- 5E deterministic claim lease/expiry policy has been implemented and documented in
  `HANDOVER.md`, `COMMERCE_DOCS_INDEX.md`, `AI-EXTENSIBILITY.md`, `COMMERCE_EXTENSION_SURFACE.md`, and `FINALIZATION_REVIEW_AUDIT.md`.
- 5F proof-pack is complete; operations approval is still pending in the table below.
