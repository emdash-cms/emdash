/**
 * POST /_emdash/api/auth/atproto/complete-profile
 *
 * Collects email when the PDS authorization server didn't return one.
 * Sends a verification email instead of immediately creating the user.
 * The user must click the link in the email to complete sign-in.
 */

import { generateTokenWithHash } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	let email: string;
	let state: string;
	try {
		const body = (await request.json()) as { email?: string; state?: string };
		email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		state = typeof body.state === "string" ? body.state.trim() : "";
	} catch {
		return apiError("VALIDATION_ERROR", "Invalid request body", 400);
	}

	if (!state) {
		return apiError("VALIDATION_ERROR", "Missing state parameter", 400);
	}

	if (!email || !EMAIL_RE.test(email)) {
		return apiError("VALIDATION_ERROR", "Please enter a valid email address", 400);
	}

	try {
		// Retrieve pending ATProto state
		const pending = await emdash.db
			.selectFrom("auth_challenges")
			.selectAll()
			.where("challenge", "=", state)
			.where("type", "=", "atproto_pending")
			.executeTakeFirst();

		if (!pending?.data) {
			return apiError(
				"INVALID_STATE",
				"Session expired or invalid. Please try logging in again.",
				400,
			);
		}

		// Check expiration
		if (new Date(pending.expires_at).getTime() < Date.now()) {
			await emdash.db.deleteFrom("auth_challenges").where("challenge", "=", state).execute();
			return apiError("EXPIRED", "Session expired. Please try logging in again.", 400);
		}

		// Check if email pipeline is available
		if (!emdash.email?.isAvailable()) {
			return apiError(
				"EMAIL_NOT_CONFIGURED",
				"Email is not configured. Please contact an administrator.",
				500,
			);
		}

		// Generate verification token
		const { token, hash } = generateTokenWithHash();
		const adapter = createKyselyAdapter(emdash.db);

		await adapter.createToken({
			hash,
			userId: null, // No user yet
			email,
			type: "email_verify",
			expiresAt: new Date(Date.now() + TOKEN_EXPIRY_MS),
		});

		// Build verification URL with both the token and the atproto state
		const url = new URL(request.url);
		const verifyUrl = new URL("/_emdash/api/auth/atproto/verify-email", url.origin);
		verifyUrl.searchParams.set("token", token);
		verifyUrl.searchParams.set("state", state);

		// Log full verification URL in dev mode
		if (import.meta.env.DEV) {
			console.log(`[atproto] Verification URL: ${verifyUrl.toString()}`);
		}

		// Send verification email
		const siteName = "EmDash";
		await emdash.email.send(
			{
				to: email,
				subject: `Verify your email for ${siteName}`,
				text: `Click this link to verify your email and complete sign-in:\n\n${verifyUrl.toString()}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
				html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 20px;">Verify your email</h1>
  <p>Click the button below to verify your email and complete sign-in:</p>
  <p style="margin: 30px 0;">
    <a href="${verifyUrl.toString()}" style="background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Verify email</a>
  </p>
  <p style="color: #666; font-size: 14px;">This link expires in 15 minutes.</p>
  <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
</body>
</html>`,
			},
			"system",
		);

		return Response.json({ data: { emailSent: true } });
	} catch (error) {
		return handleError(error, "Failed to send verification email", "COMPLETE_PROFILE_ERROR");
	}
};
