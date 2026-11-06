---
"emdash": minor
"@emdash-cms/auth": minor
"@emdash-cms/admin": minor
---

Adds editorial comments: threads that staff leave on an entry while reviewing it, separate from the public comments visitors post.

A thread points at the whole entry, a field, a Portable Text block, or a range of text in a block, and holds a conversation that can be resolved and reopened. Threads are private to staff and never appear on the site.

In the entry editor, select text and choose **Comment** in the formatting toolbar, or press ⌘⌥M (Ctrl+Alt+M), to start a thread beside it. The **Comments** button at the end of the editor bar shows or hides the margin and counts open threads. Commented text stays highlighted as you edit, and a thread whose text was deleted is listed as detached with the text it referred to. Links of the form `?thread=<id>` open the editor with that thread selected.

The API lives under each entry, at `/_emdash/api/content/{collection}/{id}/threads`, with routes to list and start threads, reply, edit and delete comments, resolve and reopen threads, and store anchors after the entry's content changes. Each thread and comment in a response carries `can` flags that say what the caller may do with it.

#### Permissions

Two permissions are new in `@emdash-cms/auth`. Every editorial route also needs `content:read_drafts`.

- `editorial:comment` (Contributor and above): read threads, start them, and reply.
- `editorial:manage` (Editor and above): resolve, reopen and delete any thread, and delete anyone's comment.

A thread's creator and the entry's author may also resolve and reopen it. A creator may delete their own thread until someone else replies, and only a comment's author may edit it.

#### Upgrading

A migration adds two tables, `_emdash_editorial_threads` and `_emdash_editorial_comments`. Threads stay while an entry is in the trash, and are deleted with the entry or its collection. Site transfer leaves them out.
