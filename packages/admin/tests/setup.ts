import { i18n } from "@lingui/core";
import "vitest-browser-react";

if (!i18n.locale) {
	i18n.loadAndActivate({ locale: "en", messages: {} });
}
