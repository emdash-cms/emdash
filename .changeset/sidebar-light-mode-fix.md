---
"@emdash-cms/admin": patch
---

Fix admin sidebar rendering white text on a light background in light mode. Kumo 2.4 moved the sidebar surface to an inner container painted with `bg-(--sidebar-bg)`, where `--sidebar-bg` is resolved from the wrapper's default (light) `--color-kumo-base`. The sidebar's dark-chrome override only set `--color-kumo-base`, which no longer reaches that surface, so the dark background was lost while the white text remained. The override now sets `--sidebar-bg` directly.
