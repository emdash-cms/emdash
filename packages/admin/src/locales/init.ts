/**
 * Pre-initialize i18n with English locale.
 *
 * This MUST be imported in BOTH:
 * 1. index.ts (client-side entry point)
 * 2. admin.astro (server-side Astro route)
 *
 * This ensures i18n is initialized before any module-level t`...` calls
 * execute, regardless of Astro's island hydration order.
 *
 * We activate with empty messages here; App.tsx will load the real catalog
 * synchronously during render (via useRef). Since t`...` calls in builder
 * functions execute lazily (from useMemo), they'll use the real messages.
 *
 * Side-effect import - modifies global i18n instance.
 */
import { i18n } from "@lingui/core";

if (!i18n.locale) {
	i18n.loadAndActivate({ locale: "en", messages: {} });
}
