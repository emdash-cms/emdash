---
"emdash": minor
"@emdash-cms/auth": minor
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
---

Adds editorial comments: threads that staff leave on an entry while reviewing it, separate from the public comments visitors post.

A thread points at the whole entry, a field, a Portable Text block, or a range of text in a block, and holds a conversation that can be resolved and reopened. Threads are private to staff and never appear on the site.

In the entry editor, select text in any Portable Text field and choose **Comment** in the formatting toolbar, or press ⌘⌥M (Ctrl+Alt+M), to start a thread beside it. To comment on an image, embed, divider or other non-text block, choose **Comment** in its block menu (or, without edit access, select the block and choose **Comment** in the toolbar above it), and to comment on a whole field, use the comment button at the end of the field's label row. The comment button in the editor bar, just before the settings panel toggle, shows or hides the margin and shows how many threads are open. Commenting needs no edit access: Contributors who can't edit an entry, and anyone viewing an entry while someone else holds its edit lock, can still select text and comment. Commented text stays highlighted as you edit, and a thread whose text was deleted is listed as detached with the text it referred to. Links of the form `?thread=<id>` open the editor with that thread selected and its text in view, and **Go to text** on an open thread selects the text it refers to.

The API lives under each entry, at `/_emdash/api/content/{collection}/{id}/threads`, with routes to list and start threads, reply, edit and delete comments, resolve and reopen threads, and store anchors after the entry's content changes. Each thread and comment in a response carries `can` flags that say what the caller may do with it.

#### Mentions and email

Type `@` in a comment to mention someone who can take part in threads. A comment body stores each mention as `<@USER_ID>`, and every thread in a response lists the users it mentions under `mentions`, with their current names, so a renamed user shows the new name. `GET …/threads/mentionable?q=` returns up to 10 people to mention, matched by display name, without email addresses. A new comment, or an edit that adds a mention, fails with `VALIDATION_ERROR` when it mentions a user who doesn't exist or can't take part. Mentions already in a comment don't stop it being edited.

When the site has an email provider, a new comment emails the people it mentions, the thread's creator and the authors of its earlier comments that weren't deleted, except its own author, anyone who can no longer take part, and users whose email address isn't verified. Editing a comment to mention someone new emails only that person. The email has the entry's title, an excerpt of the comment and a link to the thread. Without an email provider, nothing is sent, and the comment is still saved. See [Comment on an entry](https://docs.emdashcms.com/guides/working-with-content/#comment-on-an-entry) for mentions and comment emails.

#### Permissions

Two permissions are new in `@emdash-cms/auth`. Every editorial route also needs `content:read_drafts`.

- `editorial:comment` (Contributor and above): read threads, start them, and reply.
- `editorial:manage` (Editor and above): resolve, reopen and delete any thread, and delete anyone's comment.

A thread's creator may also resolve and reopen it, and so may the entry's author when they hold `content:edit_own`. A creator may delete their own thread until someone else replies, and only a comment's author may edit it. Storing recomputed anchors needs edit access to the entry and its current `_rev`.

New playground sessions open with example threads on the "Building for the Long Term" post, from a demo reviewer, so visitors can reply, resolve and add their own.

#### Upgrading

A migration adds two tables, `_emdash_editorial_threads` and `_emdash_editorial_comments`. Threads stay while an entry is in the trash, where their comments and threads can still be deleted but not added, edited, resolved or moved, and are deleted with the entry or its collection. Site transfer leaves them out.
