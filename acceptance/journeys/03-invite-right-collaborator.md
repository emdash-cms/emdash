---
id: invite-right-collaborator
site: editorial-team
target: node
status: needs-profile
requires:
  - Admin session
  - No existing user or invitation for priya@example.com
  - Email delivery disabled
---

# Invite the right collaborator

This journey tests whether role descriptions and invitation feedback let an administrator grant the intended access without being told an EmDash role name.

## Bootstrap requirements

Provide an Admin on a configured team site. Ensure that `priya@example.com` has no user or outstanding invitation and that no email provider is configured, so a successful invitation returns the manual sharing flow.

## Tester brief

### Persona

You own a small publication and manage access for its contributors. You understand what each person should be allowed to do, but you do not know EmDash's role names.

### Goal

Invite Priya Shah at `priya@example.com`. Priya should be able to create, edit, and publish her own posts. She must not be able to edit other writers' posts or change site settings.

Obtain whatever Priya needs to complete registration.

### Starting knowledge

No email delivery service has been connected to this site.

## Coordinator checks

- A valid invitation exists for `priya@example.com`.
- The invitation grants role level 30.
- No user account or duplicate invitation is created.
- The tester records the generated invite link for manual sharing without exposing it beyond the acceptance report.

## Areas to observe

- Can the tester discover where collaborators are invited?
- Do the available role names and descriptions support the correct access decision?
- Is the difference between creating an invitation and sending email clear?
- Does the fallback explain how to complete the invitation safely?
