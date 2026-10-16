---
title: Durable system-email delivery intents and classified outcomes
type: rfc
status: proposed
authors:
  - Vidar Brekke (@vidarbrekke)
champion: Vidar Brekke (@vidarbrekke)
sponsor: TBD
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4140
created: 2026-10-16
---

# Durable system-email delivery intents and classified outcomes

## Decision requested

This RFC asks EmDash to adopt a host-owned durable delivery condract for
system email and application-owned transactional notifications.

The immediate decisions requested from Maintainers are:

1. Should Auth persist a delivery intent as part of the same durable operation
   that creates a magic-link, invitation, or recovery credential?
2. Should email delivery return a classified outcome that distinguishes
   provider acceptance, pending queue work, permanent rejection, and an
   unknown result?
3. Should the first implementation cover only system email, or should the
   same outbox contract be exposed for application-owned notifications in the
   initial release?

This is a proposal, not an implementation plan approved for merge. The
champion is ready to refine the design with a Maintainer sponsor and implement
the accepted result.

## Problem and user cases

Published EmDash/Auth 1.2.0 does not provide a durable contract for email
obligations created by Auth or by application workflows.

The current contract has several independent failure windows:

* `EmailDeliverEvent` carries the message and source, while the configured
  delivery handler returns `Promise<void>`.
* Auth creates a magic-link token before calling its configured email
  callback. If the process fails between those operations, the token exists
  without a recoverable delivery obligation.
* System messages bypass ordinary plugin before/after middleware, so a
  transport plugin cannot repair a system-email obligation that never reaches
  the transport hook.
* A provider may accept a message while the response is lost, or may only
  report that it queued work. A caller cannot distinguish either result from
  successful provider acceptance.
* Application code may mark a notification sent and delete its payload after
  a transport returns, even though the provider has not accepted the message.

This affects magic-link login, invitations, account recovery, and
application-ownned transactional notifications. The failure is especially
costly for credentials: blindly retrying can duplicate a credential message,
while treating an unknown result as rejection can lose the only delivery
attempt.

## Proposed behavior

EmDash would introduce a host-owned delivery intent and outcome lifecycle.
The exact table and exported names are implementation details to settle during
Design review, but the observable contract would be:

1. The host creates an immutable delivery intent with a stable identifier,
   source, recipient, message payload or renderable message reference,
   creation time, expiry time where applicable, and an idempotency key.
2. For Auth credentials, creation of the credential and creation of the
   system-email intent are part of one durable host operation. A successful
   Auth operation therefore leaves either both records or neither record.
3. A delivery attempt reports one of four durable outcomes:
   `accepted`, `pending`, `rejected`, or `unknown.
4. `accepted` means that the configured provider accepted responsibility for
   the message. It does not claim inbox delivery.
5. `pending` means that the provider or a durable transport queue still owns
   work that may complete later. The intent remains recoverable.
6. `rejected` means that retrying the same attempt will not succeed without a
   changed message, recipient, configuration, or operator action. The intent
   remains inspectable and is not silently discarded.
7. `unknown` means that the host cannot establish whether the provider
   accepted the message, for example after a timeout or lost response. The
   intent remains recoverable and retries use the same idempotency key.
8. A recovery worker or scheduled maintenance path retries eligible
   `pending` and `unknown` intents. It records attempts and backoff durably so
   process restarts and Worker-isolate replacement do not lose recovery state.
9. An expired credential intent is not resent as if it were still valid. The
   system marks it expired and requires a new Auth request when the credential
   is no longer usable.
10. System-email delivery remains isolated from ordinary plugin middleware.
    The new host-owned boundary must not turn privileged Auth messages into
    arbitrary plugin interception points.

For an application-owned notification, the application could create an intent
and observe its durable state without deleting the source payload until the
intent reaches a terminal outcome or an explicit retention policy is applied.

## Example lifecycle

```text
Auth transaction
  ├─ create credential
  └─ create email intent: pending

Delivery attempt
  ├─ provider accepts       → accepted
  ├─ provider queues        → pending, retry/reconcile later
  ├─ provider rejects       → rejected, retain reason
  └─ response is lost       → unknown, retry with same idempotency key
```

The provider adapter must be able to preserve the stable delivery identity
when it supports idempotent submission. An adapter that only implements the
legacy `Promise<void>` callback cannot honestly claim provider acceptance after
an ambiguous return; the compatibility behavior for such adapters is an open
question below.

## Goals

* Prevent Auth from creating a credential without a recoverable system-email
  obligation.
* Make provider acceptance, pending work, rejection, and uncertainty
  distinguishable to the host and to operators.
* Make retry and restart recovery durable and idempotent.
* Prevent expired credentials from being resent accidentally.
* Give application-owned transactional notifications a host-supported durable
  boundary where the initial scope permits it.
* Preserve the isolation of system-email hooks and existing authorization
  boundaries.
* Keep ordinary logged-out requests free of provider polling or synchronous
  recovery work.

## Non-goals

* Guaranteeing delivery to a recipient's inbox, or bypassing provider spam
  filtering.
* Replacing provider-specific queueing, bounce, complaint, or unsubscribe
  systems.
* Building a general-purpose workflow engine.
* Making every existing provider immediately transactional.
* Exposing message bodies or credentials through a public plugin API.
* Choosing a particular email vendor or transport implementation.

## Interfaces and compatibility

The change affects the Auth email contract, host-owned stored data, and
provider integration surfaces, so it requires an RFC rather than a direct
feature PR.

The preferred compatibility shape is additive:

* Existing delivery hooks remain available during a migration period.
* A new structured delivery result and stable delivery identity are added for
  providers that can support them.
* Existing `Promise<void>` adapters are explicitly treated as legacy and must
  not be interpreted as proof of provider acceptance when the return is
  ambiguous.
* New tables or records are additive and have explicit retention and cleanup
  rules. Existing sites must continue to start and deliver through their
  configured legacy provider while they migrate.
* System-email hook isolation remains a documented compatibility invariant.

The implementation must define whether a provider's `accepted` result means
accepted by the provider API, accepted into a provider-managed queue, or some
other provider-specific boundary. The result must not use a stronger meaning
than the provider can prove.

## Stored state and retention

The host needs durable intent, attempt, and outcome state. At minimum, the
state needs a stable intent ID, idempotency key, source, status, timestamps,
expiry where relevant, attempt count, last error classification, and enough
message data or a safe reference to retry without recreating an expired
credential.

Auth payloads are sensitive. The implementation must specify who can read
intent metadata and message payloads, how long each class is retained, and
how cleanup behaves after acceptance, rejection, expiry, and cancellation.
Intent state must not become a new path for revealing credentials to ordinary
plugin code or logged-out callers.

## Errors and edge cases

The design and implementation must cover at least:

* database commit succeeds but the process dies before the first delivery
  attempt;
* provider accepts the message and the response is lost;
* provider returns a transient queueing result;
* provider permanently rejects the message;
* provider times out repeatedly;
* the same intent is claimed concurrently by two workers;
* a Worker isolate restarts during an attempt;
* a credential expires while delivery is pending;
* a caller requests a second magic link while the first intent is unresolved;
* a provider does not support idempotency keys;
* the configured provider is removed or replaced while intents remain;
* an operator needs to retry or cancel an intent without exposing its body.

## Security and privacy

The host must preserve the existing Auth authorization boundary and system
message isolation. Delivery IDs and status may be useful for operations, but
credential-bearing message content must not be returned from public status
routes. Error records must avoid provider responses that contain secrets or
full message bodies.

The proposal should also define whether idempotency keys are derived from the
intent ID, generated separately, or scoped by provider account. They must not
contain raw email addresses, credentials, or message content.

## Performance and operations

Credential creation should add only the durable write required to preserve the intent. Provider calls, retries, and reconciliation belong to a durable background or scheduled path rather than to ordinary logged-out page requests.

The implementation should measure the additional transaction cost, queue latency, retry volume, and storage growth for SQLite/Node and Cloudflare/D1.
Indexes used for recovery must support bounded queries by status and next attempt time without turning every request into a readiness or provider probe.

Operators need a way to see the number and age of pending, unknown, rejected, and expired intents, plus a safe recovery or cancellation action appropriate to each state.

## Verification

The implementation should add behavior-level tests using real supported databases and the narrowest affected runtime boundaries. At minimum, tests must demonstrate that:

* a credential and its system-email intent are committed together;
* process failure before delivery leaves recoverable work;
* accepted, pending, rejected, and unknown provider results persist distinct outcomes;
* an unknown result can be retried with the same idempotency key;
* concurrent workers do not deliver the same intent twice when the provider supports idempotency;
* a restart resumes pending work;
* an expired credential is not resent;
* legacy providers continue to operate under the documented compatibility behavior;
* system-email messages remain outside ordinary plugin middleware;
* application-owned intents follow the same retention and terminal-state rules, if included in the initial scope.

The tests should include the Node/SQLite path and the Cloudflare/D1 path when the affected code is shared by both runtimes. Provider-specific acceptance semantics should be tested with a small real or contract-tested adapter rather than by asserting a mock's return value.

## Rollout and rollback

The first release should use additive schema and interface changes. Existing providers should remain usable while the structured result is introduced. Asite must be able to deploy the schema before enabling new recovery behavior, and a rolling deployment must not stand intents created by an older process.

Rollback must preserve intent records and avoid deleting credentials or notification payloads merely because the new worker is no longer running.
The RFC should define whether legacy delivery continues synchronously during rollout and how an operator drains or reconciles intents after rollback.

## Open questions

1. Is the first implementation limited to system email, with application notifications as a later consumer of the same primitive?
2. Which host layer owns the atomic credential-plus-intent transaction:
   `@emdash-cms/auth`, core runtime, or a new shared package?
3. What exact meaning should `accepted` have for a provider that only offers
   queue submission?
4. How should legacy `Promise<void>` providers be classified after return, and
   what migration warning should they receive?
5. Should message payloads be stored directly, rendered from an immutable credential record, or delegated to a provider-owned durable queue?
6. What operator controls are safe for an unknown credential-bearing intent?
7. Should provider replacement automatically pause, retry, or reject existing intents?

## Implementation outline after acceptance

The champion would split implementation into reviewable slices:

1. schema and durable state primitives;
2. structured provider result and stable delivery identity;
3. Auth transaction integration and expiry handling;
4. recovery worker and concurrency/idempotency tests;
5. application notification API, if included in scope;
6. operator visibility, documentation, and migration guidance.

Each implementation PR would link this accepted design and would update this proposal explicitly if implementation reveals a design flaw.
