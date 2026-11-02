/**
 * Tell users that the site moved to a new address.
 */

import { getLocaleDir } from "@emdash-cms/admin/locales/config";
import type { DomainMoveEmailStrings } from "@emdash-cms/admin/locales/emails";
import { escapeHtml, type EmailMessage } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import type { ApiResult } from "../types.js";

export interface DomainMoveNoticeOptions {
	/** Origin users should sign in at, e.g. `https://example.com`. */
	origin: string;
	strings: DomainMoveEmailStrings;
	locale: string;
	/** The user sending the notice; they are not emailed. */
	senderId: string;
	send: (message: EmailMessage) => Promise<void>;
}

export function buildDomainMoveEmail(
	to: string,
	loginUrl: string,
	strings: DomainMoveEmailStrings,
	locale: string,
): EmailMessage {
	const url = escapeHtml(loginUrl);
	return {
		to,
		subject: strings.subject,
		text: `${strings.intro}\n\n${strings.instruction}\n\n${loginUrl}\n\n${strings.passkeyNote}`,
		html: `
<!DOCTYPE html>
<html lang="${escapeHtml(locale)}" dir="${getLocaleDir(locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 20px;">${escapeHtml(strings.subject)}</h1>
  <p>${escapeHtml(strings.intro)}</p>
  <p>${escapeHtml(strings.instruction)}</p>
  <p style="margin: 30px 0;">
    <a href="${url}" style="background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">${escapeHtml(strings.buttonLabel)}</a>
  </p>
  <p style="color: #666; font-size: 14px;">${escapeHtml(strings.passkeyNote)}</p>
</body>
</html>`,
	};
}

/**
 * Email every active user except the sender a link to the sign-in page at
 * `origin`. The email carries no sign-in token. Sends one email per user,
 * so a failed send for one address doesn't stop the others.
 */
export async function handleDomainMoveNotice(
	db: Kysely<Database>,
	options: DomainMoveNoticeOptions,
): Promise<ApiResult<{ sent: number; failed: number }>> {
	try {
		const users = await db
			.selectFrom("users")
			.select("email")
			.where("disabled", "=", 0)
			.where("id", "!=", options.senderId)
			.execute();

		const loginUrl = new URL("/_emdash/admin/login", options.origin).toString();
		let sent = 0;
		let failed = 0;
		for (const user of users) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- one send at a time keeps email providers within their rate limits
				await options.send(
					buildDomainMoveEmail(user.email, loginUrl, options.strings, options.locale),
				);
				sent++;
			} catch (error) {
				failed++;
				console.error("[domain-move-notice] send failed:", error);
			}
		}
		return { success: true, data: { sent, failed } };
	} catch (error) {
		console.error("[domain-move-notice] failed:", error);
		return {
			success: false,
			error: { code: "DOMAIN_MOVE_NOTICE_ERROR", message: "Failed to email users" },
		};
	}
}
