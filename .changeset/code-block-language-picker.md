---
"@emdash-cms/admin": minor
"emdash": minor
---

Code blocks in the rich text editor now have an inline language picker. Hover over any code block to reveal a chip in the corner; click it to enter a language (free-form input with curated suggestions for ~30 common languages including TypeScript, Python, Bash, Rust, Astro, SQL, and more). Aliases resolve automatically -- typing `ts` stores `typescript`, `c++` stores `cpp`, etc. The existing markdown shortcut (typing ` ```html ` followed by a space or Enter) continues to pre-populate the language. The chosen language persists on the Portable Text `language` field and is emitted as a `language-{id}` class on the rendered `<pre>` so frontend syntax highlighters can pick it up. The visual (in-place) editor gets the same picker UI.
