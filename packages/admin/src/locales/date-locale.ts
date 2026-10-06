import { useLingui } from "@lingui/react";
import * as React from "react";
import type { DayPickerLocale } from "react-day-picker/locale";
import { enUS } from "react-day-picker/locale/en-US";

import { LOCALES } from "./locales.js";

const loadedDateLocales = new Map<string, DayPickerLocale>();

/**
 * The date locale for an admin locale if it is available without loading:
 * US English for locales without a `dateLocale`, otherwise a previously loaded
 * one.
 */
export function getLoadedDateLocale(code: string): DayPickerLocale | undefined {
	const definition = LOCALES.find((locale) => locale.code === code);
	if (!definition?.dateLocale) return enUS;
	return loadedDateLocales.get(code);
}

/** Loads the date locale for an admin locale, falling back to US English. */
export async function loadDateLocale(code: string): Promise<DayPickerLocale> {
	const loaded = getLoadedDateLocale(code);
	if (loaded) return loaded;
	try {
		const dateLocale = await LOCALES.find((locale) => locale.code === code)!.dateLocale!();
		loadedDateLocales.set(code, dateLocale);
		return dateLocale;
	} catch {
		return enUS;
	}
}

/**
 * The date locale for the active admin locale. The admin loads it before
 * rendering and before switching locale, so this normally returns it
 * immediately; otherwise it returns US English until the load finishes.
 */
export function useDateLocale(): DayPickerLocale {
	const { i18n } = useLingui();
	const code = i18n.locale;
	const loaded = getLoadedDateLocale(code);
	const [, rerender] = React.useReducer((count: number) => count + 1, 0);

	React.useEffect(() => {
		if (loaded) return;
		let active = true;
		void (async () => {
			await loadDateLocale(code);
			if (active) rerender();
		})();
		return () => {
			active = false;
		};
	}, [code, loaded]);

	return loaded ?? enUS;
}
