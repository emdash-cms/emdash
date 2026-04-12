/**
 * Pre-initialize i18n with English locale.
 *
 * Activates i18n with empty messages; App.tsx loads the real catalog
 * synchronously during render. Module-level t`...` calls in builder
 * functions execute lazily (from useMemo) and use the real messages.
 *
 * Side-effect import - modifies global i18n instance.
 */
import { i18n } from "@lingui/core";

if (!i18n.locale) {
	i18n.loadAndActivate({ locale: "en", messages: {} });
}
