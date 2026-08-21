import type { Messages } from "@lingui/core";

import { DEFAULT_LOCALE } from "./config.js";

const LOCALE_LOADERS = import.meta.glob<{ messages: Messages }>("./**/messages.mjs");

export async function loadMessages(locale: string): Promise<Messages> {
	const key = `./${locale}/messages.mjs`;
	const fallbackKey = `./${DEFAULT_LOCALE}/messages.mjs`;
	const fallbackLoader = LOCALE_LOADERS[fallbackKey];
	if (!fallbackLoader) {
		throw new Error(
			`No locale catalog found for "${locale}" or "${DEFAULT_LOCALE}". Run \`pnpm locale:compile\` to generate catalogs.`,
		);
	}
	const loader = LOCALE_LOADERS[key] ?? fallbackLoader;
	if (loader === fallbackLoader) return (await loader()).messages;
	const [{ messages: fallbackMessages }, { messages }] = await Promise.all([
		fallbackLoader(),
		loader(),
	]);
	return { ...fallbackMessages, ...messages };
}
