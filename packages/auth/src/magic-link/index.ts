/**
 * Magic link authentication
 */

import { escapeHtml } from "../invite.js";
import { generateTokenWithHash, hashToken } from "../tokens.js";
import type { AuthAdapter, User, EmailMessage } from "../types.js";

const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/** Function that sends an email (matches the EmailPipeline.send signature) */
export type EmailSendFn = (message: EmailMessage) => Promise<void>;

export interface MagicLinkConfig {
	baseUrl: string;
	siteName: string;
	/** Optional email sender. When omitted, magic links cannot be sent. */
	email?: EmailSendFn;
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
	const safeName = escapeHtml(config.siteName);
	await config.email({
		to: user.email,
		subject: `Sign in to ${config.siteName}`,
		text: `Click this link to sign in to ${config.siteName}:\n\n${url.toString()}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
		html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 20px;">Sign in to ${safeName}</h1>
  <p>Click the button below to sign in:</p>
  <p style="margin: 30px 0;">
    <a href="${url.toString()}" style="background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Sign in</a>
  </p>
  <p style="color: #666; font-size: 14px;">This link expires in 15 minutes.</p>
  <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
</body>
</html>`,
	});
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
