# Sequence 1 — Step 4 implementation

## Boundary and verified starting point

Step 4 makes the existing coverage epoch authoritative for incremental completion and the existing synchronous repair. It does not activate collections, add reconciliation paging, change public repair responses, add operator APIs, or implement Sequence 2.

- Capture triggers already advance `change_epoch`, coalesce one work row per entry, and change trusted `complete` coverage to `stale` in the same content statement.
- The worker conditionally claims and acknowledges an exact version/lease, but acknowledgement currently does not restore truthful coverage or record terminal failure.
- Repair currently scans by slug, writes legacy slug-keyed sources, overwrites repair status without an epoch fence, and leaves durable work untouched.
- Schema expansion leaves global activation at `expanded`. Released V1 repair behaviour must remain unchanged until activation is `active`.

## Smallest coherent implementation

### Incremental completion

After an exact work acknowledgement succeeds, read the current ID-bound status epoch, then conditionally update that same row. Record database-time `last_incremental_success_at`; restore `complete`, clear the error and set `completed_at` only when the observed epoch still matches, `reconciliation_required = 0`, no work row of any state remains for the collection, the current registry identity still matches, and the status is a previously trusted `complete`/`stale`/`partial` state. A concurrent trigger either advances the epoch before this update or runs afterward and makes coverage stale again.

Retry retains the trigger-established non-complete state. After an exact terminal-failure transition succeeds, conditionally record its stable error on the current ID-bound status. A row with `reconciliation_required = 0` becomes `partial`. An untrusted `running` row becomes `stale`; any other untrusted non-complete state is preserved. The update must still prove that the exact failed work version exists so a newer mutation cannot publish an obsolete failure.

Obsolete, claim-lost and superseded work never changes current collection coverage. A database failure after acknowledgement can leave coverage conservatively non-complete, but cannot create false completeness or resurrect work.

### Activation-aware manual repair

Repair resolves the current collection ID once. While global activation is not `active`, it preserves the released slug-keyed path and status contract exactly. While activation is `active`, it uses an epoch-fenced canonical path:

1. Atomically change the exact current ID-bound status row to `running`, set `reconciliation_required = true`, retain existing work, and return its starting `change_epoch` with the repair token. This keeps a crashed non-resumable repair from later being mistaken for an incrementally recoverable baseline. Missing or mismatched active lifecycle state fails safely as the existing structured repair error rather than creating a slug-only status row.
2. Scan the existing collection synchronously as today, but bind content-ID scans, field discovery, snapshots, source selection and source mutation to that exact collection ID. Build, load, write and delete only canonical source keys carrying the ID and identity version. Unbound legacy sources are neither selected nor mutated.
3. Keep the existing guarded source conflict rules and final content-ID scan. Every canonical projection statement retains the repository's current-registry identity guard.
4. If the scan is complete, delete only this collection ID's work with `change_epoch <= starting_epoch`, then conditionally finalize `complete` only when the repair token, collection ID and epoch still match, the registry identity is current, and no work remains. Clear `reconciliation_required` only in this transition.
5. Partial or failed scans retain all work and set `reconciliation_required = true`; otherwise a later unrelated incremental success could falsely restore complete coverage. Their status update still matches the repair token, collection ID and starting epoch.
6. If the epoch changed while the same run token still owns `running`, demote that run to conservative `stale`/conflict state and require reconciliation. Never overwrite a newer repair or another winning status transition.

The D1-safe ordering is intentional: clearing proven pre-run work before the final conditional status update means a crash can leave non-complete coverage, not false `complete`. SQLite and PostgreSQL `UPDATE ... RETURNING` provide the epoch from the row modified by repair start; SQLite cannot portably compose DML `RETURNING` as a subquery, so the remaining operations stay as separately guarded statements.

All-collection repair carries each initially listed collection ID into the per-collection call. If that identity disappears or its slug is recreated, it is excluded without repairing the replacement and without deleting or updating the replacement's status. Legacy pre-activation filtering keeps its released slug-based behaviour.

## Concurrency, compatibility and cost invariants

- A mutation before repair finalization advances the epoch and creates newer work atomically; the repair cannot delete that work or finalize complete.
- A mutation after successful finalization immediately changes coverage back to non-complete and creates work.
- Multiple workers may finish out of epoch order; coverage completes only after the final work row drains at a still-observed epoch.
- A terminal row, including a failed row for another entry, is incompatible with complete coverage.
- Repair may delete a pre-run leased row after proving the full current collection. Its stale owner cannot acknowledge because the exact row is gone, and guarded source generations prevent it from overwriting a repair winner.
- Collection deletion or same-slug replacement makes ID/registry predicates lose; repair and incremental bookkeeping cannot update the replacement.
- Existing REST, client, CLI and MCP request/response shapes, authorization, synchronous execution and pre-activation source keys do not change.
- No logged-out query changes. Incremental success adds one bounded epoch read and one conditional status update after an acknowledged job; terminal failure adds one conditional update. The ordinary-job statement-count test must remain within the exported Step 3 ceiling. Repair remains the explicitly unbounded operator operation until Sequence 2.

## Behavioural tests

- A trusted collection becomes stale with captured work and returns to complete only after all jobs drain; `last_incremental_success_at` is recorded.
- `never`/reconciliation-required coverage cannot become complete from incremental success.
- Retry remains non-complete; an exact terminal failure becomes visible and cannot be overwritten after a newer mutation.
- Superseded, obsolete and out-of-order completions cannot report complete early.
- Active repair writes canonical ID-bound projections, preserves unbound legacy evidence, clears only pre-run work, and clears reconciliation only on proven completion.
- A write during active repair advances the epoch, retains the newer job, prevents complete finalization and does not leave a falsely running repair.
- Partial/failed active repair retains work and reconciliation-required state.
- Same-slug recreation cannot receive the old repair's sources or status.
- Active all-collection repair skips an identity replaced after listing and leaves the replacement untouched.
- The existing pre-activation repair suite continues to prove backwards-compatible legacy behaviour.

SQLite runs for every test; the existing real-PostgreSQL dialect wrapper runs when configured. Real D1/workerd execution remains a final Sequence 1 acceptance risk rather than being claimed by Step 4.

## Remaining risks

- A crash after successful work deletion but before coverage bookkeeping leaves safe stale/partial coverage until a later job or full repair; there is no false-complete window.
- Manual repair remains whole-collection, synchronous and non-resumable by approved scope. Step 4 adds fences, not scalability claims.
- Hosts without a real PostgreSQL test database or D1/workerd cannot close those platform evidence gaps in this step.
