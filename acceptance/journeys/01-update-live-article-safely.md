---
id: update-live-article-safely
site: editorial-team
target: node
status: needs-profile
requires:
  - Author session
  - Published owned article without pending changes
  - Draft preview support
---

# Update a live article safely

This journey tests whether the editor communicates the relationship between saved work, pending changes, previews, and the public version.

## Bootstrap requirements

Provide an Author who owns the published article **Autumn opening hours**. The article must have no pending changes and must support drafts, revisions, and preview. Capture its public content and revision state before dispatch.

## Tester brief

### Persona

You are a staff writer. You have used other publishing systems but have not used EmDash before.

### Goal

Update the opening paragraph of **Autumn opening hours**. Check how the change will look to visitors before making it public, and keep the current article available until you are satisfied.

### Starting knowledge

The article is currently visible to visitors and must not disappear while you work.

### Supplied material

Replace the opening paragraph with:

> From 1 October, the studio will open Tuesday through Sunday from 10am until 6pm.

## Coordinator checks

- The article remains published throughout the run.
- The final public article contains the replacement paragraph.
- No pending draft remains after publication.
- Fields outside the opening paragraph are unchanged.
- No other entry changes.
- The revision history records the update without losing earlier revisions.

## Areas to observe

- Can the tester tell whether an edit is saved but not yet public?
- Are autosave, Save, Preview, Live View, and Publish understood as distinct actions or states?
- Can the tester inspect the draft without risking the live article?
- Does the tester know when visitors can see the replacement?
