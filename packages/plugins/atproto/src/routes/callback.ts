/**
 * GET /_emdash/api/auth/atproto/callback
 *
 * Handles the OAuth callback from the user's PDS after authentication.
 * Exchanges the authorization code for tokens, resolves the user's identity,
 * finds or creates an EmDash user, and establishes a session.
 *
 * User lookup uses oauth_accounts (provider="atproto", provider_account_id=DID)
 * rather than email, since AT Protocol doesn't guarantee email access.
 *
 * For the first user (setup flow), the real email from the setup wizard is used.
 * For subsequent users, a synthetic email is generated from the DID.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import {
	Role,
	toRoleLevel,
	findOrCreateOAuthUser,
	OAuthError,
	type RoleLevel,
	type OAuthProfile,
} from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { AuthProviderDescriptor } from "emdash";
import { finalizeSetup, OptionsRepository } from "emdash/api/route-utils";

export const GET: APIRoute = async ({ request, locals, session, redirect }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return redirect(
			`/_emdash/admin/login?error=server_error&message=${encodeURIComponent("Database not configured")}`,
		);
	}

	try {
		const url = new URL(request.url);
		const baseUrl = url.origin;

		// Handle OAuth errors from PDS
		const error = url.searchParams.get("error");
		const errorDescription = url.searchParams.get("error_description");
		if (error) {
			const message = errorDescription || error;
			return redirect(
				`/_emdash/admin/login?error=atproto_denied&message=${encodeURIComponent(message)}`,
			);
		}

		// Exchange code for session via atcute
		const { getAtprotoOAuthClient, resolveAtprotoProfile } =
			await import("@emdash-cms/plugin-atproto/oauth-client");
		const client = await getAtprotoOAuthClient(baseUrl, emdash.db);
		const { session: atprotoSession } = await client.callback(url.searchParams);

		const did = atprotoSession.did;

		// Resolve profile for display name and handle
		const { displayName, handle } = await resolveAtprotoProfile(atprotoSession);

		// Get auth config from authProviders
		const providers = (
			emdash.config as { authProviders?: AuthProviderDescriptor[] } | null | undefined
		)?.authProviders;
		const atprotoProvider = providers?.find((p) => p.id === "atproto");
		const config = (atprotoProvider?.config ?? {}) as {
			allowedDIDs?: string[];
			allowedHandles?: string[];
			defaultRole?: number;
		};

		// Check allowlists if configured (DID or handle match = allowed)
		const hasAllowedDIDs = config.allowedDIDs && config.allowedDIDs.length > 0;
		const hasAllowedHandles = config.allowedHandles && config.allowedHandles.length > 0;

		if (hasAllowedDIDs || hasAllowedHandles) {
			const didAllowed = hasAllowedDIDs && config.allowedDIDs!.includes(did);

			let handleAllowed = false;
			if (!didAllowed && hasAllowedHandles) {
				// Independently verify the handle→DID binding before trusting it.
				// A malicious PDS could claim any handle — we verify via DNS/HTTP.
				const { verifyHandleDID } = await import("@emdash-cms/plugin-atproto/resolve-handle");
				const verifiedDid = await verifyHandleDID(handle);

				if (verifiedDid === did) {
					const normalizedHandle = handle.toLowerCase();
					handleAllowed = config.allowedHandles!.some((pattern) => {
						const p = pattern.toLowerCase();
						return (
							normalizedHandle === p ||
							(p.startsWith("*.") && normalizedHandle.endsWith(p.slice(1)))
						);
					});
				} else {
					console.warn(
						`[atproto-auth] Handle verification failed for ${handle}: expected DID ${did}, got ${verifiedDid}`,
					);
				}
			}

			if (!didAllowed && !handleAllowed) {
				return redirect(
					`/_emdash/admin/login?error=not_allowed&message=${encodeURIComponent("Your account is not in the allowlist")}`,
				);
			}
		}

		// Resolve default role from config
		let defaultRole: RoleLevel = Role.SUBSCRIBER;
		try {
			if (config.defaultRole != null) defaultRole = toRoleLevel(config.defaultRole);
		} catch {
			console.warn(
				`[atproto-auth] Invalid defaultRole ${config.defaultRole}, using SUBSCRIBER (${Role.SUBSCRIBER})`,
			);
		}

		// Check setup_complete as the authoritative first-user gate.
		// Using an option flag instead of countUsers() avoids a TOCTOU race
		// where two concurrent callbacks both see 0 users and both create admins.
		const adapter = createKyselyAdapter(emdash.db);
		const options = new OptionsRepository(emdash.db);
		const setupComplete = await options.get("emdash:setup_complete");
		const isFirstUser = setupComplete !== true && setupComplete !== "true";

		// Build synthetic email — AT Protocol doesn't guarantee email access.
		// For the first user, read the real email from the setup wizard state.
		let email: string;
		if (isFirstUser) {
			const setupState = await options.get<Record<string, unknown>>("emdash:setup_state");
			email = (setupState?.email as string) || `${did.replaceAll(":", "-")}@atproto.invalid`;
		} else {
			email = `${did.replaceAll(":", "-")}@atproto.invalid`;
		}

		const profile: OAuthProfile = {
			id: did,
			email,
			name: displayName || handle,
			avatarUrl: null,
			emailVerified: isFirstUser,
		};

		// Use shared find-or-create with canSelfSignup policy
		const user = await findOrCreateOAuthUser(adapter, "atproto", profile, async () => {
			if (isFirstUser) {
				return { allowed: true, role: Role.ADMIN };
			}
			return { allowed: true, role: defaultRole };
		});

		if (isFirstUser) {
			// finalizeSetup is idempotent — safe if two callbacks race past the check
			await finalizeSetup(emdash.db);
			console.log(`[atproto-auth] Setup complete: created admin user via atproto (${did})`);
		}

		// Update display name on each login in case it changed
		const newName = displayName || handle;
		if (user.name !== newName) {
			await adapter.updateUser(user.id, { name: newName });
		}

		// Check if user is disabled
		if (user.disabled) {
			return redirect(
				`/_emdash/admin/login?error=account_disabled&message=${encodeURIComponent("Account disabled")}`,
			);
		}

		// Create Astro session
		if (session) {
			session.set("user", { id: user.id });
		}

		// Redirect to admin dashboard
		return redirect("/_emdash/admin");
	} catch (callbackError) {
		console.error("[atproto-auth] Callback error:", callbackError);

		let message = "AT Protocol authentication failed. Please try again.";
		let errorCode = "atproto_error";

		if (callbackError instanceof OAuthError) {
			errorCode = callbackError.code;
			switch (callbackError.code) {
				case "signup_not_allowed":
					message = "Self-signup is not allowed. Please contact an administrator.";
					break;
				case "user_not_found":
					message = "Your account was not found. It may have been deleted.";
					break;
				default:
					break;
			}
		}

		return redirect(
			`/_emdash/admin/login?error=${errorCode}&message=${encodeURIComponent(message)}`,
		);
	}
};
