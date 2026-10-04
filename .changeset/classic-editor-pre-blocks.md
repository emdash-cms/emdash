---
"@emdash-cms/gutenberg-to-portable-text": patch
---

Fixes Classic-editor code blocks being imported as paragraph text. A `<pre>` element followed later in the post by a `</p>` was matched as a `<p>`, so the code block was dropped and its content ran into the surrounding paragraph. Imported code blocks now also keep the newlines that Classic content writes as `<br>`, and the language from `<pre><code class="language-...">`.
