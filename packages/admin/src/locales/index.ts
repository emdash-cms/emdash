export { useLocale } from "./useLocale.js";
export {
	SUPPORTED_LOCALES,
	SUPPORTED_LOCALE_CODES,
	DEFAULT_LOCALE,
	getLocaleLabel,
	resolveLocale,
} from "./config.js";
export type { SupportedLocale } from "./config.js";

const LOCALE_LOADERS = import.meta.glob<{ messages: Record<string, unknown> }>("./**/messages.mjs");

export async function loadMessages(locale: string): Promise<Record<string, unknown>> {
	const key = `./${locale}/messages.mjs`;
	const loader = LOCALE_LOADERS[key] ?? LOCALE_LOADERS["./en/messages.mjs"]!;
	const { messages } = await loader();
	return messages;
}
