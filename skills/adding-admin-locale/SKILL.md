---
name: adding-admin-locale
description: Use when adding a new admin UI locale, translating admin strings, or wrapping new components with Lingui macros.
---

# Adding an Admin Locale

The admin UI uses [Lingui](https://lingui.dev) for i18n. Translatable strings are written as English in the source code using macros (`` t`Save` ``, `<Trans>`). The `lingui extract` CLI scans components and generates `.po` catalogs per locale.

Macro compilation is handled automatically — **consumers never need Babel config**.

- **Dev mode**: The emdash integration injects a Vite plugin (`emdash-lingui-macro` in `vite-config.ts`) that compiles macros on the fly via `@babel/core` + `@lingui/babel-plugin-lingui-macro`. This only runs when the admin source is aliased for HMR (monorepo dev).
- **Production build**: tsdown compiles macros via the same Babel plugin (`tsdown.config.ts`). The published npm package has zero macro imports in `dist/`.
- **Catalogs**: `.po` files are compiled to `.mjs` by `lingui compile` in the admin build script. In dev, Vite imports `.po` directly.

## Architecture

```
lingui extract (CLI)
  └─ Scans src/**/*.{ts,tsx} for macros → generates .po catalogs

Macro compilation (automatic — no consumer config needed)
  ├─ Dev mode: emdash Vite plugin (vite-config.ts) → @babel/core transform
  └─ Build: tsdown plugin (tsdown.config.ts) → @babel/core transform

Catalog compilation
  ├─ Dev mode: Vite imports .po directly
  └─ Build: lingui compile → .mjs (in admin build script)

admin.astro (server)
  ├─ resolveLocale(request) — cookie → Accept-Language → 'en' fallback
  ├─ Imports .mjs catalogs via dynamic import
  └─ Passes { locale, messages } as props to React

I18nProvider (client, @lingui/react)
  ├─ Initialized with server-resolved locale + compiled messages
  └─ useLocale().setLocale() dynamically imports new catalog — no page reload

Components
  ├─ useLingui() macro → t`text` for plain strings
  └─ <Trans> for JSX with inline markup
```

## Adding a New Locale

**1. Add the locale to `lingui.config.ts`** (repo root):

```ts
locales: ["en", "fr", "de"], // ← add
```

**2. Run extraction** to generate the new `.po` file:

```bash
pnpm --filter @emdash-cms/admin locale:extract
```

This creates `packages/admin/src/locales/de/messages.po` with all `msgstr` empty.

**3. Enable the locale in the admin UI** — add to `packages/admin/src/locales/config.ts`:

```ts
export const SUPPORTED_LOCALES: SupportedLocale[] = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "Français" },
	{ code: "de", label: "Deutsch" }, // ← add
].filter((l) => validateLocaleCode(l.code));
```

The `label` should be the language's name written in its own script (e.g. "Français" not "French", "עברית" not "Hebrew").

**4. Translate the `.po` file.** Each entry has an English `msgid` and an empty `msgstr`:

```po
msgid "Save"
msgstr "Speichern"

msgid "Dashboard"
msgstr "Armaturenbrett"
```

Use any `.po` editor (Poedit, Crowdin, Weblate) or edit directly. Refresh the browser to see changes — no compile or restart needed in dev.

**5. Before committing**, compile for production:

```bash
pnpm --filter @emdash-cms/admin exec lingui compile --namespace es
```

This creates `messages.mjs` alongside the `.po` — committed as a build artifact for published packages.

## Adding Translatable Strings

**For plain text** — use the `t` tagged template from `useLingui()`:

```tsx
import { useLingui } from "@lingui/react/macro";

function MyComponent() {
	const { t } = useLingui();
	return <h1>{t`Settings`}</h1>;
}
```

**For JSX with inline markup** — use `<Trans>`:

```tsx
import { Trans } from "@lingui/react/macro";

return (
	<p>
		<Trans>
			Read the <a href="/docs">documentation</a> to learn more.
		</Trans>
	</p>
);
```

**With interpolation:**

```tsx
const { t } = useLingui();
const greeting = t`Hello ${name}`;
```

**After adding strings, run extraction:**

```bash
pnpm --filter @emdash-cms/admin locale:extract
```

This updates all `.po` files with the new strings. Existing translations are preserved.

## Key Files

| File                                                 | Purpose                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `lingui.config.ts` (repo root)                       | Lingui config: locales, catalog paths, source scanning        |
| `packages/admin/src/locales/config.ts`               | `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`, `resolveLocale()`      |
| `packages/admin/src/locales/useLocale.ts`            | `useLocale()` hook — client-side locale switching with cookie |
| `packages/admin/src/locales/index.ts`                | Barrel export for locale utilities                            |
| `packages/admin/src/locales/{locale}/messages.po`    | Translation catalogs (gettext `.po` format, source of truth)  |
| `packages/admin/src/locales/{locale}/messages.mjs`   | Pre-compiled JS catalogs (generated, committed)               |
| `packages/core/src/astro/routes/admin.astro`         | Server-side locale resolution and catalog loading             |
| `packages/admin/tsdown.config.ts`                    | Build-time Babel macro transform (Lingui → runtime calls)     |
| `packages/core/src/astro/integration/vite-config.ts` | Dev-time Babel macro transform (Vite plugin for HMR)          |

## Macro Reference

| Macro    | Import                                  | Use for                          |
| -------- | --------------------------------------- | -------------------------------- |
| `t`      | `@lingui/react/macro` via `useLingui()` | Plain strings, attributes, props |
| `Trans`  | `@lingui/react/macro`                   | JSX with inline tags/components  |
| `Plural` | `@lingui/react/macro`                   | Pluralization                    |

All macros are compile-time transforms — they produce optimized `i18n._()` calls at build time via `@lingui/babel-plugin-lingui-macro`.

## Common Mistakes

1. **Using `t()` instead of `` t` ` ``** — Lingui macros use tagged template literals, not function calls. `` t`Save` `` is correct, `t("Save")` will not compile.

2. **Forgetting to add the locale to `config.ts`** — the `.po` file will exist but the locale won't appear in the UI selector.

3. **Adding a locale to `config.ts` but not `lingui.config.ts`** — the UI will show it but no `.po` file will be generated on extract.

4. **Importing from `@lingui/react` instead of `@lingui/react/macro`** — the non-macro version doesn't have the `t` tagged template. Use the `/macro` path.

5. **Forgetting `lingui compile` before committing** — production imports `.mjs`, not `.po`. Run compile before committing new translations.

## Translation Quality

AI-assisted translation is fine, but only into a language that you are fluent in and can proofread. Do not submit machine-translated `.po` files for languages you cannot verify — inaccurate translations are worse than untranslated strings.

## RTL Languages

Hebrew (`he`), Arabic (`ar`), and other RTL locales require additional work beyond this skill — logical CSS properties, icon mirroring, and `dir="rtl"` on the `<html>` element. Open a separate issue before adding an RTL locale.
