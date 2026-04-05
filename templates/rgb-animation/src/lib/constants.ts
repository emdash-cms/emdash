import type { TranslationKey } from '@/i18n';

export const SITE_NAME = 'RGB Animation';
export const SITE_URL = 'https://rgb-animation.com';
export const DEFAULT_LOCALE = 'ja' as const;
export const SUPPORTED_LOCALES = ['ja', 'en'] as const;

interface NavItem {
  readonly key: TranslationKey;
  readonly href: string;
}

export const NAV_CATEGORIES: readonly NavItem[] = [
  { key: 'nav.film', href: '/works/film' },
  { key: 'nav.game', href: '/works/game' },
  { key: 'nav.video', href: '/works/video' },
  { key: 'nav.background', href: '/works/background' },
  { key: 'nav.character', href: '/works/character' },
  { key: 'nav.tvc', href: '/works/tvc' },
] as const;

export const NAV_SECONDARY: readonly NavItem[] = [
  { key: 'nav.store', href: '/store' },
  { key: 'nav.recruit', href: '/recruit' },
  { key: 'nav.contact', href: '/contact' },
] as const;
