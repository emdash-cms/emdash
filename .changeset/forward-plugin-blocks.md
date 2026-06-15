---
"emdash": minor
---

Forward declarative `portableTextBlocks` and `fieldWidgets` from standard and sandboxed plugins

Standard- and sandboxed-format plugins could already declare admin pages and dashboard widgets, but their declarative Portable Text block types and field widgets were dropped during adaptation — only native-format plugins surfaced them. Since the admin editor reads these from the manifest, the slash-menu entries and Block Kit forms never appeared for non-native plugins.

`adaptSandboxEntry` now forwards both, and the admin manifest is emitted for sandboxed and marketplace plugins too, so a plugin of any format can contribute Portable Text blocks and field widgets. The site-side render component (`componentsEntry`) still requires native format, which is unchanged.
