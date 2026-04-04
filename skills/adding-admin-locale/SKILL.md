---
name: adding-admin-locale
description: Use when adding a new admin UI locale, translating admin strings, or adding a new i18n namespace.
---

# Adding an Admin Locale

The admin UI uses a lightweight i18n system with no external dependencies. Translations live in flat JSON files at `packages/admin/src/i18n/locales/{code}/{namespace}.json`. The provider uses `import.meta.glob` to discover them automatically — no code changes needed for new locales or namespaces on the client side.

## Architecture

```
admin.astro (server)
  ├─ Reads emdash-locale cookie → Accept-Language → 'en' fallback
  ├─ Imports all namespace JSONs for the resolved locale
  └─ Serializes { locale, translations } as props to React

I18nProvider (client)
  ├─ Initialized with server-resolved locale + translations
  ├─ import.meta.glob("./locales/*/*.json") discovers all files at build time
  └─ setLocale() dynamically imports new locale JSON — no page reload

Components
  └─ useTranslation("namespace") → t("key") → translated string
```

## Adding a New Locale

**1. Copy an existing locale directory:**

```bash
cp -r packages/admin/src/i18n/locales/en packages/admin/src/i18n/locales/de
```

**2. Translate all JSON files** in the new directory. Keys stay the same, values change:

```json
{
	"common.save": "Speichern",
	"common.cancel": "Abbrechen"
}
```

**3. Register the locale in `packages/admin/src/i18n/config.ts`:**

```ts
export const SUPPORTED_LOCALES: SupportedLocale[] = [
	{ code: validateLocaleCode("en"), label: "English" },
	{ code: validateLocaleCode("fr"), label: "Français" },
	{ code: validateLocaleCode("de"), label: "Deutsch" }, // ← add
];
```

The `validateLocaleCode()` call uses `Intl.Locale` to validate BCP 47 codes at module load time — a typo fails immediately.

**4. That's it.** New locale files are discovered automatically — no other code changes needed.

## Adding a New Namespace

**1. Create the JSON file** in every locale directory:

```bash
# Create for all locales
for locale in packages/admin/src/i18n/locales/*/; do
  echo '{}' > "$locale/myfeature.json"
done
```

**2. Add keys** using the pattern `namespace.key`:

```json
{
	"myfeature.title": "My Feature",
	"myfeature.description": "Does something useful"
}
```

**3. Register in config** — add to `NAMESPACES` in `packages/admin/src/i18n/config.ts`:

```ts
export const NAMESPACES = ["common", "settings", "nav", "myfeature"] as const;
```

Both client and server read from this config — no other files need updating.

**4. Use in components:**

```tsx
const { t } = useTranslation("myfeature");
return <h1>{t("title")}</h1>; // looks up "myfeature.title"
```

## Key Files

| File                                                      | Purpose                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/admin/src/i18n/config.ts`                       | Single source of truth: `SUPPORTED_LOCALES`, `NAMESPACES`, `DEFAULT_LOCALE` |
| `packages/admin/src/i18n/I18nProvider.tsx`                | React context, `useTranslation()` hook, client-side locale switching        |
| `packages/admin/src/i18n/locales/{code}/{namespace}.json` | Translation strings                                                         |
| `packages/core/src/astro/routes/admin.astro`              | Server-side locale resolution and initial translation loading               |

## Translation Key Conventions

- Keys are flat, dot-namespaced: `namespace.key` (e.g., `common.save`, `nav.dashboard`)
- Keys in JSON files include the full namespace prefix
- `useTranslation("namespace")` prepends the namespace, so `t("save")` looks up `"namespace.save"`
- Interpolation uses `{variable}` syntax: `t("greeting", { name: "World" })` with `"common.greeting": "Hello, {name}!"`
- Missing keys fall back to the key itself (visible in UI for debugging)

## Common Mistakes

1. **Forgetting to add the locale to `config.ts`** — the JSON files will exist but the locale won't appear in the selector and won't be validated.

2. **Missing keys in a locale** — if `fr/nav.json` has a key that `de/nav.json` doesn't, the German UI shows the raw key. Copy the English file first, then translate.

3. **Adding a namespace JSON without updating `NAMESPACES` in `config.ts`** — the server won't load it on initial render. `config.ts` is the single source of truth — update it there and both sides pick it up.

## RTL Languages

Hebrew (`he`), Arabic (`ar`), and other RTL locales require additional work beyond this skill — logical CSS properties, icon mirroring, and `dir="rtl"` on the `<html>` element. Open a separate issue before adding an RTL locale.
