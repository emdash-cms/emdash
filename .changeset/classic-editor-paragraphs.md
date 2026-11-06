---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes classic-editor posts imported from WordPress arriving as one long paragraph. WordPress stores such posts with blank lines between paragraphs and adds the `<p>` tags only when it displays them, so the importer now starts a new paragraph at each blank line, as WordPress shows the post. A single line break stays a line break within its paragraph, including one right after bold, italic or linked text, where the words on either side used to run together.
