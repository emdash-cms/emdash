/**
 * Invite system for new users
 */

import { generateTokenWithHash, hashToken } from "./tokens.js";
import type { AuthAdapter, RoleLevel, EmailMessage, User } from "./types.js";

/** Escape HTML special characters to prevent injection in email templates */
export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Function that sends an email (matches the EmailPipeline.send signature) */
export type EmailSendFn = (message: EmailMessage) => Promise<void>;

export interface InviteConfig {
	baseUrl: string;
	siteName: string;
	/** Optional email sender. When omitted, invite URL is returned without sending. */
	email?: EmailSendFn;
}

/** Result of creating an invite token (without sending email) */
export interface InviteTokenResult {
	/** The complete invite URL */
	url: string;
	/** The invite email address */
	email: string;
}

/**
 * Create an invite token and URL without sending email.
 *
 * Validates the user doesn't already exist, generates a token, stores it,
 * and returns the invite URL. Callers decide whether to send email or
 * display the URL as a copy-link fallback.
 */
export async function createInviteToken(
	config: Pick<InviteConfig, "baseUrl">,
	adapter: AuthAdapter,
	email: string,
	role: RoleLevel,
	invitedBy: string,
): Promise<InviteTokenResult> {
	// Check if user already exists
	const existing = await adapter.getUserByEmail(email);
	if (existing) {
		throw new InviteError("user_exists", "A user with this email already exists");
	}

	// Generate token
	const { token, hash } = generateTokenWithHash();

	// Store token
	await adapter.createToken({
		hash,
		email,
		type: "invite",
		role,
		invitedBy,
		expiresAt: new Date(Date.now() + TOKEN_EXPIRY_MS),
	});

	// Build invite URL pointing to the admin UI page (not the API endpoint).
	// The admin SPA handles token validation and passkey registration.
	const url = new URL(`${config.baseUrl}/admin/invite/accept`);
	url.searchParams.set("token", token);

	return { url: url.toString(), email };
}

/**
 * Build the invite email message.
 */
function buildInviteEmail(inviteUrl: string, email: string, siteName: string): EmailMessage {
	const safeName = escapeHtml(siteName);
	return {
		to: email,
		subject: `You've been invited to ${siteName}`,
		text: `You've been invited to join ${siteName}.\n\nClick this link to create your account:\n${inviteUrl}\n\nThis link expires in 7 days.`,
		html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 20px;">You've been invited to ${safeName}</h1>
  <p>Click the button below to create your account:</p>
  <p style="margin: 30px 0;">
    <a href="${inviteUrl}" style="background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Accept Invite</a>
  </p>
  <p style="color: #666; font-size: 14px;">This link expires in 7 days.</p>
</body>
</html>`,
	};
}

/**
 * Create and send an invite to a new user.
 *
 * When `config.email` is provided, sends the invite email.
 * When omitted, creates the token and returns the invite URL
 * without sending (for the copy-link fallback).
 */
export async function createInvite(
	config: InviteConfig,
	adapter: AuthAdapter,
	email: string,
	role: RoleLevel,
	invitedBy: string,
): Promise<InviteTokenResult> {
	const result = await createInviteToken(config, adapter, email, role, invitedBy);

	// Send email if a sender is configured
	if (config.email) {
		const message = buildInviteEmail(result.url, email, config.siteName);
		await config.email(message);
	}

	return result;
}

/**
 * Validate an invite token and return the invite data
 */
export async function validateInvite(
	adapter: AuthAdapter,
	token: string,
): Promise<{ email: string; role: RoleLevel }> {
	const hash = hashToken(token);

	const authToken = await adapter.getToken(hash, "invite");
	if (!authToken) {
		throw new InviteError("invalid_token", "Invalid or expired invite link");
	}

	if (authToken.expiresAt < new Date()) {
		await adapter.deleteToken(hash);
		throw new InviteError("token_expired", "This invite has expired");
	}

	if (!authToken.email || authToken.role === null) {
		throw new InviteError("invalid_token", "Invalid invite data");
	}

	return {
		email: authToken.email,
		role: authToken.role,
	};
}

/**
 * Complete the invite process (after passkey registration)
 */
export async function completeInvite(
	adapter: AuthAdapter,
	token: string,
	userData: {
		name?: string;
		avatarUrl?: string;
	},
): Promise<User> {
	const hash = hashToken(token);

	// Validate token one more time
	const authToken = await adapter.getToken(hash, "invite");
	if (!authToken || authToken.expiresAt < new Date()) {
		throw new InviteError("invalid_token", "Invalid or expired invite");
	}

	if (!authToken.email || authToken.role === null) {
		throw new InviteError("invalid_token", "Invalid invite data");
	}

	// Delete token (single-use)
	await adapter.deleteToken(hash);

	// Create user
	const user = await adapter.createUser({
		email: authToken.email,
		name: userData.name,
		avatarUrl: userData.avatarUrl,
		role: authToken.role,
		emailVerified: true, // Email verified by accepting invite
	});

	return user;
}

export class InviteError extends Error {
	constructor(
		public code: "invalid_token" | "token_expired" | "user_exists",
		message: string,
	) {
		super(message);
		this.name = "InviteError";
	}
}
