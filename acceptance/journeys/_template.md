---
id: journey-id
site: editorial-small
target: node
status: ready
requires: []
---

# Journey title

The coordinator sends only the `Tester brief` section to the tester. Keep setup details and success checks outside that section.

Set `status` to `needs-profile` until the selected site profile provides every item in `requires`.

## Bootstrap requirements

Describe the starting data, authenticated role, locale, and feature configuration the profile must provide. Keep this section empty only when the named profile already provides the required state.

## Tester brief

### Persona

Describe the user's role, relevant experience, and reason for doing the task. Include only knowledge a real user in that situation would have.

### Goal

State the result the user needs. Do not name controls, routes, or the expected interaction path.

### Starting knowledge

List information the user has before opening the page. Omit product instructions that the interface must communicate.

### Supplied material

Include exact titles, text, images, dates, or other inputs needed to complete the goal. Remove this section when the journey supplies nothing.

## Coordinator checks

Describe the observable final state and how the coordinator can verify it independently. Prefer a read-only public API check.

## Areas to observe

List journey-specific questions that help interpret the tester's report. Do not use these questions as an expected click path.
