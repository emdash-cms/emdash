/**
 * POST /_emdash/api/auth/dev-bypass
 * GET  /_emdash/api/auth/dev-bypass
 *
 * Development-only endpoint to bypass passkey authentication.
 * Creates or uses a test admin user and establishes a session.
 *
 * ONLY available when import.meta.env.DEV is true.
 *
 * Usage:
 * - GET with redirect: /_emdash/api/auth/dev-bypass?redirect=/_emdash/admin
 * - POST for API: Returns JSON with user info
 *
 * For agent/browser testing, navigate to:
 *   /_emdash/api/auth/dev-bypass?redirect=/_emdash/admin
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { ulid } from "ulidx";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { escapeHtml } from "#api/escape.js";
import { isSafeRedirect } from "#api/redirect.js";

const DEV_USER_EMAIL = "dev@emdash.local";
const DEV_USER_NAME = "Dev Admin";

// RBAC role levels (matching @emdash-cms/auth)
const ROLE_ADMIN = 50;

async function handleDevBypass(context: Parameters<APIRoute>[0]): Promise<Response> {
	// CRITICAL: Only allow in development mode
	if (!import.meta.env.DEV) {
		return apiError("FORBIDDEN", "Dev bypass is only available in development mode", 403);
	}

	const { locals, url, session } = context;
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Find or create dev user (direct DB access to avoid @emdash-cms/auth import issues in dev)
		const existingUser = await emdash.db
			.selectFrom("users")
			.selectAll()
			.where("email", "=", DEV_USER_EMAIL)
			.executeTakeFirst();

		let user: { id: string; email: string; name: string; role: number };

		if (!existingUser) {
			const now = new Date().toISOString();
			const newUser = {
				id: ulid(),
				email: DEV_USER_EMAIL,
				name: DEV_USER_NAME,
				role: ROLE_ADMIN,
				email_verified: 1,
				created_at: now,
				updated_at: now,
			};

			await emdash.db.insertInto("users").values(newUser).execute();

			user = {
				id: newUser.id,
				email: newUser.email,
				name: newUser.name,
				role: newUser.role,
			};
			console.log("[dev-bypass] Created dev admin user:", user.email);
		} else {
			user = {
				id: existingUser.id,
				email: existingUser.email,
				name: existingUser.name || DEV_USER_NAME,
				role: existingUser.role,
			};
		}

		// Create session
		if (session) {
			session.set("user", { id: user.id });
		}

		// Check for redirect parameter
		const redirect = url.searchParams.get("redirect");

		if (redirect) {
			// Validate redirect is a safe local path (prevent open redirect via //evil.com or /\evil.com)
			if (!isSafeRedirect(redirect)) {
				return apiError("INVALID_REDIRECT", "Redirect must be a local path", 400);
			}

			// Return an HTML page with meta-refresh redirect
			// This ensures the session is fully saved before redirect
			const safeRedirect = escapeHtml(redirect);
			const html = `<!DOCTYPE html>
<html>
<head>
	<meta http-equiv="refresh" content="0;url=${safeRedirect}">
</head>
<body>Redirecting...</body>
</html>`;
			return new Response(html, {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		}

		// Return JSON response
		return apiSuccess({
			success: true,
			message: "Dev session created",
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
			},
		});
	} catch (error) {
		return handleError(error, "Dev bypass setup failed", "DEV_BYPASS_ERROR");
	}
}

// Support both GET and POST
export const GET: APIRoute = handleDevBypass;
export const POST: APIRoute = handleDevBypass;
