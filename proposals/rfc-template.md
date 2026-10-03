---
title: Short descriptive title
type: rfc
status: proposed
authors:
  - Name (@github-handle)
champion: Name (@github-handle)
sponsor: Name (@github-handle)
design-pr: pending
discussions:
  - https://github.com/emdash-cms/emdash/discussions/XXX
created: YYYY-MM-DD
---

# Short descriptive title

## Summary

Describe the decision and its intended outcome.

## Problem and user case

Describe the concrete problem, who encounters it, and the evidence that it is worth solving.

## Example

Show the proposed behavior through a worked example, interface, data shape, or interaction.

## Goals

- State each outcome the RFC must provide.

## Non-goals

- State adjacent work that is outside this RFC.

## Detailed design

Specify the behavior and interfaces precisely enough to implement without reopening ordinary product or architecture decisions. Cover the relevant public API, configuration, data model, component responsibilities, validation, errors, edge cases, localization, accessibility, and runtime differences.

## Compatibility and migration

Describe backwards compatibility, versioning, existing data, migration order, and rollback. State why a breaking change is necessary when one is proposed.

## Security and privacy

Describe trust boundaries, authorization, untrusted input, secrets, and privacy effects. Write "No additional security or privacy surface" only after checking each boundary.

## Performance

Describe effects on hot paths, query counts, cold starts, storage, and other relevant resource limits. Include measurements or a measurement plan when performance motivates the RFC.

## Failure handling

Describe partial failure, retries, recovery, observability, and operator action.

## Verification

Describe unit, integration, runtime, adversarial, compatibility, and manual checks relevant to the design.

## Rollout and implementation

Describe implementation slices, sequencing, feature flags, rollout, monitoring, and removal of transitional paths.

## Alternatives

Describe the credible alternatives and why they were not selected.

## Drawbacks

Describe the costs and constraints introduced by the design.

## Open questions

List unresolved decisions. Resolve questions that affect the public contract or architecture before acceptance.
