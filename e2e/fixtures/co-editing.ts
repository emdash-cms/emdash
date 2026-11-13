import type { BrowserContext } from "@playwright/test";

/**
 * Opens entries in single-editor mode for the rest of the browser session, with an edit lock and
 * autosave `PUT`s, as the admin does once a session's first three WebSockets fail. For specs of
 * single-editor behavior.
 */
export async function pinSingleEditor(context: BrowserContext, baseUrl: string): Promise<void> {
	await context.addCookies([
		{
			name: "emdash-co-editing",
			value: "single=1",
			domain: new URL(baseUrl).hostname,
			path: "/_emdash",
			sameSite: "Lax",
		},
	]);
}
