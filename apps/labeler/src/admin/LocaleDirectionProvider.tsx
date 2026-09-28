import { DirectionProvider } from "@cloudflare/kumo/primitives";
import React from "react";

const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur"]);

export function LocaleDirectionProvider({
	locale,
	children,
}: {
	locale: string;
	children: React.ReactNode;
}) {
	const language = locale.split("-", 1)[0]?.toLowerCase() ?? "en";
	const direction = RTL_LANGUAGES.has(language) ? "rtl" : "ltr";

	React.useEffect(() => {
		document.documentElement.lang = locale;
		document.documentElement.dir = direction;
	}, [direction, locale]);

	return <DirectionProvider direction={direction}>{children}</DirectionProvider>;
}
