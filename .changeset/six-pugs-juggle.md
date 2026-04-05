---
"emdash": patch
---

Fix CLI `--json` flag so JSON output is clean. Previously, `consola.success()` and other log messages leaked into stdout alongside the JSON data, making it unparseable by scripts. Log messages now go to stderr when `--json` is set.
