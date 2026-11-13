---
title: Show pending invitations on the Users screen
type: feature-plan
status: proposed
authors:
  - David Brabyn (@dbrabyn)
discussion: https://github.com/emdash-cms/emdash/discussions/4842
created: 2026-11-13
---

# Show pending invitations on the Users screen

## Problem and user case

After an admin sends an invite from the Users screen, the only feedback is a short "Invitation sent to {email}" toast. The invited person does not appear anywhere until they accept. Nobody can see who has a pending invite, when it expires, or whether it was already sent.

In EmDash 1.5.0 the invite routes are create, accept and complete. Pending invites are rows in `auth_tokens` (type `invite`). There is no way to list, resend or revoke them from the admin or the API. Nothing stops a second invite to the same address: pressing Invite three times stored three tokens and sent three emails.

An agency setting up a client's site invites the owner as Editor. The toast fades, the Users list does not change, and the agency assumes the invite failed and sends it again. The owner receives three identical emails. The agency can only confirm that all three went out by querying D1 or searching the Worker logs.

## Proposed behavior

The Users screen gets a "Pending invitations" section below the user list. It shows one row per unexpired invite with the email, role, who sent it, when it was sent and when it expires. Each row has Resend and Revoke actions. The section is hidden when there are no pending invites.

- **Resend** sends the invite email again and extends the expiry. The existing link stops working, so only one valid link exists per address.
- **Revoke** deletes the invite. Its link stops working.
- **Inviting an address that already has a pending invite** does not create a second token. The dialog says an invite is already pending, shows when it was sent, and offers Resend instead.

Worked example: an admin invites `owner@example.com` as Editor. The row appears at once. Two days later the owner has not accepted, so the admin presses Resend. The owner gets one new email, the old link no longer works, and the row shows a new expiry.

## Goals

- Show every unexpired pending invite on the Users screen with its role, sender and expiry.
- Let an admin resend or revoke a pending invite.
- Prevent more than one pending invite per email address.
- Expose list, resend and revoke through the admin API so plugins and scripts can use them.

## Non-goals

- Changing how invites are accepted or completed.
- Showing accepted or expired invites as history.
- Delivery tracking, such as bounces or opens.
- Bulk invites.

## Interfaces and compatibility

New admin API routes under the existing invite routes: list pending invites, resend one, revoke one. They follow the same permission as creating an invite.

No change to the `auth_tokens` schema is expected, since the type, email, role, creator and expiry are already stored. The invite create route changes behavior for a duplicate address: it returns the existing pending invite and a flag, instead of creating another token. Callers that always expect a new token would see a different response for that case. This needs a decision, see open questions.

## Errors and edge cases

- Resend or revoke on an invite that was already accepted, revoked or expired returns a clear not-found error and the list refreshes.
- Resend when the email provider is not configured fails the same way the first send does, and keeps the old token valid.
- Two admins acting on the same invite: the second gets the not-found error.
- An invite for an address that already has a user account is rejected as it is today.
- Expired invites are not listed.

## Verification

- The list shows an invite after creation without a page reload, and drops it after accept, revoke or expiry.
- Resend sends exactly one email and invalidates the previous link.
- Revoke makes the link fail with the same error as an expired link.
- A second invite to a pending address creates no new token and sends no email until the admin chooses Resend.
- The routes reject callers without the invite permission.
- Interface screenshots of the Users screen with and without pending invites.

## Open questions

- Should the duplicate-invite case change the existing create route's response, or should the admin UI check for a pending invite first and leave the route unchanged?
- Should Resend keep the original expiry or start a new full period?
- Is a list route in the public API surface acceptable, or should it stay internal to the admin?

I'm not planning to implement this and am happy for another contributor to take it.
