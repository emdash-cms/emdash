/**
 * WordPress Application Password OAuth callback
 *
 * GET /_emdash/api/import/wordpress-plugin/callback
 *
 * WordPress redirects here after user approves the application password.
 * We receive the credentials and redirect to the admin import UI with a token.
 */

import { secureCompare } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { encodeBase64 } from "#utils/base64.js";

export const prerender = false;

/**
 * The import wizard sets this cookie before sending the browser to WordPress
 * and passes the same value in `success_url`, so it comes back as `state`.
 */
const STATE_COOKIE = "emdash_wp_auth_state";

export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
	const denied = requirePerm(locals.user, "import:execute");
	if (denied) return denied;

	// A GET is reachable by cross-site navigation, so only accept credentials
	// for an authorization this browser started. The state is single use.
	const state = url.searchParams.get("state");
	const expectedState = cookies.get(STATE_COOKIE)?.value;
	cookies.delete(STATE_COOKIE, { path: "/_emdash/" });
	if (!state || !expectedState || !secureCompare(state, expectedState)) {
		return redirect("/_emdash/admin/import/wordpress?error=auth_rejected");
	}

	// WordPress sends these params on success:
	// - site_url: The WordPress site URL
	// - user_login: The username
	// - password: The newly created application password
	//
	// On rejection, it redirects to reject_url (if provided) or just doesn't include credentials

	const siteUrl = url.searchParams.get("site_url");
	const userLogin = url.searchParams.get("user_login");
	const password = url.searchParams.get("password");

	// Check if this is a rejection (no credentials)
	if (!siteUrl || !userLogin || !password) {
		return redirect("/_emdash/admin/import/wordpress?error=auth_rejected");
	}

	// Create the Basic Auth token
	const token = encodeBase64(`${userLogin}:${password}`);

	// Store credentials in a short-lived cookie (5 minutes)
	// This allows the import UI to retrieve them
	const authData = JSON.stringify({
		siteUrl,
		userLogin,
		token,
		timestamp: Date.now(),
	});

	// Base64 encode the auth data for cookie storage
	const encodedAuth = encodeBase64(authData);

	cookies.set("emdash_wp_auth", encodedAuth, {
		path: "/_emdash/",
		maxAge: 300, // 5 minutes
		httpOnly: false, // Needs to be readable by JS
		secure: url.protocol === "https:",
		sameSite: "lax",
	});

	// Redirect to import UI - it will pick up the cookie
	return redirect("/_emdash/admin/import/wordpress?auth=success");
};
