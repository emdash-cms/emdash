/**
 * GET /_emdash/api/auth/atproto/callback
 *
 * Handles the redirect from the PDS authorization server after the user
 * approves the ATProto OAuth request. Exchanges the code for tokens,
 * provisions or links the user, and creates an EmDash session.
 */

import type { APIRoute } from "astro";
import { ulid } from "ulidx";

import { createAtprotoClient, cleanupAtprotoEntries } from "#auth/atproto/client.js";

export const prerender = false;

const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes for email collection

/** Create a redirect response with mutable headers (unlike Response.redirect) */
function redirectTo(url: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: { Location: url },
	});
}

export const GET: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return redirectTo(
			`/_emdash/admin/login?error=server_error&message=${encodeURIComponent("Database not configured")}`,
		);
	}

	if (!emdash.config?.atproto) {
		return redirectTo(
			`/_emdash/admin/login?error=not_configured&message=${encodeURIComponent("ATProto authentication is not enabled")}`,
		);
	}

	const url = new URL(request.url);
	const params = url.searchParams;

	// In loopback mode, the PDS redirects to 127.0.0.1 but the user browses
	// on localhost. We use two origins:
	// - localhostOrigin: for UI redirects (login page, complete-profile) where
	//   the SPA runs and existing cookies live
	// - url.origin: for session-setting redirects (successful login) so the
	//   session cookie is set on the same host as the response
	const hostname = url.hostname;
	const isLoopback = hostname === "127.0.0.1" || hostname === "[::1]";
	const localhostOrigin = isLoopback ? `http://localhost:${url.port}` : url.origin;
	// For successful auth, stay on the callback host so session cookie is valid
	const sessionOrigin = url.origin;

	// Handle errors from the PDS
	const error = params.get("error");
	if (error) {
		const desc = params.get("error_description") || error;
		return redirectTo(
			`${localhostOrigin}/_emdash/admin/login?error=oauth_denied&message=${encodeURIComponent(desc)}`,
		);
	}

	try {
		const client = createAtprotoClient({
			publicUrl: localhostOrigin,
			db: emdash.db,
			allowHttp: import.meta.env.DEV,
		});

		// Exchange code for tokens via SDK
		const { session: oauthSession } = await client.callback(params);

		const did = oauthSession.did;

		// Resolve handle from DID
		let handle: string | undefined;
		try {
			const identity = await client.identityResolver.resolve(did);
			handle = identity.handle !== "handle.invalid" ? identity.handle : undefined;
		} catch {
			// Handle resolution failure is not fatal — we still have the DID
		}

		// Try to get email from the token info
		// ATProto doesn't standardize email in token responses,
		// so this may not be available
		let email: string | undefined;
		try {
			const tokenInfo = await oauthSession.getTokenInfo();
			// Check if email is available in token metadata
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const info = tokenInfo as any;
			if (typeof info.email === "string" && info.email) {
				email = info.email;
			}
		} catch {
			// Email not available from token — will need interstitial
		}

		// === User provisioning ===

		// Step 1: Look up by DID in oauth_accounts
		const existingAccount = await emdash.db
			.selectFrom("oauth_accounts")
			.selectAll()
			.where("provider", "=", "atproto")
			.where("provider_account_id", "=", did)
			.executeTakeFirst();

		if (existingAccount) {
			const user = await emdash.db
				.selectFrom("users")
				.selectAll()
				.where("id", "=", existingAccount.user_id)
				.executeTakeFirst();

			if (!user) {
				return redirectTo(
					`${localhostOrigin}/_emdash/admin/login?error=user_not_found&message=${encodeURIComponent("Linked user account not found")}`,
				);
			}

			if (user.disabled) {
				return redirectTo(
					`${localhostOrigin}/_emdash/admin/login?error=account_disabled&message=${encodeURIComponent("Your account has been disabled")}`,
				);
			}

			// Update handle if it changed
			if (handle && user.atproto_did === did) {
				// User already has DID set, just update if needed
			}

			if (session) {
				session.set("user", { id: user.id });
			}

			await cleanupAtprotoEntries(emdash.db);
			return redirectTo(`${sessionOrigin}/_emdash/admin`);
		}

		// Step 2: If we have email, try to link by email
		if (email) {
			const existingUser = await emdash.db
				.selectFrom("users")
				.selectAll()
				.where("email", "=", email.toLowerCase())
				.executeTakeFirst();

			if (existingUser) {
				if (existingUser.disabled) {
					return redirectTo(
						`${localhostOrigin}/_emdash/admin/login?error=account_disabled&message=${encodeURIComponent("Your account has been disabled")}`,
					);
				}

				// Link DID to existing user
				await emdash.db
					.updateTable("users")
					.set({ atproto_did: did })
					.where("id", "=", existingUser.id)
					.execute();

				await emdash.db
					.insertInto("oauth_accounts")
					.values({
						provider: "atproto",
						provider_account_id: did,
						user_id: existingUser.id,
					})
					.execute();

				if (session) {
					session.set("user", { id: existingUser.id });
				}

				await cleanupAtprotoEntries(emdash.db);
				return redirectTo(`${sessionOrigin}/_emdash/admin`);
			}

			// Step 3: Check allowed_domains for self-signup
			const domain = email.split("@")[1]?.toLowerCase();
			if (domain) {
				const allowedDomain = await emdash.db
					.selectFrom("allowed_domains")
					.selectAll()
					.where("domain", "=", domain)
					.where("enabled", "=", 1)
					.executeTakeFirst();

				if (allowedDomain) {
					const userId = ulid();
					await emdash.db
						.insertInto("users")
						.values({
							id: userId,
							email: email.toLowerCase(),
							name: handle || null,
							avatar_url: null,
							role: allowedDomain.default_role,
							email_verified: 1,
							data: null,
							atproto_did: did,
						})
						.execute();

					await emdash.db
						.insertInto("oauth_accounts")
						.values({
							provider: "atproto",
							provider_account_id: did,
							user_id: userId,
						})
						.execute();

					if (session) {
						session.set("user", { id: userId });
					}

					await cleanupAtprotoEntries(emdash.db);
					return redirectTo(`${sessionOrigin}/_emdash/admin`);
				}
			}

			// No allowed domain — signup not permitted
			return redirectTo(
				`${localhostOrigin}/_emdash/admin/login?error=signup_not_allowed&message=${encodeURIComponent("Self-signup is not allowed for your email domain. Please contact an administrator.")}`,
			);
		}

		// Step 4: No email available — redirect to complete-profile interstitial
		const pendingKey = ulid();
		const expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();

		await emdash.db
			.insertInto("auth_challenges")
			.values({
				challenge: pendingKey,
				type: "atproto_pending",
				user_id: null,
				data: JSON.stringify({ did, handle }),
				expires_at: expiresAt,
			})
			.execute();

		return redirectTo(
			`${localhostOrigin}/_emdash/admin/complete-profile?state=${encodeURIComponent(pendingKey)}`,
		);
	} catch (callbackError) {
		console.error("ATProto callback error:", callbackError);

		return redirectTo(
			`${localhostOrigin}/_emdash/admin/login?error=atproto_error&message=${encodeURIComponent("Authentication failed. Please try again.")}`,
		);
	}
};
