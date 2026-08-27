---
"emdash": minor
---

`LiveSearch` now scopes its results to the locale of the page it is used on.

**Behaviour change.** The component reads `Astro.currentLocale` and forwards it as the `locale` query parameter to `/_emdash/api/search` and `/_emdash/api/search/suggest`, which both already filtered on it. Until now the component never sent one, so a translated site got every entry back once per language — a French visitor searching from a French page saw each result twice, the second one opening its English page. Sites with `i18n` configured that relied on searching across every locale will see fewer results than before.

Two ways to opt out: pass an explicit `locale` to search a different one, or `locale={null}` to search across every locale, which is the previous behaviour.

```astro
<!-- results in the page's own locale (new default) -->
<LiveSearch collections={["posts", "pages"]} />

<!-- every locale, as before -->
<LiveSearch collections={["posts", "pages"]} locale={null} />
```

Sites without Astro's `i18n` configured are unaffected: `Astro.currentLocale` is `undefined` there, so no `locale` parameter is sent and the search still spans everything.
