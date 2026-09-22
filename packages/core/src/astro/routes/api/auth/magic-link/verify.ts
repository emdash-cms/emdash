/**
 * GET /_emdash/api/auth/magic-link/verify
 * POST /_emdash/api/auth/magic-link/verify
 *
 * GET renders a confirmation page that carries the one-time token in a
 * hidden form field. POST verifies the token and creates the session.
 *
 * Tokens are single-use and expire after 15 minutes. Rendering the
 * confirmation page on GET prevents email security scanners from consuming
 * the token before the recipient clicks through.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { verifyMagicLink, MagicLinkError, escapeHtml } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { checkPublicCsrf } from "#api/csrf.js";
import { apiError } from "#api/error.js";
import { getPublicOrigin } from "#api/public-url.js";
import { isSafeRedirect } from "#api/redirect.js";

const DEFAULT_REDIRECT = "/_emdash/admin";

function loginErrorUrl(error: string, redirect: string = DEFAULT_REDIRECT): string {
	return `/_emdash/admin/login?error=${encodeURIComponent(error)}&redirect=${encodeURIComponent(redirect)}`;
}

function renderVerifyPage({
	token,
	redirect,
	siteName = "EmDash",
	action,
}: {
	token: string;
	redirect?: string | null;
	siteName?: string;
	action: string;
}): Response {
	const safeToken = escapeHtml(token);
	const safeRedirect = redirect && isSafeRedirect(redirect) ? escapeHtml(redirect) : "";
	const safeName = escapeHtml(siteName);

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="origin">
  <title>Sign in to ${safeName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 24px; }
    button { background: #0066cc; color: #fff; padding: 12px 24px; border: 0; border-radius: 6px; font-size: 16px; cursor: pointer; }
    button:hover { background: #0052a3; }
  </style>
</head>
<body>
  <h1>Sign in to ${safeName}</h1>
  <p>Click the button below to complete signing in. This link can only be used once.</p>
  <form method="POST" action="${escapeHtml(action)}">
    <input type="hidden" name="token" value="${safeToken}">
    ${safeRedirect ? `<input type="hidden" name="redirect" value="${safeRedirect}">` : ""}
    <button type="submit">Continue</button>
  </form>
</body>
</html>`;

	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "private, no-store",
			"Referrer-Policy": "origin",
		},
	});
}

export const GET: APIRoute = async ({ url, locals, redirect }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const token = url.searchParams.get("token");

	if (!token) {
		return redirect(loginErrorUrl("missing_token", DEFAULT_REDIRECT));
	}

	// Preserve any redirect the original request wanted.
	const redirectParam = url.searchParams.get("redirect");
	const action = url.pathname;

	return renderVerifyPage({ token, redirect: redirectParam, action });
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseVerifyBody(request: Request): Promise<{ token?: string; redirect?: string }> {
	const contentType = request.headers.get("content-type") ?? "";

	if (contentType.includes("application/json")) {
		try {
			const data = await request.json();
			if (!isRecord(data)) return {};
			return {
				token: typeof data.token === "string" ? data.token : undefined,
				redirect: typeof data.redirect === "string" ? data.redirect : undefined,
			};
		} catch {
			return {};
		}
	}

	try {
		const formData = await request.formData();
		const token = formData.get("token");
		const redirect = formData.get("redirect");
		return {
			token: typeof token === "string" ? token : undefined,
			redirect: typeof redirect === "string" ? redirect : undefined,
		};
	} catch {
		return {};
	}
}

function magicLinkErrorUrl(error: MagicLinkError, redirect: string): string {
	switch (error.code) {
		case "token_expired":
			return loginErrorUrl("link_expired", redirect);
		case "user_not_found":
			return loginErrorUrl("user_not_found", redirect);
		case "invalid_token":
		default:
			return loginErrorUrl("invalid_link", redirect);
	}
}

export const POST: APIRoute = async ({ request, url, locals, session, redirect }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// CSRF protection: this is a public API route, so the auth middleware
	// checks Origin header in front of us. Double-check here so the handler
	// remains safe even if called outside the EmDash middleware chain.
	const publicOrigin = getPublicOrigin(url, emdash?.config);
	const csrfError = checkPublicCsrf(request, url, publicOrigin);
	if (csrfError) return csrfError;

	const body = await parseVerifyBody(request);
	const token = body.token;
	const rawRedirect = body.redirect;
	const redirectUrl = isSafeRedirect(rawRedirect) ? rawRedirect : DEFAULT_REDIRECT;

	if (!token) {
		return redirect(loginErrorUrl("invalid_link", redirectUrl));
	}

	try {
		const adapter = createKyselyAdapter(emdash.db);
		const user = await verifyMagicLink(adapter, token);

		// Fire-and-forget cleanup of expired tokens — prevents accumulation
		void adapter.deleteExpiredTokens().catch(() => {});

		if (session) {
			session.set("user", { id: user.id });
		}

		return redirect(redirectUrl);
	} catch (error) {
		console.error("Magic link verify error:", error);

		if (error instanceof MagicLinkError) {
			return redirect(magicLinkErrorUrl(error, redirectUrl));
		}

		return redirect(loginErrorUrl("verification_failed", redirectUrl));
	}
};
