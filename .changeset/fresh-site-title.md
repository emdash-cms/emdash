---
"emdash": patch
---

Fixes auth emails, test emails, domain-change notices, and passkey prompts ignoring the title saved in Settings > General. They now prefer that title, falling back to the title recorded during setup when no Settings title is set. Plugins also receive this title when the runtime initializes; an already-running runtime needs to reload before plugins see a changed title.
