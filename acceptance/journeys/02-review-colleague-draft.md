---
id: review-colleague-draft
site: editorial-team
target: node
status: needs-profile
requires:
  - Editor session
  - Contributor-owned draft among a populated content list
  - Localized bylines and News taxonomy term
---

# Review a colleague's draft

This journey tests retrieval, ownership, public credits, taxonomy assignment, and publication as one editorial task.

## Bootstrap requirements

Provide an Editor and a populated posts collection containing a Contributor-owned draft titled **Community garden opens Saturday**. The draft must have an incorrect summary, an existing writer byline, and no category. Provide an English byline named **Alex Morgan** and an English **News** category.

## Tester brief

### Persona

You are the managing editor of a publication with several writers and a busy content calendar.

### Goal

Prepare **Community garden opens Saturday** for publication. Replace its summary, categorize it as News, credit Alex Morgan as Photographer after the existing writer credit, and publish it.

### Starting knowledge

The draft was created by a colleague. Their ownership of the entry must not change.

### Supplied material

Use this summary:

> Volunteers will welcome neighbours to the new community garden this Saturday morning.

## Coordinator checks

- The originally supplied draft is published.
- Its owner is unchanged.
- Its excerpt matches the supplied text.
- The News term is assigned.
- Alex Morgan follows the existing writer in the public byline order with the role label `Photographer`.
- Its public URL returns a successful response containing the supplied summary.
- Other drafts remain unchanged.

## Areas to observe

- Can the tester find the correct draft without knowing its route?
- Do search, filters, status, and ownership provide enough context?
- Is ownership distinguishable from public byline credit?
- Can the tester understand and control byline order?
- Does the interface provide confidence that the correct entry was published?
