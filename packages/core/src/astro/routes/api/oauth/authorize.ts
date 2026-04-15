/**
 * GET/POST /_emdash/oauth/authorize
 *
 * OAuth 2.1 Authorization Endpoint. Handles both the consent page (GET)
 * and consent submission (POST).
 *
 * GET: Renders an HTML consent page showing which client is requesting
 *      access and which scopes are being requested.
 * POST: Processes the user's decision (approve/deny) and redirects
 *       to the client's redirect_uri with an authorization code or error.
 *
 * Requires an authenticated session (not token auth). If unauthenticated,
 * redirects to login with a return URL.
 */

import type { APIRoute } from "astro";

import { escapeHtml } from "#api/escape.js";
import {
	buildDeniedRedirect,
	handleAuthorizationApproval,
	validateRedirectUri,
} from "#api/handlers/oauth-authorization.js";
import { lookupOAuthClient, validateClientRedirectUri } from "#api/handlers/oauth-clients.js";
import { getPublicOrigin } from "#api/public-url.js";
import { VALID_SCOPES } from "#auth/api-tokens.js";

export const prerender = false;

// ---------------------------------------------------------------------------
// CSRF (SEC-18): Double-submit cookie pattern
// ---------------------------------------------------------------------------

const CSRF_COOKIE_NAME = "emdash_oauth_csrf";

/** Generate a 32-byte random token as hex. */
function generateCsrfToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the Set-Cookie header value for the CSRF token. */
function csrfCookieHeader(token: string, request: Request, siteUrl?: string): string {
	// SameSite=Strict prevents cross-site form submission.
	// HttpOnly: the token value is embedded in the form hidden field server-side,
	// so JS never needs to read the cookie. HttpOnly adds defense-in-depth.
	// Secure is set when:
	//   - siteUrl is configured and uses https (proxy case — request may be http internally), OR
	//   - the actual request is over https (non-proxy case, preserve existing behaviour)
	const isSecure = siteUrl
		? siteUrl.startsWith("https:")
		: new URL(request.url).protocol === "https:";
	const secure = isSecure ? "; Secure" : "";
	return `${CSRF_COOKIE_NAME}=${token}; Path=/_emdash/oauth/authorize; HttpOnly; SameSite=Strict${secure}`;
}

/** Extract the CSRF token from the request's cookies. */
function getCsrfCookie(request: Request): string | null {
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) return null;
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]+)`));
	return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Human-readable scope labels
// ---------------------------------------------------------------------------

const SCOPE_LABELS: Record<string, string> = {
	"content:read": "Read content (posts, pages, etc.)",
	"content:write": "Create, edit, and delete content",
	"media:read": "View media files",
	"media:write": "Upload and manage media files",
	"schema:read": "View collection schemas",
	"schema:write": "Create and modify collection schemas",
	admin: "Full administrative access",
};

// ---------------------------------------------------------------------------
// GET: Render consent page
// ---------------------------------------------------------------------------

export const GET: APIRoute = async ({ url, request, locals }) => {
	const { emdash, user } = locals;

	// Validate required OAuth params before rendering
	const clientId = url.searchParams.get("client_id");
	const redirectUri = url.searchParams.get("redirect_uri");
	const responseType = url.searchParams.get("response_type");
	const codeChallenge = url.searchParams.get("code_challenge");
	const codeChallengeMethod = url.searchParams.get("code_challenge_method");
	const scope = url.searchParams.get("scope");
	const state = url.searchParams.get("state");

	// Basic validation — detailed validation happens on POST
	if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge) {
		return new Response(
			renderErrorPage("Invalid authorization request. Missing required parameters."),
			{
				status: 400,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			},
		);
	}

	if (codeChallengeMethod && codeChallengeMethod !== "S256") {
		return new Response(renderErrorPage("Only S256 code challenge method is supported."), {
			status: 400,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	// Validate client_id is registered and redirect_uri is in the allowlist.
	// This check happens BEFORE authentication so we never redirect to an
	// unregistered URI (even for the login redirect, we only redirect to our
	// own login page, not to the client's redirect_uri).
	if (emdash?.db) {
		const client = await lookupOAuthClient(emdash.db, clientId);
		if (!client) {
			return new Response(renderErrorPage("Unknown client application."), {
				status: 400,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}

		const clientUriError = validateClientRedirectUri(redirectUri, client.redirectUris);
		if (clientUriError) {
			return new Response(renderErrorPage("The redirect URI is not registered for this client."), {
				status: 400,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
	}

	// If not authenticated, redirect to login with return URL
	if (!user) {
		const loginUrl = new URL("/_emdash/admin/login", getPublicOrigin(url, emdash?.config));
		loginUrl.searchParams.set("redirect", url.pathname + url.search);
		return Response.redirect(loginUrl.toString(), 302);
	}

	// Parse and validate scopes
	const validSet = new Set<string>(VALID_SCOPES);
	const requestedScopes = (scope ?? "")
		.split(" ")
		.filter(Boolean)
		.filter((s) => validSet.has(s));

	if (requestedScopes.length === 0) {
		return new Response(renderErrorPage("No valid scopes requested."), {
			status: 400,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	// SEC-18: Generate CSRF token for the consent form (double-submit cookie pattern)
	const csrfToken = generateCsrfToken();

	// Render the consent page
	const html = renderConsentPage({
		clientId,
		scopes: requestedScopes,
		redirectUri,
		responseType,
		codeChallenge,
		codeChallengeMethod: codeChallengeMethod ?? "S256",
		state: state ?? "",
		resource: url.searchParams.get("resource") ?? "",
		userName: user.name ?? user.email,
		csrfToken,
	});

	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": csrfCookieHeader(csrfToken, request, getPublicOrigin(url, emdash?.config)),
		},
	});
};

// ---------------------------------------------------------------------------
// POST: Process consent
// ---------------------------------------------------------------------------

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return new Response(renderErrorPage("EmDash is not initialized."), {
			status: 500,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	if (!user) {
		return new Response(renderErrorPage("Authentication required."), {
			status: 401,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	const formData = await request.formData();
	const field = (name: string, fallback = ""): string => {
		const v = formData.get(name);
		return typeof v === "string" ? v : fallback;
	};

	// SEC-18: Validate CSRF token (double-submit cookie pattern).
	// The form includes a hidden csrf_token field; the cookie has the same value.
	// An attacker cannot read the cookie to forge the form field (HttpOnly + SameSite=Strict).
	const formCsrf = field("csrf_token");
	const cookieCsrf = getCsrfCookie(request);
	const csrfError = new Response(
		renderErrorPage("Invalid or missing CSRF token. Please try again."),
		{ status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
	);
	if (!formCsrf || !cookieCsrf) return csrfError;

	// Constant-time comparison: hash both values to fixed-length 32-byte digests,
	// then XOR every byte pair. This avoids crypto.subtle.timingSafeEqual which is
	// a Cloudflare Workers extension and doesn't exist in Node.js.
	// The SHA-256 pre-hash ensures fixed length, eliminating length-leaking.
	const csrfEncoder = new TextEncoder();
	const [csrfHashA, csrfHashB] = await Promise.all([
		crypto.subtle.digest("SHA-256", csrfEncoder.encode(formCsrf)),
		crypto.subtle.digest("SHA-256", csrfEncoder.encode(cookieCsrf)),
	]);
	const a = new Uint8Array(csrfHashA);
	const b = new Uint8Array(csrfHashB);
	let diff = 0;
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsgo needs these
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	if (diff !== 0) return csrfError;

	const action = field("action");
	const redirectUri = field("redirect_uri");
	const state = field("state") || undefined;

	if (!redirectUri) {
		return new Response(renderErrorPage("Missing redirect_uri."), {
			status: 400,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	// Validate redirect_uri scheme/host before using it for any redirect
	const uriError = validateRedirectUri(redirectUri);
	if (uriError) {
		return new Response(renderErrorPage(escapeHtml(uriError)), {
			status: 400,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	// User denied — SEC-44: validate redirect_uri against client's registered URIs
	// before redirecting, to prevent open redirect on the deny path.
	if (action === "deny") {
		const clientId = field("client_id");
		if (!clientId) {
			return new Response(renderErrorPage("Missing client_id."), {
				status: 400,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}

		const client = await lookupOAuthClient(emdash.db, clientId);
		if (!client) {
			return new Response(renderErrorPage("Unknown client application."), {
				status: 400,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}

		const clientUriError = validateClientRedirectUri(redirectUri, client.redirectUris);
		if (clientUriError) {
			return new Response(renderErrorPage("The redirect URI is not registered for this client."), {
				status: 400,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}

		const denyUrl = buildDeniedRedirect(redirectUri, state);
		return Response.redirect(denyUrl, 302);
	}

	// User approved — process the authorization
	const result = await handleAuthorizationApproval(emdash.db, user.id, user.role, {
		response_type: field("response_type", "code"),
		client_id: field("client_id"),
		redirect_uri: redirectUri,
		scope: field("scope"),
		state,
		code_challenge: field("code_challenge"),
		code_challenge_method: field("code_challenge_method", "S256"),
		resource: field("resource") || undefined,
	});

	if (!result.success) {
		const errMsg = result.error?.message ?? "Authorization failed";
		// On error, redirect back with error params — use generic description to avoid
		// leaking internal error details to the (already-validated) redirect target
		try {
			const errorUrl = new URL(redirectUri);
			errorUrl.searchParams.set("error", "server_error");
			errorUrl.searchParams.set("error_description", "Authorization failed");
			if (state) errorUrl.searchParams.set("state", state);
			return Response.redirect(errorUrl.toString(), 302);
		} catch {
			return new Response(renderErrorPage(escapeHtml(errMsg)), {
				status: 400,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
	}

	return Response.redirect(result.data.redirect_url, 302);
};

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderConsentPage(params: {
	clientId: string;
	scopes: string[];
	redirectUri: string;
	responseType: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	state: string;
	resource: string;
	userName: string;
	csrfToken: string;
}): string {
	const scopeList = params.scopes
		.map((s) => {
			const label = SCOPE_LABELS[s] ?? s;
			return `<li>${escapeHtml(label)}</li>`;
		})
		.join("\n");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Application — EmDash</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
  .card { background: #171717; border: 1px solid #262626; border-radius: 12px; max-width: 420px; width: 100%; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
  .client-id { color: #a3a3a3; font-size: 0.875rem; word-break: break-all; margin-bottom: 1.5rem; }
  .user { color: #a3a3a3; font-size: 0.875rem; margin-bottom: 1rem; }
  h2 { font-size: 0.875rem; font-weight: 500; color: #a3a3a3; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
  ul { list-style: none; margin-bottom: 1.5rem; }
  li { padding: 0.5rem 0; border-bottom: 1px solid #262626; font-size: 0.875rem; }
  li:last-child { border-bottom: none; }
  .actions { display: flex; gap: 0.75rem; }
  button { flex: 1; padding: 0.625rem 1rem; border-radius: 8px; border: none; font-size: 0.875rem; font-weight: 500; cursor: pointer; }
  .approve { background: #2563eb; color: white; }
  .approve:hover { background: #1d4ed8; }
  .deny { background: #262626; color: #e5e5e5; }
  .deny:hover { background: #333; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorize Application</h1>
  <p class="client-id">${escapeHtml(params.clientId)}</p>
  <p class="user">Signed in as <strong>${escapeHtml(params.userName)}</strong></p>
  <h2>Permissions requested</h2>
  <ul>${scopeList}</ul>
  <form method="POST">
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrfToken)}">
    <input type="hidden" name="response_type" value="${escapeHtml(params.responseType)}">
    <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="scope" value="${escapeHtml(params.scopes.join(" "))}">
    <input type="hidden" name="state" value="${escapeHtml(params.state)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}">
    <input type="hidden" name="resource" value="${escapeHtml(params.resource)}">
    <div class="actions">
      <button type="submit" name="action" value="deny" class="deny">Deny</button>
      <button type="submit" name="action" value="approve" class="approve">Approve</button>
    </div>
  </form>
</div>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization Error — EmDash</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
  .card { background: #171717; border: 1px solid #262626; border-radius: 12px; max-width: 420px; width: 100%; padding: 2rem; }
  h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: #ef4444; }
  p { font-size: 0.875rem; color: #a3a3a3; }
</style>
</head>
<body>
<div class="card">
  <h1>Authorization Error</h1>
  <p>${escapeHtml(message)}</p>
</div>
</body>
</html>`;
}
