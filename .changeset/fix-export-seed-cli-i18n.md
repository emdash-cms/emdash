---
"emdash": patch
---

Fix `emdash export-seed` collapsing locale variants into duplicate seed ids on i18n projects. The CLI never initializes the runtime i18n config, so `isI18nEnabled()` was always `false` and the exporter stripped the `:locale` suffix from taxonomy, menu, and content seed ids — merging every locale variant into one bare id and producing duplicates that `validateSeed` rejected. The exporter now derives locale-awareness from the data (a project is multi-locale when its i18n-aware tables hold more than one distinct locale), so multi-locale exports keep their per-locale suffixes and `translationOf` links while genuinely single-locale projects still export bare ids.
