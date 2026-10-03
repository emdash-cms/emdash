---
"emdash": patch
---

Fixes `emdash seed --no-content` applying the seed's content entries, bylines, and taxonomy terms anyway. The flag now skips them as documented, so combining it with `--on-conflict update` no longer overwrites existing entries.

#### What should I do?

If a script uses the undocumented `--noContent` spelling, switch it to `--no-content` or `--content=false`. `--noContent` was the only spelling that skipped content before this release. It is now ignored without an error, so the command applies the seed's content.
