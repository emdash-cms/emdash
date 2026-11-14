---
title: Submission limits for forms
type: feature-plan
status: proposed
authors:
  - Storm (@Stormster)
discussion: https://github.com/emdash-cms/emdash/discussions/4166
created: 2026-10-26
---

# Submission limits for forms

## Problem and user case

Organizers use forms to take signups for things with a fixed number of places: a camp with 30 beds, a workshop with 12 seats, an event with a capacity cap. The forms plugin (`@emdash-cms/plugin-forms`) accepts every valid submission, so it can't stop at 30. Organizers have to watch the inbox, then pause the form by hand. By then they may have accepted more people than they can take.

Hiding the submit button isn't enough. When two visitors submit for the last place at the same moment, both get in unless the server enforces the limit.

## Proposed behavior

An organizer sets **Maximum submissions** on a form. Each submission in the form's inbox takes one place. When every place is taken, the form closes: visitors see a message saying it's full instead of the form, and the server rejects any further submissions.

Worked example: a form has a limit of 30 and 29 submissions. Two visitors submit at the same moment. One gets the normal confirmation. The other sees "This form is full", and nothing they entered is saved. The inbox shows 30 submissions.

In the form editor's settings:

- **Maximum submissions** is a number field. Empty means no limit, which is the default and how existing forms keep working. Next to it the editor shows how many places are taken, for example "12 of 30 places taken".
- **Message when full** is the text visitors see once the form is full. It defaults to "This form is full."
- **Show remaining places** shows visitors how many places are left, for example "3 places left", above the form. It is off by default.
- If the form also deletes old submissions automatically (retention), the editor notes: "Deleting old submissions frees their places."

What counts as a place:

- Each submission in the inbox takes one place, including read and archived submissions.
- Deleting a submission frees its place. Retention cleanup deletes submissions too, so it also frees places.
- Submissions that never reach the inbox don't take a place: spam caught by the honeypot or Turnstile, submissions that fail validation, and submissions whose file upload fails.

Changing the limit:

- Raising the limit, or clearing it, reopens a full form straight away.
- Lowering the limit below the number of submissions closes the form. Existing submissions are kept.
- Duplicating a form copies its limit. The copy starts with no submissions, so all its places are free.

On the site:

- A full form shows the organizer's message where the form would be. It does not disappear the way a paused form does.
- A visitor who opened the page while places were left, and submits after the form filled up, gets the same message in the form's error area. Nothing they entered is saved.
- The forms list in the admin shows "12 / 30" in the Submissions column for forms with a limit.

## Goals

- Never accept more submissions than the limit, including when visitors submit at the same moment, on every supported database.
- Tell visitors plainly when a form is full, both on page load and at submit time.
- Give organizers a setting they can predict without reading documentation: one number, and a count of places taken.
- Leave existing forms, and forms without a limit, working as they do today.
- Add no database queries to public page renders.

## Non-goals

- Waitlists, or moving people up when someone cancels.
- Different limits per option, such as per session or per ticket type.
- Submissions that take more than one place, such as a "number of attendees" field.
- One submission per person or per email address.
- Opening or closing a form on a schedule.
- Holding a place while a visitor fills the form in.
- Payments.

## Interfaces and compatibility

- **Form settings.** `FormSettings` gains three optional fields: `maxSubmissions` (an integer of at least 1, or absent for no limit), `fullMessage` (a string), and `showRemaining` (a boolean, default `false`). The create and update route schemas accept them. Because the update route merges settings over the stored ones, the update schema accepts `maxSubmissions: null` to clear a limit, the same way an empty string clears `redirectUrl` today. A form without `maxSubmissions` behaves exactly as it does today. No migration is needed, because settings live in the form's existing storage document.
- **Counting.** The limit uses the form's existing `submissionCount`. This depends on #4419, which makes that counter exact under concurrent submissions and deletes and requires `emdash` 0.38.0 or later.
- **Submit route.** The submit handler takes a place before uploading files or saving the submission. It uses one guarded `updateIf` on the form: increment `submissionCount` only while the form is `active` and the count is below `maxSubmissions`. If the update doesn't apply, the handler rejects the submission. If anything after that throws, including the file type and size checks, the upload and the save, the handler gives the place back. For forms without a limit, the guard checks only that the form is active. This also closes a gap where a submission that started before an admin paused the form was still saved.
- **New error code.** A full form returns `FORM_FULL` with HTTP 409 and the form's `fullMessage`. `FORM_PAUSED` (410) is unchanged.
- **Public definition route.** The route that serves a form to the site embed adds a `full` flag, and `remaining` when `showRemaining` is on. Both come from the form document the route already reads, so public pages make no extra queries. The public definition validator gains the same fields.
- **Embed and client.** `FormEmbed.astro` renders `fullMessage` instead of the form when `full` is set, and shows the remaining count when it is present. The client script currently shows a generic error for any rejected submission. It gains a case that reads the error code and shows the `FORM_FULL` message in the existing status region.
- **Admin.** The form editor's Settings section gains the three fields. The forms list shows "taken / limit". New admin strings go through Lingui, like the rest of the form editor. The site embed's text stays in English, as its existing text does. New layout uses logical (RTL-safe) classes, as the plugin already does.
- **Rolling back.** Older plugin versions ignore the new settings fields, so after a downgrade forms accept submissions without a limit and keep working. The stored limit stays in the form's settings and applies again after upgrading.

## Errors and edge cases

- **Last place.** Concurrent submissions for the last place resolve in the database, so exactly one succeeds. The others get `FORM_FULL`.
- **Cached pages.** A page cached while places were left still shows the form and the old remaining count. The submit check is authoritative: a late visitor gets the full message at submit time.
- **Failures after taking a place.** If a file check, upload or the submission save fails after a place is taken, the handler releases the place. If the process stops between taking and releasing a place, for example when a Worker is killed, that place stays taken until a submission is deleted.
- **Limit changed during a submission.** The handler checks against the limit it read when the request started. A submission already in progress when an organizer lowers the limit can still take a place under the old limit.
- **Spam.** The honeypot returns a silent success before taking a place, so bots never use places.
- **Notifications.** A rejected submission sends no notification, autoresponder or webhook.
- **Paused and full.** A paused form stays hidden on the site whatever its count. Resuming a full form shows the full message.
- **Invalid limits.** A limit of 0 or less, or a non-integer, fails validation with the existing `VALIDATION_ERROR`. Clearing the field removes the limit.
- **Count already wrong.** A form whose count was wrong before #4419 enforces the limit against that count until submissions are deleted. The editor's "places taken" figure shows the same number, so an organizer sees what the server uses.

## Verification

- Concurrency tests on real plugin storage (SQLite): at 29 of 30, two overlapping submissions produce one acceptance and one `FORM_FULL`, and the count ends at 30.
- Tests that a rejected file, a failed upload and a failed save each release their place, that a honeypot hit doesn't take one, and that deleting a submission and retention cleanup free places.
- Tests for raising, lowering, and clearing the limit (`null`), duplicating a form with a limit, and the paused-and-full combination.
- A test that the public definition route returns `full` and `remaining` from the form it already reads, with no extra query.
- Embed render tests for the full message and the remaining count, and a client test for the `FORM_FULL` message.
- Admin tests for the new settings and the "taken / limit" column.
- A manual pass on a local site: fill a form to its limit with simultaneous submissions, and check the editor, the embed, and the error message at phone width, with the admin in a right-to-left language, and with a screen reader.

## Open questions

- Should a full form return 409, or 410 like a paused form?
- Should "Show remaining places" show the exact number at all times, or only when few places are left?
- Should archived submissions keep taking a place, or should archiving free it?
