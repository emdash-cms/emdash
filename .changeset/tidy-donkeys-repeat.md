---
"@emdash-cms/plugin-forms": patch
---

Fixes the plugin's own field errors never appearing. Native constraint validation blocked the submit event before the plugin's handler could run, so an invalid form showed the browser's default bubble and the `[data-error-for]` spans the template renders stayed empty for the life of the page — leaving any styling or ARIA wiring built around them apparently dead. The client script now turns native validation off as it initialises each form, so its own messages render in those spans. It is set from JavaScript rather than in the markup, so a reader without JavaScript keeps native validation; the plugin applies the same `checkValidity()` rules and the same `validationMessage` text, so nothing about which inputs are considered valid changes.
