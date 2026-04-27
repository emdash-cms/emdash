/**
 * Dev Console Email Provider
 *
 * Built-in plugin that registers email:deliver as an exclusive hook.
 * Logs emails to console and stores them in memory (capped at 100).
 * Auto-activated when import.meta.env.DEV is true and no other provider is selected.
 *
 */

import type { EmailDeliverEvent, EmailMessage, PluginContext } from "./types.js";

/** Plugin ID for the dev console email provider */
export const DEV_CONSOLE_EMAIL_PLUGIN_ID = "emdash-console-email";

/** Maximum number of emails to keep in memory */
const MAX_STORED_EMAILS = 100;

/**
 * Stored email record (in-memory only)
 */
export interface StoredEmail {
	message: EmailMessage;
	source: string;
	sentAt: string;
}

/**
 * In-memory store for dev emails.
 * Uses globalThis so the same array is shared across Vite SSR module
 * instances (the runtime and the route handler may load separate copies
 * of this module, but globalThis is always the same object).
 */
const GLOBAL_KEY = Symbol.for("emdash:dev-emails");
const g = globalThis as Record<symbol, unknown>;
const storedEmails: StoredEmail[] = (() => {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- globalThis singleton pattern (see request-context.ts)
	const existing = g[GLOBAL_KEY] as StoredEmail[] | undefined;
	if (existing) return existing;
	const fresh: StoredEmail[] = [];
	g[GLOBAL_KEY] = fresh;
	return fresh;
})();

/**
 * Get all stored dev emails (most recent first).
 */
export function getDevEmails(): StoredEmail[] {
	return storedEmails.toReversed();
}

/**
 * Clear all stored dev emails.
 */
export function clearDevEmails(): void {
	storedEmails.length = 0;
}

/**
 * The email:deliver handler for the dev console provider.
 * Logs to console and stores in memory.
 */
export async function devConsoleEmailDeliver(
	event: EmailDeliverEvent,
	_ctx: PluginContext,
): Promise<void> {
	const { message, source } = event;

	console.log(
		`\n📧 [dev-email] Email sent\n` +
			`   From: ${source}\n` +
			`   To: ${message.to}\n` +
			`   Subject: ${message.subject}\n` +
			`   Text: ${message.text.slice(0, 200)}${message.text.length > 200 ? "..." : ""}\n`,
	);

	// Store the email
	storedEmails.push({
		message,
		source,
		sentAt: new Date().toISOString(),
	});

	// Cap at MAX_STORED_EMAILS
	while (storedEmails.length > MAX_STORED_EMAILS) {
		storedEmails.shift();
	}
}
