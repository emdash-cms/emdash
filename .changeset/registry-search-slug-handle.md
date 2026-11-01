---
"@emdash-cms/registry-lexicons": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/registry-loader": patch
---

Updates the registry search descriptions in the `searchPackages` lexicon, the `emdash-plugin search` help, and `RegistryCollectionFilter.q`: search also matches a package's slug and its publisher's handle without the domain ending (`meekmedia` for `meekmedia.bsky.social`), and matches the last word as a prefix.
