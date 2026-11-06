---
rfc: NNNN
title: Short descriptive title
status: Draft
authors:
  - Your Name (@github-handle)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/XXX
created: YYYY-MM-DD
---

# RFC: {{ title }}

# Summary

One or two paragraphs. What is being proposed and why should a reader care? A reader should be able to stop here and know whether the rest of the RFC is relevant to them.

# Example

Concrete before-and-after, or a worked example that shows the proposal in use. Code samples, CLI invocations, screenshots — whatever makes the shape of the change clearest.

# Background & Motivation

What problem is being solved? What goes wrong without this change? Reference the Discussion(s) linked in the header for earlier context, but give the reader enough here to evaluate the proposal standalone.

# Goals

Bulleted list of outcomes this RFC is trying to achieve. Keep each goal short and testable — "users can X", "the AppView does not need Y".

# Non-Goals

Bulleted list of things explicitly out of scope. Be generous here — stating what the RFC is not solving is as useful as stating what it is.

# Prior Art

Relevant prior work, inside and outside the project. Other RFCs, related systems in adjacent ecosystems, previous Discussions in this repo. Explain what each contributed and how this proposal relates.

# Detailed Design

The meat of the RFC. This is a reference-level description, not a tutorial. Someone implementing the change should be able to work from this section. Include:

- Public API or protocol surface.
- Schema or wire-format definitions.
- Component responsibilities and how they interact.
- Validation, error, and edge-case behaviour.

Split into subsections as needed.

# Security Model

If the change has a security surface — handling user input, signing, network access, trust boundaries — describe the threat model and mitigations here. Omit if genuinely not applicable.

# Testing Strategy

How the proposal will be validated. Unit, integration, adversarial. Which scenarios the tests must cover.

# Drawbacks

Real downsides of this design. Be honest — every design has tradeoffs. If there are none, the RFC is probably not capturing the full picture.

# Alternatives

Other designs considered and why they were not chosen. One section per alternative.

# Adoption Strategy

How existing users, authors, hosts or operators move to the new design. Migration, deprecation, rollout sequencing.

# Implementation Plan

Concrete phases. What ships first, what blocks what. If the RFC will be implemented across multiple PRs, sketch the decomposition.

# Unresolved Questions

Open questions that don't block merging the RFC but will need answers before or during implementation. When a question is resolved, it moves into the relevant section above.

# Future Possibilities

Natural extensions. These are not commitments — they help the reader understand where the design could go later.
