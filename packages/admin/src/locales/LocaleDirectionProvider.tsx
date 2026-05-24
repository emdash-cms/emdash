import { DirectionProvider } from "@cloudflare/kumo/primitives";
import * as React from "react";

import { getLocaleDir } from "./config.js";
import { useLocale } from "./useLocale.js";

interface LocaleDirectionProviderProps {
	children: React.ReactNode;
}

/**
 * Wraps the app with DirectionProvider and keeps it in sync with the current locale.
 * Automatically updates direction when locale changes via useLocale.
 */
export function LocaleDirectionProvider({ children }: LocaleDirectionProviderProps) {
	const { locale } = useLocale();
	const dir = React.useMemo(() => getLocaleDir(locale), [locale]);

	/** Sync the direction and lang attributes with the current locale. */
	React.useEffect(() => {
		document.documentElement.setAttribute("lang", locale);
		document.documentElement.setAttribute("dir", dir);
	}, [dir, locale]);

	return <DirectionProvider direction={dir}>{children}</DirectionProvider>;
}
