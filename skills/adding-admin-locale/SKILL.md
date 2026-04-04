---
name: adding-admin-locale
description: Use when adding a new admin UI locale, translating admin strings, or adding a new i18n namespace.
---

# Adding an Admin Locale

The admin UI uses a lightweight i18n system with no external dependencies. Translations live in flat JSON files at `packages/admin/src/i18n/locales/{code}/{namespace}.json`. The provider uses `import.meta.glob` to discover them automatically — no code changes needed for new locales on the client side.

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

Type safety
  ├─ locales/en/index.ts barrel exports all default-locale JSONs
  ├─ types.ts derives Namespace type + TranslationKeyMap from the barrel
  └─ useTranslation("ns") → t("key") is type-checked against JSON keys

Components
  └─ useTranslation("namespace") → t("key") → translated string (type-safe)
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
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
	{ code: "de", label: "Deutsch" }, // ← add
].filter((l) => validateLocaleCode(l.code));
```

The `filter` + `validateLocaleCode()` call uses `Intl.Locale` to validate BCP 47 codes at module load time — invalid codes are silently dropped (with a thrown error in dev mode).

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

**3. Add to the default locale barrel** — `packages/admin/src/i18n/locales/en/index.ts`:

```ts
export { default as common } from "./common.json";
export { default as nav } from "./nav.json";
export { default as settings } from "./settings.json";
export { default as myfeature } from "./myfeature.json"; // ← add
```

This is the only registration step. `NAMESPACES` and the `Namespace` type are derived from this barrel automatically — both the runtime array and the TypeScript types.

**4. Use in components:**

```tsx
const { t } = useTranslation("myfeature");
return <h1>{t("title")}</h1>; // looks up "myfeature.title" — type-checked!
```

`t()` only accepts keys that exist in the default locale's JSON for that namespace. Passing an invalid key is a compile-time error.

## Key Files

| File                                                      | Purpose                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/admin/src/i18n/config.ts`                       | `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`, locale validation                 |
| `packages/admin/src/i18n/types.ts`                        | `Namespace`, `NAMESPACES`, `TranslationKeyMap` — all derived from barrel |
| `packages/admin/src/i18n/locales/en/index.ts`             | Barrel export — source of truth for namespaces and type-safe keys        |
| `packages/admin/src/i18n/I18nProvider.tsx`                | React context, `useTranslation()` hook, client-side locale switching     |
| `packages/admin/src/i18n/locales/{code}/{namespace}.json` | Translation strings                                                      |
| `packages/core/src/astro/routes/admin.astro`              | Server-side locale resolution and initial translation loading            |

## Translation Key Conventions

- Keys are flat, dot-namespaced: `namespace.key` (e.g., `common.save`, `nav.dashboard`)
- Keys in JSON files include the full namespace prefix
- `useTranslation("namespace")` prepends the namespace, so `t("save")` looks up `"namespace.save"`
- `t()` is type-safe: only keys from the default locale's JSON are accepted
- Interpolation uses `{variable}` syntax: `t("greeting", { name: "World" })` with `"common.greeting": "Hello, {name}!"`
- Missing keys fall back to the key itself (visible in UI for debugging)

## Common Mistakes

1. **Forgetting to add the locale to `config.ts`** — the JSON files will exist but the locale won't appear in the selector and won't be validated.

2. **Missing keys in a locale** — if `fr/nav.json` has a key that `de/nav.json` doesn't, the German UI shows the raw key. Copy the English file first, then translate.

3. **Adding a namespace JSON without updating the barrel** — the namespace won't be typed and `NAMESPACES` won't include it. Always add the `export { default as ... }` line to `locales/en/index.ts`.

## RTL Languages

Hebrew (`he`), Arabic (`ar`), and other RTL locales require additional work beyond this skill — logical CSS properties, icon mirroring, and `dir="rtl"` on the `<html>` element. Open a separate issue before adding an RTL locale.
