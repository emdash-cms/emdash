# Commerce plugin — AI/LLM Roadmap (post-MVP, 5 practical features)

## Why this exists

The core money path is already stable and deterministic (`cart` → `checkout` →
`webhook` → `finalize`). These features are intentionally scoped as
**post-MVP, nice-to-have enhancements** that add operational leverage and
customer-facing safeguards without replacing the deterministic kernel.

This roadmap tracks 5 specific ideas, including the two you selected:

- #8 (customer-facing incident communication)
- #9 (catalog/metadata quality guardrails)

and the three must-have reliability extensions proposed next:

- customer incident forensics copilot
- webhook event semantic drift guardrail
- paid-but-wrong-stock reconciliation copilot

---

## Global design constraints (applies to all 5)

1. **Kernel-first behavior never changes**
   - No mutation path in checkout/finalization is delegated to LLM output.
   - LLM artifacts are advisory unless explicitly approved by an operator.

2. **Deterministic core, observable LLM assist**
   - Use existing structured state (`queryFinalizationStatus`, `StoredWebhookReceipt`,
     payment attempt rows, order/stock snapshots) as input.
   - Keep suggestions side-effect free by default.

3. **Environment-gated rollout**
   - Keep every feature behind explicit feature flags/env toggles initially.
   - Start in shadow/dry-run mode and collect evidence before write/enactment.

4. **Evidence-first**
   - Every recommendation should include:
     - exact IDs (`orderId`, `externalEventId`, `paymentAttemptId`)
     - confidence score
     - what changed/what is read-only
     - precise rollback/undo path

5. **No external dependencies in core path**
   - LLM calls happen in separate operator workflows (MCP command, admin endpoint,
     cron/scheduled job, or support assistant), not inside webhook finalization handlers.

---

## Priority list (likely to be needed first)

| Rank | Feature                                    | Category                        | Why this is near-term likely needed                                                     | Primary owner                   |
| ---- | ------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------- |
| 1    | Finalization Incident Forensics Copilot    | Reliability / Ops               | Prevents long manual debugging loops on webhook replay/claim edge cases.                | Platform/ops tooling            |
| 2    | Webhook Semantic Drift Guardrail           | Security / Integrity            | Stops semantically unusual events from becoming silent recovery incidents.              | Platform security + finance ops |
| 3    | Paid-vs-Wrong-Stock Reconciliation Copilot | Operations / CX trust           | Directly protects fulfilled orders and support costs on inventory desync.               | Ops + customer support          |
| 4    | Customer Incident Communication Copilot    | Support / UX / Merchant ops     | Improves merchant and customer confidence during delayed/edge-case finalization states. | Growth + support tooling        |
| 5    | LLM Catalog Intent QA                      | Content quality / Merchandising | Improves catalog quality and reduces merchant support on listing confusion.             | Merchandising/content           |

---

## 1) Finalization Incident Forensics Copilot

### Problem

When claims/retries behave unexpectedly (e.g., `claim_in_flight` / `claim_retry_failed`
with mixed side effects), operators currently read logs manually and reconstruct a timeline.

### Proposed behavior

- Consume structured finalize telemetry:
  - `resumeState`, `receiptStatus`, `isOrderPaid`, `isInventoryApplied`
  - `isPaymentAttemptSucceeded`, `isReceiptProcessed`
  - error kinds from `receiptErrorCode` / `errorDetails`
  - finalize timeline markers from logs.
- Produce a short incident report:
  - likely root cause class,
  - likely next action (`retry`, `inspect`, `escalate`, `no-op`)
  - exact proof commands.
- Include a machine-readable playbook step sequence (copy/paste) for operators.

### Inputs

- `queryFinalizationStatus` and storage reads from finalize collections.
- Correlation fields: `orderId`, `providerId`, `externalEventId`, `claimToken`.

### Non-functional constraints

- Never auto-finalizes in advisory mode.
- Supports replay: running the same query twice should return the same explanation given same input.
- Response includes redaction of sensitive order/customer context.

### Acceptance criteria

- Given representative edge-case fixture data, explanation includes one likely cause and one
  safe action.
- Includes command snippet proving required proof artifacts.
- Can be run for merchant-facing support queue triage with bounded latency.

### Proposed rollout

1. Shadow mode (`/api` assistant returns analysis only, no actions).
2. Add audit logging for every suggestion.
3. Optional one-click follow-up tasks behind auth + permission checks.

---

## 2) Webhook Semantic Drift Guardrail

### Problem

Webhook signature verification and schema validation can pass while payload semantics drift
or look inconsistent with internal invariants.

### Proposed behavior

- Compare incoming event semantics against order/payment expectations:
  - provider metadata coherence (`orderId`, `externalEventId`, finalize binding)
  - impossible or suspicious transition markers
  - frequency anomalies for same event IDs / provider IDs
  - malformed/ambiguous actor/context combinations
- Classify as:
  - `ok`
  - `warn` (monitor)
  - `suspect` (quarantine for manual review)
- Emit a `suspect` advisory event (non-blocking default), then escalate to hard block only
  if governance policy enables stricter mode.

### Inputs

- Raw event payload + metadata from webhook adapter input.
- Current payment/order state + existing receipt rows.

### Non-functional constraints

- Must not reject valid events silently in default compatibility mode.
- Policy toggle controls enforcement (observe, warn, block).

### Acceptance criteria

- Deterministic flags for known synthetic suspicious patterns.
- No change to existing finalized orders in non-blocking mode.
- When strict mode is enabled, flagged cases become auditable and traceable in logs.

### Suggested implementation strategy

- Separate "evidence extractor" and "judge" functions for testability.
- Keep in a read/write-guarded service seam so the kernel can still enforce exact semantics.

---

## 3) Reconciliation Copilot for Paid-but-Wrong-Stock

### Problem

Complex partial-write/retry states can still produce merchant-visible mismatch where one
side of stock/payment state progressed and another did not.

### Proposed behavior

- Detect candidate mismatch classes by correlating:
  - stock movements from `inventoryLedger`
  - `inventoryStock` quantity/version
  - finalize resume state (`pending_inventory`, `pending_order`, etc.)
  - payment attempt outcome + receipt status.
- Produce ranked corrective plan:
  - no-op/confirm
  - ledger+stock correction
  - controlled re-run (single replay) with prerequisites
- For each recommendation, include:
  - idempotent SQL-style operations
  - expected resulting invariants
  - reversibility checklist.

### Inputs

- `inventoryStock`, `inventoryLedger`, `orders`, `paymentAttempts`, `webhookReceipts`.

### Non-functional constraints

- No direct stock updates by default.
- Recommendations always include audit fingerprint (ticket-ready evidence).
- Actions require explicit operator confirmation and actor tagging.

### Acceptance criteria

- For known mismatches, report at least one repair plan with safe guardrails.
- Never suggests blind auto-correct without constraints check.
- Supports dry-run mode that proves invariants before commit.

### Suggested rollout

- Start as support-tool integration only (view + copy suggestions).
- Promote to workflow assistant command after 2 release cycles with no false positives.

---

## 4) Customer Incident Communication Copilot (#8)

### Problem

After delay, replay, or partial finalization visibility, merchants need high-quality,
policy-safe language quickly.

### Proposed behavior

- Generate localized message drafts for:
  - delayed/under-review payments,
  - resumed finalization success,
  - escalation-required states.
- Templates use state-safe branching based on `isOrderPaid`, `receiptStatus`,
  `resumeState`, and payment method context.
- Output two channels:
  - merchant internal summary (support-ready)
  - customer-facing tone with policy-safe wording (if configured).

### Inputs

- Finalization state + recent event history + resume state.
- Route-level locale and merchant communication style config.

### Non-functional constraints

- Must only compose from normalized state symbols (no free-text inference).
- Compliance-safe defaults (no speculative legal or payment claims).
- No automatic outbound communication initially.

### Acceptance criteria

- For each edge-case state, generated copy is non-empty and does not contradict kernel status.
- No path can generate a customer message while order/receipt state is inconsistent.

---

## 5) LLM Catalog Intent QA (#9)

### Problem

Catalog copy/metadata drift often causes support tickets, poor search results, and poor
conversion; this is hard to police with rule-only checks.

### Proposed behavior

- Analyze product/copy against structured constraints:
  - price/variant consistency with product type data
  - shipping/stock policy conflicts
  - obvious mislabels (e.g., "in stock" vs zero stock policy text)
  - SEO and description quality signals for downstream search/embedding.
- Emit structured QA findings:
  - severity
  - exact field diffs
  - suggested minimal edits.

### Inputs

- `shortDescription`, product/variant copy, tags, attributes, and pricing snapshots.

### Non-functional constraints

- Must never mutate product data.
- Suggestion output is structured and versioned by model/call timestamp.
- Optional "apply suggestions" flow only with explicit review and version bump.

### Acceptance criteria

- In QA report, each finding maps back to a field-level anchor.
- Low false-positive threshold from a small validation set before rollout.
- No edits are committed without explicit approval.

---

## Suggested execution order

1. Finalization Incident Forensics Copilot
2. Webhook Semantic Drift Guardrail
3. Reconciliation Copilot
4. Customer Incident Communication Copilot
5. LLM Catalog Intent QA

That order keeps the first three on the same operational reliability spine, with the
customer/merchant enhancements following.

## Concrete ticket sequence (recommended)

### Legend

- Effort: `XS` = 0.5–1 day, `S` = 1–2 days, `M` = 3–5 days, `L` = 1 week+
- Owner: primary team responsible
- Dependencies: required completion before start

### Epic A — Finalization Incident forensics

- `AI-1`: Finalization Incident Forensics Copilot core (Owner: Platform/ops tooling; Effort: M)
  - Build advisory analyzer that summarizes claim/retry failures and maps to safe next action.
  - Inputs: `queryFinalizationStatus`, webhook receipt rows, payment/order rows.
  - DoD: deterministic incident output, command snippets included, replay-safe and side-effect free.
- `AI-1a`: Forensics schema + policy switches (Owner: Platform core; Effort: XS)
  - Add typed artifact schema + strict mode/env toggles.
- `AI-1b`: Forensics delivery endpoint/command (Owner: Platform/ops tooling; Effort: S)
  - Add structured API/command output for support dashboards.
  - DoD: same input always returns same output + redaction rules in place.
- `AI-1c`: Playbook mapping (Owner: Support enablement; Effort: S)
  - Attach existing runbook steps by root cause class.

### Epic B — Webhook semantic drift guardrail

- `AI-2`: Webhook Semantic Drift Guardrail (Owner: Platform security + finance ops; Effort: M)
  - Add advisory drift classifier (`ok` / `warn` / `suspect`) for event-to-state inconsistencies.
- `AI-2a`: Evidence extractor (Owner: Platform security; Effort: S)
  - Build deterministic extraction from raw webhook payload + receipt state.
- `AI-2b`: Rule set + scoring (Owner: Platform security; Effort: M)
  - Add conflict checks and suspicious-pattern scoring with tests.
- `AI-2c`: Policy routing (Owner: Finance ops; Effort: M)
  - Route to observe/warn/block with explicit audit records.

### Epic C — Reconciliation copilot

- `AI-3`: Paid-vs-stock reconciliation copilot (Owner: Ops + support; Effort: M)
  - Correlate inventory ledger/stock and finalize resume states to rank candidate repairs.
- `AI-3a`: Reconciliation classifier (Owner: Ops; Effort: M)
  - Detect at least five mismatch classes deterministically.
- `AI-3b`: Safe repair plan builder (Owner: Ops tooling; Effort: M)
  - Provide dry-run plan with invariants and rollback notes.
- `AI-3c`: Operator approval surface (Owner: Ops tooling; Effort: S)
  - Add explicit confirmation/actor tagging before any mutable action.

### Epic D — Customer incident communication

- `AI-4`: Customer Incident Communication Copilot (#8) (Owner: Growth + support tooling; Effort: S)
  - Generate state-safe incident messaging for merchant and customer channels.
- `AI-4a`: State-to-copy matrix (Owner: Support tooling; Effort: S)
  - Map each resume/error state to approved template language.
- `AI-4b`: Safety gating (Owner: Product + Growth; Effort: XS)
  - Enforce no autopush messaging and policy-safe language constraints.

### Epic E — Catalog/metadata quality QA

- `AI-5`: LLM Catalog Intent QA (#9) (Owner: Merchandising/content; Effort: M)
  - Build advisory QA findings for copy/type consistency and metadata contradictions.
- `AI-5a`: Rule pack + scoring (Owner: Merchandising/content; Effort: M)
  - Add structured finding schema with severity and field anchors.
- `AI-5b`: Suggestion review workflow (Owner: Content ops; Effort: M)
  - Add reviewed "apply suggestion" path with explicit confirmation.
- `AI-5c`: Quality gates (Owner: QA; Effort: S)
  - Add validation corpus and false-positive threshold before rollout.

### Suggested release order

1. `AI-1` + `AI-2` (observability and safety foundation)
2. `AI-3` (direct support-time operations value)
3. `AI-4` (support and merchant communication)
4. `AI-5` (quality pass, non-critical dependency-safe)

### Exit criteria for this roadmap band

- All advisory outputs are deterministic and idempotent for identical inputs.
- No ticket in this band directly mutates checkout/finalize core state.
- Any future write path requires explicit operator approval and evidence bundle.
- Rollout starts in observe mode; strict/auto paths enabled only after sign-off.

---

## PR-ready ticket stubs

Use this section to seed execution tickets directly.

- Ticket: `AI-1` — `feat(commerce): add finalize incident forensics analyzer`
  - **User story**: As a support engineer, I need an advisory incident analysis so replay/claim edge cases are recoverable faster.
  - **Scope**
    - Build deterministic analysis from finalize telemetry, receipt state, payment/order rows, and recent event history.
    - Return root cause class + safe next action (`retry`, `inspect`, `escalate`, `no-op`) + evidence references.
  - **Acceptance**
    - Deterministic output for identical input.
    - Includes `orderId`, `externalEventId`, `correlationId`, `recommendation`, `commandHint`.
    - No mutation in this ticket.
  - **Dependencies**: none

- Ticket: `AI-1a` — `feat(commerce): add forensics schema and policy switches`
  - **User story**: As platform owner, I need typed policy controls so analysis mode can be governed safely.
  - **Scope**
    - Add typed output schema + mode config (`observe`/`warn`/`manual`) and safe defaults.
    - Add config docs and validation.
  - **Acceptance**
    - Unknown mode defaults to safe behavior (`observe`).
    - Tests cover mode validation.
  - **Dependencies**: `AI-1`

- Ticket: `AI-1b` — `feat(commerce): expose finalize-forensics read endpoint`
  - **User story**: As an operator, I want a read surface for one-click incident analysis.
  - **Scope**
    - Add read-only endpoint/command returning one analysis artifact per order/event.
  - **Acceptance**
    - Deterministic output + redaction for sensitive fields.
    - Correct handling for missing receipts/events.
  - **Dependencies**: `AI-1a`

- Ticket: `AI-1c` — `feat(commerce): bind forensics to support playbooks`
  - **User story**: As support, I need direct linkage from analysis results to remediation steps.
  - **Scope**
    - Map analysis classes to playbook actions and escalate paths.
  - **Acceptance**
    - Every emitted class maps to either concrete playbook or explicit escalation.
  - **Dependencies**: `AI-1b`

- Ticket: `AI-2` — `feat(commerce): add webhook semantic drift guardrail`
  - **User story**: As finance/security, I need early alerting on suspicious event-to-state mismatch.
  - **Scope**
    - Add advisory drift classifier for webhook + state inconsistencies (`ok`/`warn`/`suspect`).
  - **Acceptance**
    - Known suspicious synthetic patterns deterministically classified.
    - No behavior change in `observe` mode.
  - **Dependencies**: `AI-1`

- Ticket: `AI-2a` — `feat(commerce): extract webhook drift evidence`
  - **User story**: As security reviewer, I need normalized drift evidence for reliable scoring.
  - **Scope**
    - Build typed evidence extractor from raw webhook payload, order state, and receipts.
  - **Acceptance**
    - Explicit evidence representation for malformed metadata, conflicting identifiers, replay anomalies.
  - **Dependencies**: `AI-2`

- Ticket: `AI-2b` — `feat(commerce): add drift scoring and rule matrix`
  - **User story**: As maintainer, I need consistent scoring for suspicious events.
  - **Scope**
    - Add rule-based scorer with confidence values and deterministic outputs.
  - **Acceptance**
    - `ok`/`warn`/`suspect` test matrix passes repeatably.
    - Score is replay-stable for identical input.
  - **Dependencies**: `AI-2a`

- Ticket: `AI-2c` — `feat(commerce): route drift signals by policy`
  - **User story**: As operations, I need policy-based action on suspicious signals.
  - **Scope**
    - Implement `observe`/`warn`/`block` policy switch with explicit audit records.
  - **Acceptance**
    - `observe`: no runtime mutation.
    - `warn`: advisory flag + log.
    - `block`: explicit hard-stop behavior only for configured suspicious classes.
  - **Dependencies**: `AI-2b`

- Ticket: `AI-3` — `feat(commerce): build paid-vs-stock reconciliation analyzer`
  - **User story**: As support, I need ranked reconciliation candidates for paid-but-wrong-stock incidents.
  - **Scope**
    - Correlate `inventoryLedger`, `inventoryStock`, receipt, and payment attempt state.
    - Produce ranked candidate mismatch classes.
  - **Acceptance**
    - Detect at least five deterministic mismatch classes.
    - Advisory output only for initial rollout.
  - **Dependencies**: `AI-1`, `AI-2`

- Ticket: `AI-3a` — `feat(commerce): add reconciliation class classifier`
  - **User story**: As operator, I need confidence-labeled mismatch reasons with standardized names.
  - **Scope**
    - Add deterministic classifier and evidence output for candidate classes.
  - **Acceptance**
    - Fixture coverage for successful/resumption/error-recovery paths.
  - **Dependencies**: `AI-3`

- Ticket: `AI-3b` — `feat(commerce): add dry-run repair plan builder`
  - **User story**: As operator, I want dry-run-safe repair plans before taking action.
  - **Scope**
    - Generate repair instructions with invariant checks and rollback notes.
  - **Acceptance**
    - Plans include preconditions + expected target state.
  - **Dependencies**: `AI-3a`

- Ticket: `AI-3c` — `feat(commerce): require explicit approval for reconciliation actions`
  - **User story**: As security owner, I need human approval for any stock/order write.
  - **Scope**
    - Add explicit confirmation gating and actor tagging for each write action.
  - **Acceptance**
    - No mutable action without confirmation.
  - **Dependencies**: `AI-3b`

- Ticket: `AI-4` — `feat(commerce): add customer incident communication copilot`
  - **User story**: As support, I want state-safe draft messaging to reduce manual support lag.
  - **Scope**
    - Add state-safe template output for internal + optional customer channels.
  - **Acceptance**
    - Coverage for delayed/recovering/escalation states.
    - No contradiction with kernel state.
  - **Dependencies**: `AI-1`

- Ticket: `AI-4a` — `feat(commerce): map finalize states to communication templates`
  - **User story**: As support enablement, I need explicit copy by state.
  - **Scope**
    - Build state->template matrix for `resumeState`, `receiptStatus`, error classes.
  - **Acceptance**
    - Complete matrix for all incident-facing states.
  - **Dependencies**: `AI-4`

- Ticket: `AI-4b` — `feat(commerce): add messaging safety gates`
  - **User story**: As compliance owner, I need strict limits on draft messaging.
  - **Scope**
    - Redaction, no-auto-send default, locale-safe placeholder strategy.
  - **Acceptance**
    - Customer-facing output requires explicit allowlisted mode.
  - **Dependencies**: `AI-4a`

- Ticket: `AI-5` — `feat(commerce): add catalog intent QA analyzer`
  - **User story**: As merchandiser, I want advisory catalog consistency findings.
  - **Scope**
    - Add advisory checks for copy/type/metadata alignment and stock/policy mismatches.
  - **Acceptance**
    - Findings include severity and field-level anchors.
    - No mutation in initial release.
  - **Dependencies**: `AI-1`

- Ticket: `AI-5a` — `feat(commerce): add catalog QA rule pack`
  - **User story**: As content lead, I need structured QA rules for reliable recommendations.
  - **Scope**
    - Add deterministic rule set with confidence and anchor mapping.
  - **Acceptance**
    - Rule suite returns stable outputs for same product snapshot.
  - **Dependencies**: `AI-5`

- Ticket: `AI-5b` — `feat(commerce): build reviewed suggestion application`
  - **User story**: As editor, I need explicit review for catalog recommendations before apply.
  - **Scope**
    - Add approval flow and version increment on apply.
  - **Acceptance**
    - No edits without explicit operator confirmation and audit trail.
  - **Dependencies**: `AI-5a`

- Ticket: `AI-5c` — `feat(commerce): add catalog QA false-positive control`
  - **User story**: As QA, I need noise controls before enabling this surface.
  - **Scope**
    - Add validation corpus and release threshold checks.
  - **Acceptance**
    - Rollout blocked automatically if false-positive threshold is exceeded.
  - **Dependencies**: `AI-5b`

## Dependencies and readiness gates

- Feature-safe foundation: `queryFinalizationStatus` and finalize resume-state telemetry
  remain authoritative.
- Delivery sequence should include:
  - structured output schemas
  - audit logs
  - dry-run evidence bundles
  - operator approval and rollback behavior.

No core checkout/finalize semantics should be changed for any of these 5 features.
