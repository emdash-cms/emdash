---
name: adversarial-reviewer
description: Stress-test a code change for concrete correctness defects, unsafe assumptions, and failure modes. Use when the user explicitly asks for an adversarial review, a deep bug hunt, or to tear a change apart. Do not use for ordinary review, style feedback, or general improvement suggestions.
---

# Adversarial code review

Look for defects that survive an ordinary review. Treat the implementation's assumptions as claims to verify, while keeping every finding tied to evidence.

## Establish the review boundary

1. Identify the exact diff, branch, pull request head, or files under review.
2. Read the surrounding code needed to understand data flow and invariants.
3. Check repository instructions and the tests that define expected behavior.
4. Separate defects introduced by the reviewed change from unrelated observations. Report an out-of-scope issue only when it materially affects the change's safety.

Do not modify code, post a review, or expand the review target unless the user asks.

## Hunt for failures

Choose the checks that fit the change instead of mechanically applying every category.

- **Logic and boundaries:** empty and single-item inputs, pagination edges, invalid state transitions, locale handling, Unicode, maximum values, and repeat invocation.
- **Errors and cleanup:** swallowed failures, partial cleanup, misleading status codes, exposed internals, missing timeouts, and unbounded retries.
- **State and concurrency:** stale reads, lost updates, time-of-check/time-of-use races, duplicate delivery, non-idempotent retries, leaked listeners, and shared mutable state.
- **Authorization and trust:** missing permission checks, confused caller identity, CSRF, unsafe redirects, injection, path traversal, secret exposure, and trust transferred across a boundary without validation.
- **Data integrity:** partial writes, migration restart behavior, dialect differences, uniqueness assumptions, destructive cascades, and old/new version compatibility.
- **Resources and performance:** unbounded collections, repeated round trips, retained resources, logged-out hot-path regressions, and work that scales with attacker-controlled input.

Trace concrete inputs and event sequences through the real implementation. Run focused tests or a minimal reproduction when that is the fastest way to establish a claim. Do not infer a bug solely from an unfamiliar pattern.

## Findings standard

A finding needs all of the following:

- the violated behavior or invariant;
- the exact code location;
- a concrete trigger or execution path;
- the observable consequence;
- a proportionate fix direction.

Use calibrated language. State confirmed defects directly. Label an unresolved concern as uncertain and explain what evidence is missing. Do not turn naming, formatting, optional hardening, or personal design preference into a correctness finding.

Prioritize by impact and likelihood:

- **Critical:** exploitable security issue, unrecoverable data loss, or broad production outage.
- **High:** likely user-visible wrong behavior, authorization bypass, or recoverable data corruption.
- **Medium:** real failure under a plausible edge case, race, or sustained load.
- **Low:** limited correctness issue with small impact. Omit purely cosmetic observations.

## Report

Lead with findings, ordered by severity. For each finding, include a short title, file and line, the failing scenario, impact, and fix direction. Keep line ranges tight.

If no actionable defects are supported by the evidence, say so. Mention meaningful residual risks or untested boundaries, but do not manufacture findings to make the review appear thorough.
