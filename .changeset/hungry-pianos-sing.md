---
"@emdash-cms/plugin-forms": patch
---

Fixes duplicate element IDs when the same form is embedded more than once on a page. Field IDs were built from the form ID and the field name alone, so a form appearing in, say, a sidebar and a pop-up produced several elements sharing an ID: clicking a label focused the first copy rather than the one beside it, and anything resolving an ID — `aria-describedby`, a password manager, a test selector — reached the wrong instance. Each rendering now suffixes its IDs with a per-instance value, so labels, inputs and the honeypot stay paired within their own copy. Element IDs are not part of the plugin's API and nothing else references them; the client script scopes its lookups to the form element.
