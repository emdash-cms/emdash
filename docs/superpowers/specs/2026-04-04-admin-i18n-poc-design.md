# Admin UI i18n POC — Design Spec

**Date:** 2026-04-04
**Branch:** `fix/visual-editing-field-navigation` (or new branch from `main`)
**Changeset:** `@emdash-cms/admin: minor` — adds i18n infrastructure POC

## Goal

Prove the full i18n loop end-to-end: server reads cookie, loads the right locale JSON, passes it to a React provider, components call `t('common.save')`, and French strings appear. No full string extraction — just enough to validate the architecture.

## Architecture

```
admin.astro (server)
  ├─ Read `emdash-locale` cookie from request headers
  ├─ Fallback: parse Accept-Language → match supported locales → 'en'
  ├─ Safelist check: validate locale against SUPPORTED_LOCALES before import
  ├─ Dynamic import: locales/{safeLocale}/common.json
  └─ Pass { locale, translations } as serialized props to AdminWrapper

PluginRegistry.tsx (bridge)
  └─ Thread locale + translations to AdminApp

App.tsx (React root)
  └─ ThemeProvider
       └─ I18nProvider  ← NEW (wraps everything below)
            └─ Toasty
                 └─ PluginAdminProvider
                      └─ QueryClientProvider
                           └─ RouterProvider

Components call useTranslation() → t('common.save') → "Enregistrer"
```

## Files to Create

### `packages/admin/src/i18n/types.ts`

```ts
/** Flat key-value translation map, namespaced by dot: "common.save" */
export type Translations = Record<string, string>;

export interface I18nConfig {
	locale: string;
	translations: Translations;
}
```

### `packages/admin/src/i18n/I18nProvider.tsx`

- React context holding `I18nConfig`
- `useTranslation(namespace?)` hook returns `{ t, locale }`
- `t(key, vars?)` does:
  1. If namespace provided, prepend it: `t('save')` with namespace `'common'` looks up `'common.save'`
  2. Look up key in translations map
  3. If not found, return the key itself (safe fallback, visible in UI for debugging)
  4. Replace `{variable}` placeholders via simple string replace
- ~20 lines total, no dependencies

### `packages/admin/src/i18n/index.ts`

Barrel export: `I18nProvider`, `useTranslation`, types.

### `packages/admin/src/i18n/locales/en/common.json`

```json
{
	"common.save": "Save",
	"common.saving": "Saving...",
	"common.cancel": "Cancel",
	"common.delete": "Delete",
	"common.deleting": "Deleting...",
	"common.loading": "Loading...",
	"common.close": "Close",
	"common.create": "Create",
	"common.edit": "Edit",
	"common.search": "Search",
	"common.retry": "Retry"
}
```

### `packages/admin/src/i18n/locales/fr/common.json`

Same 11 keys, French translations.

## Files to Modify

### `packages/core/src/astro/routes/admin.astro`

**Frontmatter additions:**

```ts
// Supported locales — safelist for dynamic import
const SUPPORTED_LOCALES = ["en", "fr"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(value: string): value is SupportedLocale {
	return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Parse Accept-Language header and return the first supported locale.
 * Accept-Language is a weighted list: "fr-FR,fr;q=0.9,en;q=0.8"
 * Split on comma, strip q= weights, extract base language, match against supported.
 */
function parseAcceptLanguage(header: string): SupportedLocale | null {
	const candidates = header
		.split(",")
		.map((entry) => entry.split(";")[0].trim())
		.map((tag) => tag.split("-")[0].toLowerCase());

	for (const candidate of candidates) {
		if (isSupportedLocale(candidate)) return candidate;
	}
	return null;
}

// Locale resolution: cookie → Accept-Language → 'en'
const cookieHeader = Astro.request.headers.get("cookie") ?? "";
const cookieMatch = cookieHeader.match(/(?:^|;\s*)emdash-locale=([^;]+)/);
const cookieLocale = cookieMatch?.[1]?.trim() ?? "";

const acceptLang = Astro.request.headers.get("accept-language") ?? "";
const resolvedLocale: SupportedLocale =
	isSupportedLocale(cookieLocale)
		? cookieLocale
		: parseAcceptLanguage(acceptLang) ?? "en";

// Dynamic import with safelist-validated locale
const translations = (await import(`@emdash-cms/admin/i18n/locales/${resolvedLocale}/common.json`)).default;
```

**Template changes:**
- `<html lang="en">` → `<html lang={resolvedLocale}>`
- `<AdminWrapper client:only="react" />` → `<AdminWrapper client:only="react" locale={resolvedLocale} translations={translations} />`

### `packages/core/src/astro/routes/PluginRegistry.tsx`

Thread the new props:

```tsx
import { AdminApp } from "@emdash-cms/admin";
import { pluginAdmins } from "virtual:emdash/admin-registry";
import type { Translations } from "@emdash-cms/admin";

interface Props {
	locale: string;
	translations: Translations;
}

export default function AdminWrapper({ locale, translations }: Props) {
	return <AdminApp pluginAdmins={pluginAdmins} locale={locale} translations={translations} />;
}
```

### `packages/admin/src/App.tsx`

Accept new props, add `I18nProvider`:

```tsx
import { I18nProvider, type Translations } from "./i18n/index.js";

export interface AdminAppProps {
	pluginAdmins?: PluginAdmins;
	locale?: string;
	translations?: Translations;
}

export function AdminApp({
	pluginAdmins = EMPTY_PLUGINS,
	locale = "en",
	translations = {},
}: AdminAppProps) {
	// ...
	return (
		<ThemeProvider>
			<I18nProvider locale={locale} translations={translations}>
				<Toasty>
					<PluginAdminProvider pluginAdmins={pluginAdmins}>
						<QueryClientProvider client={queryClient}>
							<RouterProvider router={router} />
						</QueryClientProvider>
					</PluginAdminProvider>
				</Toasty>
			</I18nProvider>
		</ThemeProvider>
	);
}
```

### `packages/admin/src/components/Header.tsx`

Add locale selector in the user dropdown menu:

- Small `<select>` or list of locale buttons in the dropdown (below "Settings", above "Log out")
- On change: `document.cookie = "emdash-locale={value}; Path=/_emdash; SameSite=Lax; Max-Age=31536000"` + `window.location.reload()`
- In production, add `; Secure` to the cookie string (check `window.location.protocol === 'https:'`)
- Read current locale from `useTranslation()` to show the active selection
- Supported locales list: hardcoded `["en", "fr"]` for POC (future: passed via manifest)

### `packages/admin/src/components/ConfirmDialog.tsx`

Replace hardcoded `"Cancel"` with `t('common.cancel')`:

```tsx
const { t } = useTranslation('common');
// ...
<Button>{t('cancel')}</Button>
```

### `packages/admin/src/components/SaveButton.tsx`

Replace `"Save"` / `"Saving..."` / `"Saved"` with `t()` calls.

## Cookie Spec

| Attribute | Value |
|-----------|-------|
| Name | `emdash-locale` |
| Path | `/_emdash` |
| SameSite | `Lax` |
| Max-Age | `31536000` (1 year) |
| HttpOnly | No (JS read/write required) |
| Secure | Yes in production, No in dev |

## Admin Package Exports

The admin package currently only exports `"."` and `"./styles.css"`. Two additions needed:

**1. Export the i18n module** (types + provider + hook):

Add `"./i18n"` to the `exports` map in `package.json` pointing to `dist/i18n/index.js`. This lets `PluginRegistry.tsx` (in core) import `Translations` type.

**2. Export locale JSON files** for server-side loading:

Add `"./i18n/locales/*"` to the `exports` map as a wildcard pattern, so `admin.astro` can do `import(...locales/${locale}/common.json)`. Alternatively, the locale files could live in `packages/core/src/astro/routes/` alongside `admin.astro` — simpler but less clean for future locale additions. The implementation plan should pick one approach.

Public API additions:
- `Translations` type
- `I18nProvider` (exported for testing)
- `useTranslation` hook

## Proof Points

After implementation, switching to French via the Header dropdown should cause:

1. Every `ConfirmDialog` "Cancel" button → "Annuler"
2. Every `SaveButton` "Save" → "Enregistrer", "Saving..." → "Enregistrement..."
3. The `<html lang>` attribute → `"fr"`
4. Page reload picks up the cookie on next request

## Out of Scope

- Full string extraction (~750 keys across ~65 files)
- `TranslationKey` codegen for type safety
- RTL layout support
- `Intl.DateTimeFormat` / `Intl.NumberFormat` locale threading
- Plugin translation registration (interface designed for it via namespace arg, not wired)
- Pluralization helper
- `useLocale()` hook for Intl APIs
