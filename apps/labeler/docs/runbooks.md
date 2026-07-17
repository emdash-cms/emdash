# Labeler incident runbooks

This is the incident-response companion to [operating.md](operating.md). Where operating.md documents how a reviewer or admin _uses_ the console day to day, this document covers what to do when something is _wrong_: how you know, how to diagnose it, what the system heals on its own, and what you do when it doesn't.

Every procedure here is grounded in the code that implements it, and names the mechanism (a function, a table, a cron pass) so you can find it. For the label vocabulary the actions manipulate, see [moderation-model.md](moderation-model.md); for identity, signing, and the ATProto surface, see [atproto.md](atproto.md).

The console actions an operator takes during many of these incidents — override, takedown, pause/resume, dead-letter retry/quarantine, reconsideration — are documented step-by-step in [operating.md](operating.md). This document cross-references those rather than repeating the ceremony, and focuses on the incident: what is happening underneath, and when to reach for which control.

## The shared substrate

A handful of mechanisms recur across every runbook. Read this once.

**D1 is the source of truth.** Every durable fact lives in D1: assessment runs (`assessments`), the append-only label log (`issued_labels`, monotonic `sequence`), the discovery forensics store (`dead_letters`), the Jetstream cursor (`ingest_state`), the signing state machine (`signing_state`, `signing_key_versions`, `signing_events`), and the audit logs (`operator_actions`, `issuance_actions`, `operational_events`). The two Durable Objects and the label subscription hold no authoritative state — they are transports over D1. This is why most recovery is "let it re-drive from D1," not "restore a component."

**The 5-minute cron is the heartbeat.** `scheduled()` in `index.ts` (`crons: ["*/5 * * * *"]`) runs four independent, self-isolating passes every five minutes:

1. A liveness `fetch` to the discovery Durable Object (`LabelerDiscoveryDO`), so an evicted ingestor is re-instantiated.
2. `reconcileAssessments` (`reconciliation.ts`) — surfaces stuck runs and orphaned subjects as structured logs.
3. `runNotificationSweep` (`notification-sweep.ts`) — re-drives failed/stuck publisher notices.
4. `runProlongedErrorEscalation` (`prolonged-error.ts`) — the 24h/72h escalation ladder for terminal `error` runs.

Each pass is wrapped in its own `ctx.waitUntil` with its own try/catch, so one failing pass never disturbs the others.

**Structured logs are the signal.** Until the W11.3 alerting layer lands, the operational signal is the `console.error`/`console.warn` lines the code emits, all prefixed `[labeler]`. Each runbook below names the exact line to watch for. Wire these into your log-based alerts.

**The system fails closed.** The automation kill-switch and the signing layer both refuse to act when their state is unreadable or paused, rather than acting blind. A "stuck, doing nothing" labeler is the designed failure mode; a labeler issuing labels it shouldn't is not.

---

# Operational runbooks

## Jetstream outage / cursor loss

**What it is.** The labeler discovers releases by holding a long-lived outbound WebSocket to Jetstream inside `LabelerDiscoveryDO`. `JetstreamIngestor` (`jetstream-ingestor.ts`) runs the connect → consume → enqueue → persist-cursor loop. An outage is Jetstream being unreachable; cursor loss is the `ingest_state` row being missing or wrong.

**Signal.** `consecutiveFailures` climbs above zero on the DO's status surface (`LabelerDiscoveryDO.fetch` returns `{ cursor, consecutiveFailures }`); the log line `jetstream subscription failed` appears with a rising `consecutiveFailures`. A flatlining `cursor` with no new assessments being created is the downstream symptom.

**Diagnose.** Inspect the cursor directly: `SELECT * FROM ingest_state WHERE source = 'jetstream'`. The cursor is a Jetstream `time_us` (microseconds since epoch). Compare it to now — a cursor hours behind means the ingestor is replaying a backlog, not stalled. Hit the DO liveness endpoint to read `consecutiveFailures`: a non-zero value means the most recent connection attempt produced no events (Jetstream unreachable, or a `wantedCollections` mismatch).

**Automatic behavior.** The ingestor never gives up. Connection drops, parse errors, and `queue.send` rejections all increment a backoff counter and retry, with exponential backoff (1s → 60s cap, ±20% jitter). Any successful event resets the counter, so a flapping connection doesn't spiral. The cursor is persisted only _after_ each successful enqueue, so a crash replays at most the latest event; the discovery consumer's `runKey` dedup absorbs the duplicate. The 5-minute cron's liveness ping re-instantiates the DO if workerd evicted it mid-backoff during a long outage. When Jetstream recovers, the ingestor reconnects from the persisted cursor and drains the gap on its own — **no operator action is needed for a plain outage.**

**Operator action.**

- **Prolonged outage, no self-recovery:** confirm Jetstream itself is up (`JETSTREAM_URL` in `wrangler.jsonc` points at `jetstream2.us-east.bsky.network`). Cloudflare offers no direct "restart this DO" button; the liveness ping is the re-instantiation path, and it runs every five minutes.
- **Cursor lost / wiped (fresh deploy, region failover, dev-state reset):** the ingestor treats an empty cursor as "start from now" — production wiring supplies no `cursorFloor`, so **the labeler does not backfill the gap between the last cursor and reconnect.** Releases published during the gap will not be discovered from the stream. Catching them up is a reconciliation concern (see [Workflow stuck runs](#workflow-stuck-runs) for the orphaned-subject signal), not something discovery does automatically. This is a known limitation, not a bug.
- **Cursor stuck in the future (`FutureCursor`-style):** if `ingest_state.cursor` is ahead of Jetstream's live position (e.g. after a restore from a newer backup), the subscription will find nothing to deliver. Correct the row to a sane `time_us` and let the loop reconnect.

> Flag: there is no console control for the Jetstream ingestor. Inspection is via D1 (`ingest_state`) and the DO liveness endpoint; recovery is the cron's re-instantiation. A "seed cursor from a floor" recovery would need the unbuilt `cursorFloor` production wiring.

## Queue / DLQ recovery

**What it is.** Discovery events flow DO → `emdash-labeler-discovery` queue → `processDiscoveryBatch` (`discovery-consumer.ts`). A job that can't be processed lands in the `dead_letters` D1 table, which the console reads. Two distinct paths populate it, and it's worth knowing which:

- **Permanent verification failure** (bad signature, MST proof, CID mismatch, a still-resolving "delete"): the consumer writes a `dead_letters` row _directly_ and acks. It never retries — a forged or unverifiable event produces no public label, ever (spec §9.1).
- **Retry exhaustion:** a transient PDS failure calls `retry()`. After `max_retries: 5` (wrangler.jsonc), Cloudflare routes the message to `emdash-labeler-discovery-dlq`, whose drain consumer (`drainDiscoveryDeadLetterBatch`) writes a `dead_letters` row (reason `UNEXPECTED_ERROR`, detail `drained from DLQ`) and acks, so the Cloudflare DLQ never grows unbounded.

Either way, the operator-visible artifact is a `dead_letters` row with `status = 'new'`.

**Signal.** A growing `dead_letters` list in the console. In logs: `unexpected discovery consumer error`, `discovery DLQ drain: acking job`, or `discovery processMessage threw unexpectedly`. The `reason` column classifies each: `INVALID_PROOF`, `RECORD_NOT_FOUND`, `DELETE_RECORD_PRESENT`, `PDS_HTTP_ERROR`, etc.

**Diagnose.** Read the row's `reason` and `detail`. A cluster of the same `reason` points at a systemic cause: many `PDS_HTTP_ERROR` suggests a specific PDS is down (those should have retried, so seeing them dead-lettered means the outage outlasted the retry budget); many `INVALID_PROOF` at once could indicate a malformed upstream or an attack. The full original `DiscoveryJob` (identity + operation + cid + the unverified Jetstream record) is preserved in `dead_letters.payload` so a retry can re-enqueue an identical job.

**Automatic behavior.** None beyond the retry budget above. A dead letter is terminal until an operator acts — by design, so a genuinely-forged event stays parked rather than silently retrying forever.

**Operator action.** Both actions are admin-only and documented in [operating.md § Dead-letter queue](operating.md#dead-letter-queue-admin):

- **Retry** (`POST /admin/api/dead-letters/:id/retry`) re-enqueues the stored job. Use this when the underlying cause was transient and is now resolved (the PDS is back). The consumer re-fetches and re-verifies `(uri, cid)` from the PDS; its `runKey` dedup absorbs a duplicate re-drive, so a retry is safe even if the original eventually succeeded.
- **Quarantine** (`POST /admin/api/dead-letters/:id/quarantine`) is the terminal "will not retry." Use this for a confirmed forgery or a permanently-gone record.

Both reject an already-resolved letter with `409` (the `status = 'new'` guard on `buildDeadLetterResolveUpdate`), so two operators can't double-resolve the same letter.

## Workflow stuck runs

**What it is.** Each discovered subject becomes an assessment run driven by one `AssessmentWorkflow` instance (`assessment-workflow.ts`), whose id is the run's `runKey`. The whole run — acquire, code AI, image AI, history, and atomic finalization — executes inside a single durable `step.do` (`assess-subject`) with `retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }`. A "stuck run" is a row that has sat in a non-terminal state (`verifying`, `pending`, `running`) past a staleness threshold — the driver crashed, the dispatch never landed, or the run has been failing its durable-step retries.

**Signal.** The reconciliation cron logs one line per stuck run: `[labeler] reconciliation: assessment run stuck` with the run's `{ id, uri, cid, state, createdAt }`. The threshold is one hour (`DEFAULT_STALE_THRESHOLD_MS`). A related line, `verified subject has no assessment run`, flags a subject that was verified but whose run-creation left no trace (see below).

**Diagnose.** Look up the run: `SELECT id, state, created_at, updated_at FROM assessments WHERE id = ?`. The `state` tells you where it stalled:

- `verifying` / `pending`: discovery created the row but the Workflow dispatch or the pending→running transition never completed.
- `running`: a Workflow attempt crashed after the pending→running CAS but before finalizing. `runAssessment` is written to _resume_ a `running` row on the next attempt, so a genuinely-stuck `running` row means the durable step has exhausted its retries or the instance is gone.

**Automatic behavior — and its limit.** The Workflow itself is resilient: a mid-run eviction re-runs the whole step, and `executeAssessmentInstance` makes that idempotent (a terminal row short-circuits; a crash-left `running` row resumes). But **reconciliation only _logs_ stuck runs — it does not re-drive them.** `reconcileAssessments` surfaces the gap and returns; there is no automatic re-dispatch. This is a deliberate scope boundary (plan W6.8): detection is built, repair is manual. Treat the log line as a to-do, not a self-healing event.

**Operator action.**

- **A stuck `verifying`/`pending`/`running` run:** **Re-run** (`POST /admin/api/assessments/:id/rerun`, see [operating.md § Re-running an assessment](operating.md#re-running-an-assessment)) mints a fresh run and re-issues `assessment-pending`, but the current implementation stops at `pending` — its deferred tail (`deferRerunTail`) advances the row to `pending` and publishes the label, and does **not** dispatch the Cloudflare Workflow instance that would drive it to finalization (only the discovery path calls `dispatchAssessmentWorkflow`). So a re-run today gates the release with a new `assessment-pending` and leaves it stuck rather than recovering it. Until the rerun Workflow-dispatch follow-on is wired, the practical recovery for a stuck run is a fresh discovery event for the subject (which re-dispatches on the discovery path) — retry the corresponding `dead_letters` row if one exists, or wait for the publisher's next release update.
- **An orphaned subject** (`verified subject has no assessment run`): there is no console "create run for this subject" action. The practical recovery is to re-drive discovery for that subject — if a corresponding `dead_letters` row exists, retry it; otherwise the subject will be re-assessed when the publisher next updates the release.

> Flag: reconciliation's stuck-run handling is detection-only — it logs stuck runs and orphaned subjects, it does not re-drive them. Combined with the rerun-dispatch gap above, a run stuck in `pending`/`running` has no automatic OR manual re-drive today; its only recovery is a fresh discovery event. Wiring `dispatchAssessmentWorkflow` into the rerun tail (and/or a reconciliation re-dispatch pass) is the follow-on that closes this.

## AI outage

**What it is.** The code and image stages call Workers AI (`env.AI`) through `code-ai-adapter.ts` / `image-ai-adapter.ts`. When a model call fails transiently — the binding is unavailable, the model times out, or it returns unparseable output — the adapter throws `ModelTransientError`. An "AI outage" is this happening broadly.

**Signal.** A spike in runs finalizing `error` and issuing `assessment-error`, followed (after 24h) by the prolonged-error escalation (see below). In the Workflow logs, the `assess-subject` step retrying and eventually failing.

**Diagnose.** Confirm it's the model and not the input: `MAX_MODEL_INPUT_CHARS` (200,000) overflow is thrown as a _non_-transient error (it won't fix on retry) and aborts the run rather than looping — so a broad transient spike is the binding or the model, not oversized bundles. Check Workers AI health for the account.

**Automatic behavior.** The retry ladder is layered and self-healing for a brief blip:

1. `ModelTransientError` in an adapter becomes a `StageTransientError` (`assessment-stages.ts`).
2. The orchestrator retries the stage `maxStageRetries` times, then, if still failing, marks the run transient-exhausted (`assessment-orchestrator.ts`).
3. On transient exhaustion the orchestrator finalizes the run — but never as a false pass. It resolves the findings gathered _so far_: **if a prior stage already produced a blocking finding, it finalizes `blocked`** (a block is monotonic; no unrun stage can lift it). Anything short of an already-confirmed block finalizes `error` and issues `assessment-error` — an incomplete run never concludes `passed` or `warned`.
4. Above that, the Workflow's own `step.do` retries the whole step 3 times with exponential backoff before the run rests in `error`.

So a short outage is absorbed by the retries and the run completes once the model recovers. A sustained outage leaves runs in `error`, gated (the release keeps its `assessment-pending`/`assessment-error` labels), which is the safe state — the labeler failing to assess never silently clears a subject.

**Recovery.** When the model is healthy again, **re-run the affected assessments** (`POST /admin/api/assessments/:id/rerun`). There is no automatic re-drive of `error` runs; the prolonged-error ladder (below) escalates them for attention but does not retry them. For a large backlog, re-run the runs surfaced by the prolonged-error operator alerts first.

## Artifact acquisition / mirror-fallback outage

**What it is.** The acquire stage (`artifact-acquisition.ts`) resolves a verified release to its signed artifact, fetches it under the SSRF-hardened `fetchVerifiedResource`, verifies the bytes against the signed checksum, and unpacks the bundle. The target is resolved from the aggregator (`release-resolution.ts`) — the declared artifact URL is _not_ stored labeler-side, only the pinned `artifact_id`/`artifact_checksum`; `release-resolution` reads the signed release over the `AGGREGATOR` service binding. A "broad acquisition failure" is many runs unable to fetch or resolve.

**The mirror seam.** The source preference is `["mirror", "declared-url"]`, but **v1 ships no mirror binding** — `deps.mirror` is absent, so the mirror source always misses and every acquisition falls through to the publisher's declared URL. There is no mirror to fall back _from_ today; "mirror-fallback" is a seam that activates when a mirror binding is injected, not a live redundancy.

**Signal.** A spike of `error` runs (like an AI outage), driven by acquire-stage `StageTransientError`. The `privateDetail` on any resulting deterministic finding records the acquisition classification, e.g. `Acquisition failed (transient/FETCH_FAILED) from declared-url: ...`.

**Diagnose — the classification is the key.** Acquisition sorts every failure into four categories, and the category determines whether it's a transient error or a public block:

| Category | Cause | Disposition |
| --- | --- | --- |
| `mirror-miss` | No mirror object (always, in v1) | Retry → falls through to declared URL |
| `transient` | Network/timeout/5xx, size cap tripped mid-fetch, malformed _declared_ checksum | Retry → `assessment-error`. **Never a public block** — a transport failure is not evidence the plugin is bad (spec §9.4) |
| `permanent-mismatch` | `CHECKSUM_MISMATCH` on fetched bytes, or pinned-vs-declared `COORDINATE_MISMATCH` | Permanent blocking `artifact-integrity-failure` finding |
| `policy-rejection` | A checksum-verified bundle that is structurally invalid, or a non-UTF-8 code file | Permanent blocking `invalid-bundle` finding, or (for URL-safety refusals) retry |

Also transient: **a release the aggregator hasn't indexed yet.** `release-resolution` throws `StageTransientError` for an absent release — that's aggregator lag, not a deletion (reconciliation owns true deletions). A broad "not indexed by the aggregator yet" spike points at the aggregator lagging or down, not the publishers' origins.

**Automatic behavior.** Transient acquisition failures ride the same stage-retry → Workflow-retry ladder as an AI outage. A permanent integrity/bundle failure is a real block — it finalizes correctly and is not an outage to recover from. So "acquisition is failing broadly" almost always means a wave of `transient`/aggregator-lag failures, which self-heal when the cause clears.

**Operator action.**

- **A specific origin is down** (publisher's declared URL unreachable): nothing to do centrally — those runs sit in `error` and self-heal when the origin returns; re-run to confirm.
- **The aggregator is lagging/down** (mass "not indexed yet"): this is an aggregator incident. The labeler's runs correctly hold in `error`; recover the aggregator, then re-run the backlog.
- **A cluster of `permanent-mismatch`/`policy-rejection`** is _not_ an outage — those are genuine integrity blocks. Only treat it as an incident if you suspect a false classification (e.g. a labeler-side bug), in which case use **override** (see [operating.md § False-positive override](operating.md#false-positive-override)) on the specific release, not a blanket action.

## Subscriber lag

**What it is.** The labeler publishes its append-only label stream over `com.atproto.label.subscribeLabels`, served by `LabelSubscriptionDO` (`subscribe-labels.ts`). A downstream consumer (an aggregator) connects with a WebSocket and an optional `?cursor=N` to replay from sequence `N`, then follows live. "Subscriber lag" is a consumer that has fallen behind the live sequence.

**The labeler's role is producer-side.** The lagging component is the _subscriber's_ own infrastructure; the labeler cannot push a third party to catch up. What the labeler guarantees is that the stream is always replayable from D1 by cursor, and that a slow subscriber is shed cleanly rather than allowed to build unbounded buffer.

**Signal.** From the labeler side: sockets being closed with code `1013` (`subscriber must reconnect with a cursor`) — the backpressure cutoff. The DO returns `503 "label subscriptions are busy"` when its high- or low-priority queue hits 100 items. A downstream aggregator's own "labels behind" metric is the more direct signal, but that lives on the consumer.

**Diagnose.** The label log is `issued_labels`, ordered by monotonic `sequence`; `SELECT MAX(sequence) FROM issued_labels` is the live head. A subscriber's lag is head minus its last-acked cursor. A subscriber that connects with a cursor _ahead_ of the head gets a `FutureCursor` error and is closed — that means the subscriber's persisted cursor is corrupt or from a different (e.g. restored) stream.

**Automatic behavior.** The DO is built to keep a slow subscriber from harming others: each connection has a 1 MB buffered-bytes ceiling (`MAX_CONNECTION_BYTES`); a subscriber that can't keep up is closed with `1013` rather than buffering forever. Replay and live delivery are paged (`REPLAY_PAGE_SIZE = 100`) and round-robined across pending sockets so one catching-up subscriber doesn't starve the rest. D1 remains the durable log, so a reconnect always resumes exactly where the cursor left off — nothing is dropped.

**Operator action.** Recovery is the subscriber reconnecting with its last good cursor; the labeler serves the replay from `issued_labels`. There is no labeler-side control to "speed up" a subscriber. If a subscriber is stuck on `FutureCursor`, it must reset its cursor to a valid sequence (≤ the labeler's head). For a subscriber that repeatedly hits the `1013` cutoff, the fix is on the consumer (larger read throughput / smaller processing per event); the labeler is behaving correctly by shedding it. See also [Full aggregator replay](#full-aggregator-replay) for a from-scratch rebuild.

## Publisher reconsideration

**What it is.** A blocked or warned publisher can contest a decision. Every public assessment view carries a `reconsiderationUrl` (from the moderation policy's `contact.reconsiderationUrl`, currently `https://emdashcms.com/plugin-moderation/reconsideration`) and the assessment's opaque id — the same id the public assessment API returns, which reveals no private finding detail. A reviewer then manages the case in the console (plan W10.6): open → note → resolve.

**Signal.** This is not an outage — it's an operational workflow triggered by a publisher contact arriving through the reconsideration intake. Treat a spike in reconsiderations for one policy area as a signal your automation may be mis-calibrated for that class of plugin.

**Diagnose.** Open the referenced assessment in the console to see its findings, the operator-only `privateDetail`, and the live labels. The public state the publisher sees is derived by `public-assessment.ts`; compare it against the private findings to judge the contest.

**Operator action.** The three console mutations (admin/reviewer per the policy grants):

- **Open** (`POST /admin/api/reconsiderations/open`) — creates one case for the subject, with a private opening note. A second open for a subject that already has an open case is a `409` (`RECONSIDERATION_OPEN_EXISTS`).
- **Note** (`POST /admin/api/reconsiderations/:id/note`) — appends a private note (max 10,000 chars).
- **Resolve** (`POST /admin/api/reconsiderations/:id/resolve`) — sets the outcome (`granted` | `denied` | `withdrawn`) and closes the case. Resolving an already-resolved case is a `409` (`RECONSIDERATION_RESOLVED`).

If the outcome is that the block was wrong, the corrective action is a separate control: **override** the false positive (see [operating.md § False-positive override](operating.md#false-positive-override)), which permanently suppresses the automated block. Resolving the reconsideration records the decision; it does not itself move labels.

> Flag: the reconsideration _intake_ (the `reconsiderationUrl` form/inbox at `emdashcms.com`) is maintainer-owned and lives outside this Worker. The code owns case management and the public assessment view; how a publisher's submission reaches an operator (the monitored inbox behind that URL) is an operator-owned procedure.

## Emergency takedown / retraction

**What it is.** The admin-only emergency actions are the hard, out-of-band controls for abuse that can't wait for assessment: a `!takedown` redaction on a release, package, or publisher, and a `publisher-compromised` marking. Their console ceremony is in [operating.md § Emergency actions](operating.md#emergency-actions-admin). This runbook covers the _incident_ decision: when to reach for them and what they do to enforcement.

**When to use — takedown.** A takedown is a single URI-wide (or DID-wide) `!takedown` label the evaluator honors for everything beneath it — it is not fanned out into per-release labels. Reach for it when content is actively harmful and must be suppressed immediately and completely, above and beyond what a per-finding block expresses. A package- or publisher-level takedown suppresses the whole subtree in one label.

**When to use — publisher-compromised.** Use `publisher-compromised` when a publisher's signing identity or account is believed compromised, so their releases should not be trusted pending investigation — distinct from a content-quality block on a single release.

**What retraction restores.** Retraction is not a fresh computation — it restores the state that existed _before_ the emergency label. Retracting a takedown (`CONFIRM RETRACT`) pulls the single takedown label; the automated blocks that were live underneath **re-expose**, because they were never negated and nothing is re-issued (the takedown sat _above_ them). If there is no active label to pull, the retract returns `404 NO_ACTIVE_LABEL`. Contrast this with a false-positive override-retract, which does _not_ restore the original blocks (see [operating.md § False-positive override](operating.md#false-positive-override)) — know which you're undoing.

**Diagnose before acting.** Confirm the subject identifier (record `rkey` for a release/package, the DID's final `:`-segment for a publisher) and that you are acting on the right subject — the two-field ceremony (identifier + exact intent phrase) exists precisely to prevent a misfire. Check the subject's current labels first so you know what a later retract will restore.

**Audit.** Every emergency action writes an `operator_actions` row (who, reason, idempotency key) and raises an `operational_events` row (`emergency-takedown` / `publisher-compromised`, severity `critical`) for the alert pipeline. See [Audit evidence & incident communications](#audit-evidence--incident-communications).

## Full aggregator replay

**What it is.** A downstream aggregator rebuilding its view of this labeler's decisions from scratch — after data loss, a trust reset, or onboarding a new consumer.

**How it works.** The label log is append-only and totally ordered by `sequence`. Negations are themselves labels (`neg: true`), so the full history — every issue and every retraction — is expressed as a forward sequence with no in-place mutation. A consumer replays the whole stream by connecting to `subscribeLabels` with `cursor=0` (or its last known good sequence) and reading forward; `LabelSubscriptionDO` pages the replay out of `issued_labels` (`REPLAY_PAGE_SIZE = 100`) and transitions the socket to live delivery once it catches the head. `queryLabels` (the pull XRPC) is the paged alternative for a bulk backfill by URI pattern.

**Re-signing during replay — the two paths differ.** Only `queryLabels` re-signs on the fly. `queryLabels` (the pull XRPC) lazily re-signs any returned label whose `signing_key_version` differs from the active version (`resignStaleLabels`), preserving the original `cts` and keeping the prior signature in `label_signature_history` — so a `queryLabels` backfill after a key rotation verifies cleanly against the current DID document. `subscribeLabels` does **not**: `LabelSubscriptionDO.labelsAfter()` reads `issued_labels` rows verbatim and sends them as-signed, so a WebSocket replay from `cursor=0` after a rotation still serves labels under the _retired_ key until a proactive `queryLabels` sweep has re-signed them. If a `subscribeLabels` replay must verify against only the current key, drive a full `queryLabels` sweep first. (See [Historical re-signing](#historical-re-signing).)

**Operator action.** None on the labeler beyond ensuring it's healthy — replay is a consumer-initiated read. For a replay that must verify under the current key after a rotation, have the consumer refresh its DID resolution and pull the backfill via `queryLabels` (or run a full `queryLabels` sweep before pointing it at `subscribeLabels`). If the labeler's own D1 label log has been lost, replay cannot reconstruct it (there is no separate backup restore today — see the note under [Key lifecycle & custody](#key-lifecycle--custody)); the append-only log in D1 _is_ the system of record.

---

# Key-management runbooks

These are security-critical. The signing key is the labeler's authority — anyone holding it can forge decisions under the labeler's DID. Read carefully and do not improvise ordering.

## Key lifecycle & custody

**What the key is.** The labeler signs labels with a P-256 key. Its identity is `did:web:labels.emdashcms.com` (host-level `did:web`), and the labeler _serves its own DID document_ (`identity.ts`, `serviceDidDocument`) exposing a single `#atproto_label` verification method whose `publicKeyMultibase` is the configured public key.

**Where it lives (config vs. secret).**

| Piece | Where | Consumed by |
| --- | --- | --- |
| `LABEL_SIGNING_KEY_VERSION` | `wrangler.jsonc` var (e.g. `v1`) | Config; stamped on issued labels; gates issuance against the DB active version |
| `LABEL_SIGNING_PUBLIC_KEY` | `wrangler.jsonc` var (P-256 Multikey) | The served DID document; validated canonical |
| `LABEL_SIGNING_PRIVATE_KEY` | **Secret** (Secrets Store), read via `getRuntimeSigningSecret` | Builds the runtime signer (`signing-runtime.ts`) |

The runtime signer is built from the config public key + version and the secret private key. The DB (`signing_state`) is the _authoritative gate_: `buildIssuanceStatements` refuses to issue if the config's key version doesn't match the DB's active key version, or if the phase is `paused`.

**Offline custody.** The production signing scalar's offline copy lives in the maintainer's Keeper vault. The custody procedure — who can open the vault, dual-control, where the recovery material sits — is maintainer-owned; this runbook records that the offline authority exists and that any rotation or compromise response must be able to reach it, but it does not (and must not) restate the vault access details.

> Flag: **there is no backup/restore or retention tooling yet** (plan W11.5 is unbuilt). The D1 label log, signing state, and audit tables are the system of record with no automated export/restore path. Any runbook step that says "restore from backup" is a prerequisite on W11.5, not a procedure you can run today. Treat D1 durability and the offline key copy as the only recovery anchors.

## Routine rotation

**Goal.** Move signing from the current key to a new one with no forged-label window and no break in downstream verification. The mechanism is the `signing_state` / `signing_key_versions` state machine in `signing-rotation.ts`, combined with a config/secret deploy of the new key.

**The invariant that makes it safe.** Issuance is gated on the DB active key version matching config, and it stops entirely while the phase is `paused`. Historical labels are re-signed to the active key lazily on query, so the served DID document only ever needs to expose _one_ key — the active one. Rotation therefore does not rely on the DID document carrying two keys at once; it relies on pausing issuance during the swap and re-signing history afterward.

**Procedure (ordering matters).**

1. **Begin (pause).** `beginRoutineKeyRotation(db, { rotationId, expectedActiveKeyVersion, nextKeyVersion, nextPublicKeyMultibase })` sets the phase to `paused` and records the pending key. From this point, all issuance throws `LabelIssuanceUnavailableError` — the discovery consumer _retries_ rather than dead-letters, so no in-flight label is lost; it's re-driven after resume. Manual and automated issuance are both held.
2. **Deploy the new key.** Set `LABEL_SIGNING_PUBLIC_KEY` and `LABEL_SIGNING_KEY_VERSION` to the new key (vars) and update the `LABEL_SIGNING_PRIVATE_KEY` secret, then redeploy. Now the runtime signer signs with the new key and the served DID document advertises the new public key.
3. **Activate.** `activateRoutineKeyRotation(db, { signer, keyVersion, publicKeyMultibase, rotationId })` verifies the deployed runtime signer actually produces a valid signature under the pending public key (it signs a throwaway `rotation-check` label and verifies it), then atomically retires the old key version, activates the new one, and returns the phase to `active`. **Activation is blocked while any label is still `publication_pending = 1` under the old key version** — un-notified labels must drain to subscribers first, so no in-flight publication is stranded under a retired key. Because activation _requires_ the deployed signer to hold the new key, step 3 can only succeed after step 2.
4. **Resume is implicit** — returning to `active` re-opens issuance; discovery re-drives anything it retried during the pause.

If something is wrong with the pending key, `abortRoutineKeyRotation(db, { rotationId, expectedPendingKeyVersion })` returns the phase to `active` on the _old_ key and marks the pending version `aborted`.

**Verification window to minimize.** Between step 2 (new key deployed and served in the DID doc) and step 3 (DB activated), the DID document advertises the new key while the DB active version is still the old one. During this window the labeler is paused, and a `queryLabels` request touching labels signed under the old key returns `503 "label signing is temporarily unavailable"` (lazy re-signing runs only when the phase is `active`) — so the labeler fails closed rather than serving a label that won't verify against the freshly-served new-key DID doc. Keep the deploy→activate gap short and expect brief `503`s on label queries during it.

**Rotation status & alerts.** `getSigningStatus` exposes the current phase and active/pending versions; `listSigningAlerts` returns `signing_events` alert rows. Watch for `ROTATION_ACTIVATION_MISMATCH`, `ROTATION_SIGNER_MISMATCH`, `ROTATION_ACTIVATION_RACE` — each means activation's guards rejected the attempt.

> Flag: the rotation functions (`beginRoutineKeyRotation`, `activateRoutineKeyRotation`, `abortRoutineKeyRotation`, `initializeSigningState`) are implemented and tested but **are not wired to any operator interface** — no console route, no CLI command, no cron drives them. Invoking a production rotation today means executing these functions against the production D1 binding through operator-owned tooling (a one-off script/Worker), coordinated with the wrangler var/secret deploy. Building that operator interface is a prerequisite for a self-serve rotation.

## Compromise response

**When the private key may be exposed.** Speed matters, but the ordering still matters more — a wrong sequence can strand verification.

1. **Stop issuing first — use the kill-switch, not a rotation.** Pause automation immediately (`POST /admin/api/automation/pause`, [operating.md § kill-switch](operating.md#the-automation-kill-switch-admin)) to halt automated ingestion, and if you must also stop _manual_ issuance, `beginRoutineKeyRotation` moves the signing phase to `paused` (which blocks all issuance). The kill-switch stops new automated decisions from being signed with a possibly-stolen key while you assess.
2. **Identify the compromised key.** The active version is in `signing_state.active_key_version`; `signing_key_versions` lists every version and its status. Labels signed under it carry that `signing_key_version` in `issued_labels`.
3. **Rotate to a fresh key** using the routine procedure above (begin → deploy new key/secret → activate). The compromised version is retired; new issuance uses the new key.
4. **DID update ordering.** Same as routine rotation: the new public key reaches the served DID document via the config deploy (step 2 of rotation), and activation gates on the deployed signer proving it holds the new key. Do not switch the DB active version ahead of deploying the key the signer will actually use.
5. **Historical re-signing decision.** Labels signed under the compromised key remain valid signatures — the concern is not that they're forged but that the _attacker_ could forge _new_ ones. After rotation, historical labels re-sign to the new key lazily on query (see below), so downstream verifiers converge on the new key automatically. Decide whether to force a proactive re-sign of the whole log (a bulk `queryLabels` sweep re-signs as a side effect) versus letting it happen on demand.
6. **Subscriber recovery.** Once rotated, downstream consumers verifying against the (now new-key) DID document will accept re-signed labels; a consumer that cached the old key should refresh its DID resolution. A full replay (see [Aggregator replay after a key event](#aggregator-replay-after-a-key-event)) re-serves everything under the new key.

> Flag: the same "no wired rotation interface" limitation applies here, and it bites harder under time pressure — a compromise response depends on operator-owned tooling to drive the rotation functions against production D1. The Keeper-held offline key is what you rotate _to_; reaching it is the maintainer-owned custody procedure.

## Issuance pause/resume

**Two different pauses — know which you need.**

- **The automation kill-switch** (`automation_state`, [operating.md § kill-switch](operating.md#the-automation-kill-switch-admin)) halts _automated ingestion_ only. Manual issuance and reruns stay available; discovery holds and retries paused events (`readAutomationPaused` in the discovery consumer re-drives them on resume). It fails closed — an unreadable switch means automation does not run. Use it for a discovery-side or model-side incident where you want to stop the firehose but keep operating manually.
- **The signing pause** (`signing_state.phase = 'paused'`, set by `beginRoutineKeyRotation`) halts _all_ issuance — manual and automated — because `buildIssuanceStatements` throws `LabelIssuanceUnavailableError` while paused. Use it only as part of a key rotation or compromise response, where signing itself must stop.

**Resume.** The kill-switch resumes with `POST /admin/api/automation/resume` (a `reason` is required; no ceremony). The signing pause resumes by completing or aborting the rotation (`activateRoutineKeyRotation` / `abortRoutineKeyRotation`) — there is no standalone "unpause signing" that leaves a rotation half-done.

## Historical re-signing

**What it is and when it fires.** After a rotation, existing labels still carry signatures under the old key version. `queryLabels`'s `resignStaleLabels` (`query-labels.ts`) re-signs, on read, any returned label whose `signing_key_version` differs from the current active version. It:

- signs the label afresh under the active key, **preserving the original `cts`** (the label's meaning and timestamp are unchanged — only the signature is refreshed);
- records the prior signature in `label_signature_history` (`ON CONFLICT DO NOTHING`), keeping an auditable trail of what the label was signed with before;
- updates `issued_labels` in place with the new signature, guarded on the signing state still being `active` on that exact key — a mid-flight rotation aborts the re-sign with a `503` rather than writing under the wrong key.

**When it refuses.** Re-signing only runs when the phase is `active`. During a rotation pause, a query touching a stale label returns `503 "label signing is temporarily unavailable"` — the labeler will not serve a label it can't currently re-sign to the advertised key. If the active signing configuration doesn't match the DB state, it raises `RESIGN_CONFIGURATION_MISMATCH` and refuses.

**Operator action.** Normally none — re-signing is automatic and lazy. To force the whole log onto the new key proactively (e.g. after a compromise, to shrink the window where old-key signatures are still served), drive a full `queryLabels` sweep across all URI patterns; each page re-signs its stale labels as a side effect. Watch for `RESIGN_SIGN_FAILED` / `RESIGN_STATE_CHANGED` alerts, which mean a re-sign hit a signing error or a concurrent state change.

## Aggregator replay after a key event

A downstream consumer recovering after a rotation or compromise doesn't need the old key, because historical labels re-sign to the active key lazily on `queryLabels`. But the recovery path matters — only `queryLabels` re-signs, not `subscribeLabels` (see [Full aggregator replay](#full-aggregator-replay)). A consumer that:

1. refreshes its DID resolution for `did:web:labels.emdashcms.com` (picking up the new `#atproto_label` public key), and
2. pulls the backfill via `queryLabels` — or, if it must replay over the `subscribeLabels` WebSocket, drives a full `queryLabels` sweep FIRST so the stored rows are re-signed,

will receive every label with a signature valid under the current key and verify cleanly. Pointing a consumer straight at `subscribeLabels` from `cursor=0` without that prior sweep replays retired-key signatures and will fail verification against the new DID document. The `cts` values are unchanged, so ordering and dedup are unaffected. The re-signing is what makes a post-rotation replay verify without the consumer ever holding a retired key.

## Audit evidence & incident communications

**What to capture.** Every operator action and system event is already recorded append-only — your job during an incident is to reference it, not reconstruct it:

- **`operator_actions`** — every console mutation (who, via the Access `sub`; the action; the reason; the idempotency key). Immutable: rows are never updated or deleted ([operating.md § Audit log](operating.md#audit-log)).
- **`issuance_actions`** — automated block/warn/retraction provenance.
- **`operational_events`** — the alert-grade events: `emergency-takedown`, `publisher-compromised`, `automation-paused`/`-resumed`, `dead-letter-retried`/`-quarantined`, `reconsideration-opened`/`-resolved`, `assessment-prolonged-error`. The payload is deliberately public-safe — subject URI and label value in dedicated columns, operator reason only, **no findings, private detail, or evidence refs** — so an event can be forwarded to an alert channel without leaking exploit detail.
- **`signing_events`** — rotation transitions and signing alerts (`ISSUANCE_PAUSED`, `STALE_SIGNING_KEY`, `SIGNING_KEY_MISMATCH`, the `ROTATION_*` and `RESIGN_*` codes).
- **`dead_letters`** — discovery forensics, with the full original job payload.

**The prolonged-error escalation as an evidence source.** A terminal `error` run that stays the live, unsuperseded assessment past 24h raises an `assessment-prolonged-error` operational event (severity `high`) so operators can triage an infra-vs-publisher cause; past 72h, if still unresolved, the publisher is notified (`prolonged-error.ts`, fire-once via `assessment_error_escalations`). During an AI or acquisition outage, these events are your queue of runs needing a re-run. Note the escalation ladder is driven by the 5-minute cron; a backlog beyond the scan batch (`PROLONGED_ERROR_SCAN_BATCH = 200`) logs `prolonged-error escalation scan hit the batch cap`.

**Communications.** Publisher-facing communication flows through the notification pipeline (block/warn/override/retraction/takedown notices and the 72h prolonged-error notice), which is double-opt-in and carries only public summary/effect/reconsideration URL — never private detail. Operator-to-operator and external incident comms are maintainer-owned; the tables above are the factual record to draw from.

> Flag: turning these tables and log lines into live alerts is the W11.3 alerting layer. Until it lands, the `operational_events`/`signing_events` rows and the `[labeler]` structured logs are the raw material — wire them into your own log-based alerting.
