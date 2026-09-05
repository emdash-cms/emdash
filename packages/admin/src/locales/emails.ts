/**
 * Localized copy for system emails (invite, magic link / recovery).
 *
 * The email builders live in `@emdash-cms/auth`, which has no i18n
 * machinery — they take final display strings and fall back to English
 * (#915). This module resolves those strings from the admin's Lingui
 * catalogs so the emails follow the site locale like the rest of the
 * admin. It is server-side only (called from EmDash core API routes).
 *
 * The return shapes mirror `InviteEmailStrings` / `MagicLinkEmailStrings`
 * in `@emdash-cms/auth` structurally; the types are duplicated here so
 * the admin package doesn't need a dependency on the auth package.
 */

import { setupI18n, type I18n, type MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { loadMessages } from "./loadMessages.js";

/** Mirrors `InviteEmailStrings` in `@emdash-cms/auth`. */
export interface InviteEmailStrings {
	subject: string;
	textIntro: string;
	textLinkInstruction: string;
	htmlInstruction: string;
	buttonLabel: string;
	expiryNote: string;
}

/** Mirrors `MagicLinkEmailStrings` in `@emdash-cms/auth`. */
export interface MagicLinkEmailStrings {
	subject: string;
	textLinkInstruction: string;
	htmlInstruction: string;
	buttonLabel: string;
	expiryNote: string;
	ignoreNote: string;
}

// Module-scope descriptors (msg) so Lingui extraction picks them up;
// resolved per call with the requested locale's catalog. The {siteName}
// placeholder is ICU MessageFormat, interpolated at resolve time.
const INVITE: Record<keyof InviteEmailStrings, MessageDescriptor> = {
	subject: msg({ message: "You've been invited to {siteName}" }),
	textIntro: msg({ message: "You've been invited to join {siteName}." }),
	textLinkInstruction: msg({ message: "Click this link to create your account:" }),
	htmlInstruction: msg({ message: "Click the button below to create your account:" }),
	buttonLabel: msg({ message: "Accept Invite" }),
	expiryNote: msg({ message: "This link expires in 7 days." }),
};

const MAGIC_LINK: Record<keyof MagicLinkEmailStrings, MessageDescriptor> = {
	subject: msg({ message: "Sign in to {siteName}" }),
	textLinkInstruction: msg({ message: "Click this link to sign in to {siteName}:" }),
	htmlInstruction: msg({ message: "Click the button below to sign in:" }),
	buttonLabel: msg({ message: "Sign in" }),
	expiryNote: msg({ message: "This link expires in 15 minutes." }),
	ignoreNote: msg({ message: "If you didn't request this, you can safely ignore this email." }),
};

/**
 * Build a standalone i18n instance for one resolution. Deliberately not
 * the shared `i18n` singleton — these calls run server-side and must not
 * race with (or reactivate) the admin SPA's active locale.
 */
async function i18nFor(locale: string): Promise<I18n> {
	// loadMessages falls back to the default (English) catalog for
	// unknown locales, so an unconfigured/garbage locale yields English.
	const messages = await loadMessages(locale);
	return setupI18n({ locale, messages: { [locale]: messages } });
}

function resolver(i18n: I18n, siteName: string) {
	return (descriptor: MessageDescriptor): string => i18n._({ ...descriptor, values: { siteName } });
}

/** Localized copy for the invite email, in the given locale. */
export async function getInviteEmailStrings(
	locale: string,
	siteName: string,
): Promise<InviteEmailStrings> {
	const resolve = resolver(await i18nFor(locale), siteName);
	return {
		subject: resolve(INVITE.subject),
		textIntro: resolve(INVITE.textIntro),
		textLinkInstruction: resolve(INVITE.textLinkInstruction),
		htmlInstruction: resolve(INVITE.htmlInstruction),
		buttonLabel: resolve(INVITE.buttonLabel),
		expiryNote: resolve(INVITE.expiryNote),
	};
}

/** Localized copy for the sign-in (magic link / recovery) email. */
export async function getMagicLinkEmailStrings(
	locale: string,
	siteName: string,
): Promise<MagicLinkEmailStrings> {
	const resolve = resolver(await i18nFor(locale), siteName);
	return {
		subject: resolve(MAGIC_LINK.subject),
		textLinkInstruction: resolve(MAGIC_LINK.textLinkInstruction),
		htmlInstruction: resolve(MAGIC_LINK.htmlInstruction),
		buttonLabel: resolve(MAGIC_LINK.buttonLabel),
		expiryNote: resolve(MAGIC_LINK.expiryNote),
		ignoreNote: resolve(MAGIC_LINK.ignoreNote),
	};
}
