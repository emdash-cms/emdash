---
"@emdash-cms/plugin-cli": patch
---

Updates `emdash-plugin profile setup` and `release setup` to ask whether releases require verifiable provenance. Interactive setup pre-fills a repository discovered from Git and defaults to required provenance. Non-interactive runs can select `--provenance required|optional`, and rerunning setup updates the existing signed policy without replacing its repository, approvers, or package metadata.
