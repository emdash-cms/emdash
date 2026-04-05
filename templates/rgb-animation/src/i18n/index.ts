import { ja } from './ja';
import { en } from './en';

export type Locale = 'ja' | 'en';
export type TranslationKeys = typeof ja;
export type TranslationKey = keyof TranslationKeys;

const translations: Record<Locale, Record<TranslationKey, string>> = {
  ja,
  en,
};

/**
 * Get a translated string by key.
 * Supports simple interpolation: t(locale, 'footer.copyright', { year: '2026' })
 */
export function t(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string>,
): string {
  const value = translations[locale]?.[key] ?? translations.ja[key] ?? key;

  if (!params) return value;

  return Object.entries(params).reduce(
    (result, [paramKey, paramValue]) =>
      result.replace(`{${paramKey}}`, paramValue),
    value,
  );
}

/**
 * Detect locale from URL pathname.
 * /en/... → 'en', everything else → 'ja'
 */
export function getLocaleFromUrl(url: URL): Locale {
  const [, segment] = url.pathname.split('/');
  if (segment === 'en') return 'en';
  return 'ja';
}

/**
 * Generate localized path.
 * getLocalizedPath('/company', 'en') → '/en/company'
 * getLocalizedPath('/company', 'ja') → '/company'
 */
export function getLocalizedPath(path: string, locale: Locale): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (locale === 'en') return `/en${cleanPath}`;
  return cleanPath;
}

/**
 * Get the alternate locale (for language switcher).
 */
export function getAlternateLocale(locale: Locale): Locale {
  return locale === 'ja' ? 'en' : 'ja';
}

/**
 * Get the alternate path (for language switcher link).
 */
export function getAlternatePath(url: URL): string {
  const pathname = url.pathname;
  if (pathname.startsWith('/en/') || pathname === '/en') {
    // English → Japanese: strip /en prefix
    const jaPath = pathname.replace(/^\/en/, '') || '/';
    return jaPath;
  }
  // Japanese → English: add /en prefix
  return `/en${pathname}`;
}
