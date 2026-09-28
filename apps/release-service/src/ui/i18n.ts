import { i18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { useLingui } from "@lingui/react";
import { useCallback } from "react";

const RTL_LOCALES = new Set(["ar", "fa", "he", "ur"]);
const requestedLocale = new URLSearchParams(globalThis.location?.search ?? "").get("locale");
const locale = requestedLocale || globalThis.navigator?.language?.split("-")[0] || "en";

i18n.setMessagesCompiler(compileMessage);

export function applyLocale(value: string): void {
	i18n.load(value, {});
	i18n.activate(value);
	document.documentElement.lang = value;
	document.documentElement.dir = RTL_LOCALES.has(value) ? "rtl" : "ltr";
}

applyLocale(locale);

export { i18n };

export function useT() {
	const { i18n: activeI18n } = useLingui();
	return useCallback(
		(id: string, message: string, values?: Record<string, string | number>) =>
			activeI18n._(id, values, { message }),
		[activeI18n],
	);
}
