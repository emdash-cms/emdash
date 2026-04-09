/**
 * GET /_emdash/api/auth/atproto/verify-email
 *
 * Handles the email verification link clicked from the verification email.
 * Verifies the token, creates or links the user, and establishes a session.
 */

import { hashToken } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIRoute } from "astro";
import { ulid } from "ulidx";

import { cleanupAtprotoEntries } from "#auth/atproto/client.js";

export const prerender = false;

/** Create a redirect response with mutable headers */
function redirectTo(url: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: { Location: url },
	});
}

export const GET: APIRoute = async ({ request, locals, session }) => {
	const { emdash } = locals;
	const url = new URL(request.url);
	const token = url.searchParams.get("token");
	const state = url.searchParams.get("state");

	if (!emdash?.db) {
		return redirectTo(
			`/_emdash/admin/login?error=server_error&message=${encodeURIComponent("Database not configured")}`,
		);
	}

	if (!token || !state) {
		return redirectTo(
			`/_emdash/admin/login?error=invalid_link&message=${encodeURIComponent("Invalid or incomplete verification link")}`,
		);
	}

	try {
		const adapter = createKyselyAdapter(emdash.db);

		// Verify the email token
		const hash = hashToken(token);
		const authToken = await adapter.getToken(hash, "email_verify");

		if (!authToken) {
			return redirectTo(
				`/_emdash/admin/login?error=invalid_token&message=${encodeURIComponent("Invalid or expired verification link")}`,
			);
		}

		if (authToken.expiresAt < new Date()) {
			await adapter.deleteToken(hash);
			return redirectTo(
				`/_emdash/admin/login?error=token_expired&message=${encodeURIComponent("Verification link has expired. Please try again.")}`,
			);
		}

		const email = authToken.email;
		if (!email) {
			await adapter.deleteToken(hash);
			return redirectTo(
				`/_emdash/admin/login?error=invalid_token&message=${encodeURIComponent("Invalid verification token")}`,
			);
		}

		// Delete token (single-use)
		await adapter.deleteToken(hash);

		// Retrieve pending ATProto state
		const pending = await emdash.db
			.selectFrom("auth_challenges")
			.selectAll()
			.where("challenge", "=", state)
			.where("type", "=", "atproto_pending")
			.executeTakeFirst();

		if (!pending?.data) {
			return redirectTo(
				`/_emdash/admin/login?error=invalid_state&message=${encodeURIComponent("ATProto session expired. Please try logging in again.")}`,
			);
		}

		if (new Date(pending.expires_at).getTime() < Date.now()) {
			await emdash.db.deleteFrom("auth_challenges").where("challenge", "=", state).execute();
			return redirectTo(
				`/_emdash/admin/login?error=expired&message=${encodeURIComponent("ATProto session expired. Please try logging in again.")}`,
			);
		}

		const { did, handle } = JSON.parse(pending.data) as {
			did: string;
			handle?: string;
		};

		// === User provisioning (same logic as before, but email is now verified) ===

		// Check if DID already linked (race condition guard)
		const existingByDid = await emdash.db
			.selectFrom("oauth_accounts")
			.selectAll()
			.where("provider", "=", "atproto")
			.where("provider_account_id", "=", did)
			.executeTakeFirst();

		if (existingByDid) {
			if (session) {
				session.set("user", { id: existingByDid.user_id });
			}
			await emdash.db.deleteFrom("auth_challenges").where("challenge", "=", state).execute();
			await cleanupAtprotoEntries(emdash.db);
			return redirectTo("/_emdash/admin");
		}

		// Check if user with this email exists — link DID
		const existingUser = await emdash.db
			.selectFrom("users")
			.selectAll()
			.where("email", "=", email)
			.executeTakeFirst();

		if (existingUser) {
			if (existingUser.disabled) {
				return redirectTo(
					`/_emdash/admin/login?error=account_disabled&message=${encodeURIComponent("Your account has been disabled")}`,
				);
			}

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

			await emdash.db.deleteFrom("auth_challenges").where("challenge", "=", state).execute();
			await cleanupAtprotoEntries(emdash.db);
			return redirectTo("/_emdash/admin");
		}

		// Check allowed_domains for self-signup
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
						email,
						name: handle || null,
						avatar_url: null,
						role: allowedDomain.default_role,
						email_verified: 1, // Verified by clicking the email link
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

				await emdash.db.deleteFrom("auth_challenges").where("challenge", "=", state).execute();
				await cleanupAtprotoEntries(emdash.db);
				return redirectTo("/_emdash/admin");
			}
		}

		return redirectTo(
			`/_emdash/admin/login?error=signup_not_allowed&message=${encodeURIComponent("Self-signup is not allowed for your email domain. Please contact an administrator.")}`,
		);
	} catch (error) {
		console.error("[VERIFY_EMAIL_ERROR]", error instanceof Error ? error.message : error);
		return redirectTo(
			`/_emdash/admin/login?error=verify_error&message=${encodeURIComponent("Verification failed. Please try again.")}`,
		);
	}
};
