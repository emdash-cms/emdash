import type { Messages } from "@lingui/core";

const LOCALE_LOADERS = import.meta.glob<{ messages: Messages }>("./**/messages.mjs");

/** Loads a compiled catalog (`lingui compile --namespace es`, run by
 * `console:build`/`console:dev` before this module is ever imported).
 * Returns `{}` rather than throwing when the catalog hasn't been compiled
 * yet — Lingui falls back to the message id, which for this catalog's
 * un-interpolated source strings is the English text itself. */
export async function loadMessages(locale: string): Promise<Messages> {
	const loader = LOCALE_LOADERS[`./${locale}/messages.mjs`];
	if (!loader) return {};
	const { messages } = await loader();
	return messages;
}
