---
"@emdash-cms/plugin-cli": minor
---

Improves package-profile and release publishing output: commands use the `@handle/slug` registry identifier, link to the eventual public plugin page, and let `info --version <version> --watch` track effective label checks without exposing unapproved aggregator metadata. Missing manifests point to the plugin directory, GitHub repository prompts use a detected `origin` remote, setup failures omit stack traces, and a published profile shows both manual and GitHub Actions release commands.
