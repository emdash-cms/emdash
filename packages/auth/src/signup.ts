/**
 * Self-signup for allowed email domains
 */

import { escapeHtml } from "./invite.js";
import { generateTokenWithHash, hashToken } from "./tokens.js";
import type { AuthAdapter, RoleLevel, EmailMessage, User } from "./types.js";
import { buildAuthUrl } from "./urls.js";

const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/** Function that sends an email (matches the EmailPipeline.send signature) */
export type EmailSendFn = (message: EmailMessage) => Promise<void>;

/**
 * Add artificial delay with jitter to prevent timing attacks.
 * Range approximates the time for token creation + email send.
 */
async function timingDelay(): Promise<void> {
	const delay = 100 + Math.random() * 150; // 100-250ms
	await new Promise((resolve) => setTimeout(resolve, delay));
}

export interface SignupConfig {
	baseUrl: string;
	siteName: string;
	/** Optional email sender. When omitted, signup verification cannot be sent. */
	email?: EmailSendFn;
}

/**
 * Check if an email domain is allowed for self-signup
 */
export async function canSignup(
	adapter: AuthAdapter,
	email: string,
): Promise<{ allowed: boolean; role: RoleLevel } | null> {
	const domain = email.split("@")[1]?.toLowerCase();
	if (!domain) return null;

	const allowedDomain = await adapter.getAllowedDomain(domain);
	if (!allowedDomain || !allowedDomain.enabled) {
		return null;
	}

	return {
		allowed: true,
		role: allowedDomain.defaultRole,
	};
}

/**
 * Request self-signup (sends verification email).
 *
 * Requires `config.email` to be set. Throws if no email sender is configured.
 */
export async function requestSignup(
	config: SignupConfig,
	adapter: AuthAdapter,
	email: string,
): Promise<void> {
	if (!config.email) {
		throw new SignupError("email_not_configured", "Email is not configured");
	}

	// Check if user already exists
	const existing = await adapter.getUserByEmail(email);
	if (existing) {
		// Don't reveal that user exists - add delay to match successful path timing
		await timingDelay();
		return;
	}

	// Check if domain is allowed
	const signup = await canSignup(adapter, email);
	if (!signup) {
		// Don't reveal that domain is not allowed - add delay to match successful path timing
		await timingDelay();
		return;
	}

	// Generate token
	const { token, hash } = generateTokenWithHash();

	// Store token with role info
	await adapter.createToken({
		hash,
		email,
		type: "email_verify",
		role: signup.role,
		expiresAt: new Date(Date.now() + TOKEN_EXPIRY_MS),
	});

	// Build verification URL
	const url = buildAuthUrl(config.baseUrl, "api/auth/signup/verify");
	url.searchParams.set("token", token);

	// Send email
	const safeName = escapeHtml(config.siteName);
	await config.email({
		to: email,
		subject: `Verify your email for ${config.siteName}`,
		text: `Click this link to verify your email and create your account:\n\n${url.toString()}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
		html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 20px;">Verify your email</h1>
  <p>Click the button below to verify your email and create your ${safeName} account:</p>
  <p style="margin: 30px 0;">
    <a href="${url.toString()}" style="background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Verify Email</a>
  </p>
  <p style="color: #666; font-size: 14px;">This link expires in 15 minutes.</p>
  <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
</body>
</html>`,
	});
}

/**
 * Validate a signup verification token
 */
export async function validateSignupToken(
	adapter: AuthAdapter,
	token: string,
): Promise<{ email: string; role: RoleLevel }> {
	const hash = hashToken(token);

	const authToken = await adapter.getToken(hash, "email_verify");
	if (!authToken) {
		throw new SignupError("invalid_token", "Invalid or expired verification link");
	}

	if (authToken.expiresAt < new Date()) {
		await adapter.deleteToken(hash);
		throw new SignupError("token_expired", "This link has expired");
	}

	if (!authToken.email || authToken.role === null) {
		throw new SignupError("invalid_token", "Invalid token data");
	}

	return {
		email: authToken.email,
		role: authToken.role,
	};
}

/**
 * Complete signup process (after passkey registration)
 */
export async function completeSignup(
	adapter: AuthAdapter,
	token: string,
	userData: {
		name?: string;
		avatarUrl?: string;
	},
): Promise<User> {
	const hash = hashToken(token);

	// Validate token one more time
	const authToken = await adapter.getToken(hash, "email_verify");
	if (!authToken || authToken.expiresAt < new Date()) {
		throw new SignupError("invalid_token", "Invalid or expired verification");
	}

	if (!authToken.email || authToken.role === null) {
		throw new SignupError("invalid_token", "Invalid token data");
	}

	// Check user doesn't already exist
	const existing = await adapter.getUserByEmail(authToken.email);
	if (existing) {
		await adapter.deleteToken(hash);
		throw new SignupError("user_exists", "An account with this email already exists");
	}

	// Delete token (single-use)
	await adapter.deleteToken(hash);

	// Create user
	const user = await adapter.createUser({
		email: authToken.email,
		name: userData.name,
		avatarUrl: userData.avatarUrl,
		role: authToken.role,
		emailVerified: true,
	});

	return user;
}

export class SignupError extends Error {
	constructor(
		public code:
			| "invalid_token"
			| "token_expired"
			| "user_exists"
			| "domain_not_allowed"
			| "email_not_configured",
		message: string,
	) {
		super(message);
		this.name = "SignupError";
	}
}
