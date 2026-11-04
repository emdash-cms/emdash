import { defineMiddleware } from "astro:middleware";

// Manual i18n routing requires a middleware file; the fixture's `[locale]`
// routes handle locale prefixes themselves.
export const onRequest = defineMiddleware((_context, next) => next());
