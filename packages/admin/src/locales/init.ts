/**
 * Pre-initialize i18n with English locale.
 * 
 * This MUST be imported first in index.ts to ensure i18n is ready
 * before any other module executes module-level t`...` calls.
 * 
 * Side-effect import - modifies global i18n instance.
 */
import { i18n } from "@lingui/core";
import { messages } from "./en/messages.mjs";

if (!i18n.locale) {
	i18n.loadAndActivate({ locale: "en", messages });
}
