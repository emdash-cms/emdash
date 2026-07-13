import { DirectionProvider } from "@cloudflare/kumo/primitives";
import * as React from "react";

import { DEFAULT_LOCALE, getLocaleDir } from "./config.js";

interface LocaleDirectionProviderProps {
	children: React.ReactNode;
}

/**
 * Wraps the app with DirectionProvider and keeps `<html>` in sync with the
 * active locale. Only "en" ships today, but reads direction from the same
 * `getLocaleDir` lookup packages/admin uses so adding an RTL locale later
 * doesn't require touching this component.
 */
export function LocaleDirectionProvider({ children }: LocaleDirectionProviderProps) {
	const dir = React.useMemo(() => getLocaleDir(DEFAULT_LOCALE), []);

	React.useEffect(() => {
		document.documentElement.setAttribute("lang", DEFAULT_LOCALE);
		document.documentElement.setAttribute("dir", dir);
	}, [dir]);

	return <DirectionProvider direction={dir}>{children}</DirectionProvider>;
}
