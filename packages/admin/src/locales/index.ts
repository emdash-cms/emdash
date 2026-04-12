import type { Messages } from "@lingui/core";

import { DEFAULT_LOCALE } from "./config.js";

export { useLocale } from "./useLocale.js";
export {
	SUPPORTED_LOCALES,
	SUPPORTED_LOCALE_CODES,
	DEFAULT_LOCALE,
	getLocaleLabel,
	resolveLocale,
} from "./config.js";
export type { SupportedLocale } from "./config.js";

const LOCALE_LOADERS = import.meta.glob<{ messages: Messages }>("./**/messages.mjs");

export async function loadMessages(locale: string): Promise<Messages> {
	const key = `./${locale}/messages.mjs`;
	const fallbackKey = `./${DEFAULT_LOCALE}/messages.mjs`;
	const loader = LOCALE_LOADERS[key] ?? LOCALE_LOADERS[fallbackKey];
	if (!loader) {
		throw new Error(
			`No locale catalog found for "${locale}" or "${DEFAULT_LOCALE}". Run \`pnpm locale:compile\` to generate catalogs.`,
		);
	}
	const { messages } = await loader();
	return messages;
}
