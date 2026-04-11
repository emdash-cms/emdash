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
 * Side-effect import - modifies global i18n instance.
 */
import { i18n } from "@lingui/core";

import { messages } from "./en/messages.mjs";

if (!i18n.locale) {
	i18n.loadAndActivate({ locale: "en", messages });
}
