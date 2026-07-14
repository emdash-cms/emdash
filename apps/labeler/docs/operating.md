# Operating the labeler console

The operator console is a React SPA served under `/admin` on the labeler's domain. It lets reviewers and admins inspect automated assessments and act on them: issuing and retracting labels, overriding false positives, taking down abusive content, pausing automation, and clearing the dead-letter queue. This guide covers signing in, the two roles, and each workflow.

For the label vocabulary the actions manipulate, see [moderation-model.md](moderation-model.md). For the identity and signing concepts underneath, see [atproto.md](atproto.md).

## Signing in

Authentication is **Cloudflare Access** — there is no separate password and no dev bypass. You authenticate at the Cloudflare edge against your identity provider; Access issues a signed JWT and injects it (as `Cf-Access-Jwt-Assertion`) on every request to `/admin/api/*`. The Worker verifies that JWT against Access's JWKS (RS256, checking issuer, audience, and expiry) on every request. The edge policy on `/admin/*` also redirects an unauthenticated browser before it ever reaches the Worker, so you will be sent through your IdP the first time you open the console.

Your role comes from the Access group membership in the verified JWT, matched against the `admins` and `reviewers` group names in `OPERATOR_ACCESS_CONFIG`. `GET /admin/api/whoami` returns your roles; the console uses it only to show or hide admin controls. The server re-checks authorization on every mutation regardless of what the UI shows, so the button visibility is cosmetic — the server is always authoritative.

## Roles

There are two roles, **reviewer** and **admin**. An admin inherits every reviewer capability; there is no path the other way.

| Capability                                                        | Reviewer | Admin |
| ----------------------------------------------------------------- | :------: | :---: |
| Read assessments, findings, labels, subject history, audit log, system status, dead-letter list, effect previews | ✓ | ✓ |
| Issue and retract a reviewer label                                | ✓ | ✓ |
| Re-run an assessment                                              | ✓ | ✓ |
| False-positive override and override-retract                      | ✓ | ✓ |
| Emergency takedown / takedown-retract                             |          | ✓ |
| Publisher-compromised / retract                                   |          | ✓ |
| Automation pause / resume                                         |          | ✓ |
| Dead-letter retry / quarantine                                    |          | ✓ |

A reviewer who calls an admin-only endpoint gets a `403`.

Reviewers can read operator-only detail on findings (the `privateDetail` field), not just the public assessment.

## Reviewing an assessment

Open an assessment from the list to see its findings, the labels currently live on the subject, and the operator-only detail. From there a reviewer can attach a descriptive label to a subject with **issue** (`POST /admin/api/labels/issue`) and pull one back with **retract** (`POST /admin/api/labels/retract`), which negates a reviewer-issued label. Which labels a reviewer may issue, and against which subject and CID, is governed by the policy — see [moderation-model.md](moderation-model.md).

## Re-running an assessment

**Re-run** (`POST /admin/api/assessments/:id/rerun`) re-queues the assessment: it mints a fresh run and re-issues `assessment-pending` so the release is gated again until the new run resolves. Because a re-run changes the live state of a specific release, you confirm the action by typing the release **CID** — a deliberate check that you are acting on the version you think you are.

## False-positive override

When an automated block is wrong, **override** (`POST /admin/api/assessments/:id/override`) clears it. In one atomic action it negates *all* live automated blocks on the exact URI + CID and issues the reviewer pair `assessment-passed` + `assessment-overridden`. The negate-set you submit must equal the live automated-block set exactly; if automation has issued a block you did not include, the action is rejected rather than partially applied. Like a re-run, it requires CID confirmation.

An override is permanent in effect: the pass pair suppresses the negated blocks *and* future automated blocks for that release, so re-assessment cannot silently re-block it. This is the §10 rule in action — automation may not overturn a human decision.

**Override-retract** (`POST /admin/api/assessments/:id/override-retract`) pulls the override pair back. It does **not** restore the original blocks — those stay negated — so the release resolves to a "safe-blocked" state: blocked, but for a missing assessment pass rather than a live finding. To re-surface the real findings, retract the override and then re-run.

## Emergency actions (admin)

Emergency actions carry a two-field ceremony to prevent misfires. Every one requires you to type the **subject identifier** and an exact **intent phrase**; the action is rejected unless both match.

- The subject identifier is the record `rkey` for a release or package subject, or the DID's final `:`-segment for a publisher.
- The intent phrase is fixed per action.

| Action                                                     | Endpoint                                        | Intent phrase       |
| ---------------------------------------------------------- | ----------------------------------------------- | ------------------- |
| Takedown (`!takedown` redaction on release/package/publisher) | `POST /admin/api/emergency/takedown`            | `CONFIRM TAKEDOWN`  |
| Takedown retract                                           | `POST /admin/api/emergency/takedown-retract`    | `CONFIRM RETRACT`   |
| Publisher-compromised                                      | `POST /admin/api/emergency/publisher-compromised` | `CONFIRM COMPROMISE` |
| Publisher-compromised retract                              | `POST /admin/api/emergency/publisher-compromised-retract` | `CONFIRM RETRACT`   |

A takedown of a publisher or package is a single URI-wide (or DID-wide) label the evaluator honors for everything beneath it — it is not fanned out into per-release labels. Retracting a takedown restores the state that was computed before it: the automated blocks that were live re-expose, because they were never negated and nothing is re-issued. A retract with no active label to pull returns `404 NO_ACTIVE_LABEL`.

## The automation kill-switch (admin)

**Pause** (`POST /admin/api/automation/pause`) and **resume** (`POST /admin/api/automation/resume`) are the global switch on automated ingestion. Pausing halts Jetstream ingestion only: the discovery consumer holds and retries paused events, so nothing is lost, and manual issuance and reruns stay fully available. A `reason` is required; there is no confirmation ceremony. The switch fails closed — if its state cannot be determined, automation does not run.

## Dead-letter queue (admin)

Discovery jobs that exhaust their retries land in the dead-letter list. Each letter can be:

- **Retried** (`POST /admin/api/dead-letters/:id/retry`) — re-enqueues the discovery job (at-most-once).
- **Quarantined** (`POST /admin/api/dead-letters/:id/quarantine`) — a terminal "will not retry" state.

Both reject an already-resolved letter with `409`, so two operators acting on the same letter cannot double-resolve it.

## Audit log

Every console mutation writes an append-only audit row recording who acted (the Access `sub`), the action, the reason, and an idempotency key. The table is immutable — rows are never updated or deleted.

Idempotency: replaying a request with the same key and an identical body returns the stored result (a safe retry). The same key with a *different* body is a `409` conflict, so a key cannot be reused to smuggle a different action through.

The audit view you see in the console omits internal columns — idempotency key, request fingerprint, raw result, metadata, and epoch timestamps — and shows the human-facing record.

## CSRF

Every state-changing request also needs the header `X-EmDash-Request: 1`, plus same-origin and JSON content-type checks. The console sends this automatically; operators do nothing. It is noted here only so that anyone scripting against `/admin/api/*` directly knows it is required.
