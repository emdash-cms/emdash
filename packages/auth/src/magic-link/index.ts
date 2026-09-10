/**
 * Magic link authentication
 */

import { escapeHtml, localeDir } from "../invite.js";
import { generateTokenWithHash, hashToken } from "../tokens.js";
import type { AuthAdapter, User, EmailMessage } from "../types.js";

const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/** Function that sends an email (matches the EmailPipeline.send signature) */
export type EmailSendFn = (message: EmailMessage) => Promise<void>;

/**
 * Localized copy for the sign-in (magic link / recovery) email (#915).
 *
 * Final display strings, interpolated by the caller — same contract as
 * `InviteEmailStrings` in invite.ts. English fallback when omitted.
 */
export interface MagicLinkEmailStrings {
	/** Subject line, e.g. `Sign in to Acme` */
	subject: string;
	/** Plain-text instruction above the raw link, e.g. `Click this link to sign in to Acme:` */
	textLinkInstruction: string;
	/** HTML instruction above the button */
	htmlInstruction: string;
	/** Button label */
	buttonLabel: string;
	/** Expiry note, e.g. `This link expires in 15 minutes.` */
	expiryNote: string;
	/** Unsolicited-email note, e.g. `If you didn't request this, you can safely ignore this email.` */
	ignoreNote: string;
}

export interface MagicLinkConfig {
	baseUrl: string;
	siteName: string;
	/** Optional email sender. When omitted, magic links cannot be sent. */
	email?: EmailSendFn;
	/** Optional localized email copy. English when omitted. */
	emailStrings?: MagicLinkEmailStrings;
	/** Optional BCP 47 locale of the copy; sets lang/dir on the email HTML for RTL. */
	emailLocale?: string;
}

/**
 * Add artificial delay with jitter to prevent timing attacks.
 * Range approximates the time for token creation + email send.
 */
async function timingDelay(): Promise<void> {
	const delay = 100 + Math.random() * 150; // 100-250ms
	await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Send a magic link to a user's email.
 *
 * Requires `config.email` to be set. Throws if no email sender is configured.
 */
export async function sendMagicLink(
	config: MagicLinkConfig,
	adapter: AuthAdapter,
	email: string,
	type: "magic_link" | "recovery" = "magic_link",
): Promise<void> {
	if (!config.email) {
		throw new MagicLinkError("email_not_configured", "Email is not configured");
	}

	// Find user
	const user = await adapter.getUserByEmail(email);
	if (!user) {
		// Don't reveal whether user exists - add delay to match successful path timing
		await timingDelay();
		return;
	}

	// Generate token
	const { token, hash } = generateTokenWithHash();

	// Store token hash
	await adapter.createToken({
		hash,
		userId: user.id,
		email: user.email,
		type,
		expiresAt: new Date(Date.now() + TOKEN_EXPIRY_MS),
	});

	// Build magic link URL
	const url = new URL("/_emdash/api/auth/magic-link/verify", config.baseUrl);
	url.searchParams.set("token", token);

	// Send email
	const message = buildMagicLinkEmail(
		url.toString(),
		user.email,
		config.siteName,
		config.emailStrings,
		config.emailLocale,
	);
	await config.email(message);
}

/** English fallback copy for the sign-in email. */
function defaultMagicLinkEmailStrings(siteName: string): MagicLinkEmailStrings {
	return {
		subject: `Sign in to ${siteName}`,
		textLinkInstruction: `Click this link to sign in to ${siteName}:`,
		htmlInstruction: "Click the button below to sign in:",
		buttonLabel: "Sign in",
		expiryNote: "This link expires in 15 minutes.",
		ignoreNote: "If you didn't request this, you can safely ignore this email.",
	};
}

/**
 * Build the sign-in (magic link / recovery) email message.
 *
 * Exported for tests; localized copy is injected via `strings` (#915).
 */
export function buildMagicLinkEmail(
	linkUrl: string,
	email: string,
	siteName: string,
	strings?: MagicLinkEmailStrings,
	locale?: string,
): EmailMessage {
	const s = strings ?? defaultMagicLinkEmailStrings(siteName);
	// Localized copy may be RTL — set lang/dir on the root so RTL text renders
	// correctly. Defaults to ltr when no locale is threaded through (#915).
	const langAttr = locale ? ` lang="${escapeHtml(locale)}" dir="${localeDir(locale)}"` : "";
	return {
		to: email,
		subject: s.subject,
		text: `${s.textLinkInstruction}\n\n${linkUrl}\n\n${s.expiryNote}\n\n${s.ignoreNote}`,
		html: `
<!DOCTYPE html>
<html${langAttr}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 20px;">${escapeHtml(s.subject)}</h1>
  <p>${escapeHtml(s.htmlInstruction)}</p>
  <p style="margin: 30px 0;">
    <a href="${linkUrl}" style="background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">${escapeHtml(s.buttonLabel)}</a>
  </p>
  <p style="color: #666; font-size: 14px;">${escapeHtml(s.expiryNote)}</p>
  <p style="color: #666; font-size: 14px;">${escapeHtml(s.ignoreNote)}</p>
</body>
</html>`,
	};
}

/**
 * Verify a magic link token and return the user
 */
export async function verifyMagicLink(adapter: AuthAdapter, token: string): Promise<User> {
	const hash = hashToken(token);

	// Find and validate token
	const authToken = await adapter.getToken(hash, "magic_link");
	if (!authToken) {
		// Also check for recovery tokens
		const recoveryToken = await adapter.getToken(hash, "recovery");
		if (!recoveryToken) {
			throw new MagicLinkError("invalid_token", "Invalid or expired link");
		}
		return verifyTokenAndGetUser(adapter, recoveryToken, hash);
	}

	return verifyTokenAndGetUser(adapter, authToken, hash);
}

async function verifyTokenAndGetUser(
	adapter: AuthAdapter,
	authToken: { userId: string | null; expiresAt: Date },
	hash: string,
): Promise<User> {
	// Check expiry
	if (authToken.expiresAt < new Date()) {
		await adapter.deleteToken(hash);
		throw new MagicLinkError("token_expired", "This link has expired");
	}

	// Delete token (single-use)
	await adapter.deleteToken(hash);

	// Get user
	if (!authToken.userId) {
		throw new MagicLinkError("invalid_token", "Invalid token");
	}

	const user = await adapter.getUserById(authToken.userId);
	if (!user) {
		throw new MagicLinkError("user_not_found", "User not found");
	}

	return user;
}

export class MagicLinkError extends Error {
	constructor(
		public code: "invalid_token" | "token_expired" | "user_not_found" | "email_not_configured",
		message: string,
	) {
		super(message);
		this.name = "MagicLinkError";
	}
}
