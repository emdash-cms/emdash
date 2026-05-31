---
"@emdash-cms/plugin-cli": minor
---

Plugins published to the experimental registry can now ship long-form profile sections. Declare them in `emdash-plugin.jsonc` under a top-level `sections` block with any of `description`, `installation`, `faq`, `changelog`, and `security`. Each value is either inline CommonMark Markdown or a `{ file: "./path.md" }` ref read relative to the manifest at load time. Every section is capped at 20000 bytes and 2000 graphemes, enforced locally (inline strings during schema validation, file refs once their content is read) so `emdash-plugin validate`/`publish` fails with a clear message instead of a 400 from the PDS. File refs are resolved within the manifest directory; paths that escape it (via `..` or an absolute path) are rejected. Sections are profile-level: written to the package profile record on first publish, ignored on subsequent publishes like the other profile fields.
