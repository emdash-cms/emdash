---
id: recover-accidental-edit
site: editorial-team
target: node
status: needs-profile
requires:
  - Editor session
  - Published article with revision history and incorrect current copy
  - Draft preview support
---

# Recover an accidental edit

This journey tests whether revision history supports a safe recovery without obscuring the resulting draft and publication state.

## Bootstrap requirements

Provide an Editor and a published article titled **Annual report**. Its current public opening paragraph must contain known incorrect copy. Revision history must contain an earlier version beginning with the supplied sentence. Enable drafts, revisions, and preview. Capture the public response and complete revision list before dispatch.

## Tester brief

### Persona

You are the managing editor responding to a report that an article was accidentally replaced with outdated copy.

### Goal

Recover the version of **Annual report** whose opening sentence matches the supplied text. Check the recovered result before making it public, and keep the article available throughout the task.

### Starting knowledge

The correct version existed previously. The current public article must not be taken offline while you recover it.

### Supplied material

The correct version begins:

> This year's programme supported 48 community-led projects across the region.

## Coordinator checks

- The article remains published throughout the run.
- The final public article begins with the supplied sentence.
- Restoring the selected revision creates a new revision rather than deleting or rewriting history.
- No earlier revision is lost.
- No unrelated entry changes.

## Areas to observe

- Can the tester discover revision history from the editing workflow?
- Do revision timestamps and previews provide enough information to choose safely?
- Is the effect of Restore clear before confirmation?
- Can the tester distinguish a restored draft from the public version?
- Does the tester know when the recovered copy becomes public?
