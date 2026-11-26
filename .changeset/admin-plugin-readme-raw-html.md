---
"@emdash-cms/admin": patch
---

Fixes plugin README rendering in the admin so HTML written after an unclosed inline `<kbd>`, `<code>`, `<pre>` or `<script>` tag shows as text instead of being rendered. Links in a README always open in a new tab with `rel="noopener noreferrer"`, and links that aren't `http` or `https` render as plain text.
