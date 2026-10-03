---
"emdash": patch
"@emdash-cms/admin": patch
---

Registry plugin version sync now fails visible instead of silent. A stored bundle's `requires` is re-checked at load time (both the post-install sync and cold start): a plugin whose constraints exclude the running host is skipped instead of executed, and the admin plugin list shows it as "incompatible with host" with the unsatisfied ranges. The signed release record's `requires` is persisted into the stored bundle manifest at install/update time (publisher-authored bundle bytes are never authoritative for it), so the check has teeth after a core upgrade. The registry update check applies the same environment gate: an update the host cannot run is annotated as incompatible instead of being offered. Known limitation: the marketplace update check does not yet apply the same gate.
