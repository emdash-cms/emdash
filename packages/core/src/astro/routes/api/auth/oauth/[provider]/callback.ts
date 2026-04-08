/**
 * GET /_emdash/api/auth/oauth/[provider]/callback
 *
 * Handle OAuth callback from provider
 */

import type { APIRoute } from "astro";

export const prerender = false;

import {
	handleOAuthCallback,
	OAuthError,
	Role,
	type OAuthConsumerConfig,
	type RoleLevel,
} from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { getPublicOrigin } from "#api/public-url.js";
import { createOAuthStateStore } from "#auth/oauth-state-store.js";

type ProviderName = "github" | "google";

const VALID_PROVIDERS = new Set<string>(["github", "google"]);

function isValidProvider(provider: string): provider is ProviderName {
	return VALID_PROVIDERS.has(provider);
}

/** Safely extract a string value from an env-like record */
function envString(env: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const val = env[key];
		if (typeof val === "string" && val) return val;
	}
	return undefined;
}

/**
 * Get OAuth config from environment variables
 */
function getOAuthConfig(env: Record<string, unknown>): OAuthConsumerConfig["providers"] {
	const providers: OAuthConsumerConfig["providers"] = {};

	// GitHub
	const githubClientId = envString(env, "EMDASH_OAUTH_GITHUB_CLIENT_ID", "GITHUB_CLIENT_ID");
	const githubClientSecret = envString(
		env,
		"EMDASH_OAUTH_GITHUB_CLIENT_SECRET",
		"GITHUB_CLIENT_SECRET",
	);
	if (githubClientId && githubClientSecret) {
		providers.github = {
			clientId: githubClientId,
			clientSecret: githubClientSecret,
		};
	}

	// Google
	const googleClientId = envString(env, "EMDASH_OAUTH_GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID");
	const googleClientSecret = envString(
		env,
		"EMDASH_OAUTH_GOOGLE_CLIENT_SECRET",
		"GOOGLE_CLIENT_SECRET",
	);
	if (googleClientId && googleClientSecret) {
		providers.google = {
			clientId: googleClientId,
			clientSecret: googleClientSecret,
		};
	}

	return providers;
}

export const GET: APIRoute = async ({ params, request, locals, session, redirect }) => {
	const { emdash } = locals;
	const provider = params.provider;

	// Validate provider
	if (!provider || !isValidProvider(provider)) {
		return redirect(
			`/_emdash/admin/login?error=invalid_provider&message=${encodeURIComponent("Invalid OAuth provider")}`,
		);
	}

	if (!emdash?.db) {
		return redirect(
			`/_emdash/admin/login?error=server_error&message=${encodeURIComponent("Database not configured")}`,
		);
	}

	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const error = url.searchParams.get("error");
	const errorDescription = url.searchParams.get("error_description");

	// Handle OAuth errors from provider
	if (error) {
		const message = errorDescription || error;
		return redirect(
			`/_emdash/admin/login?error=oauth_denied&message=${encodeURIComponent(message)}`,
		);
	}

	// Validate required params
	if (!code || !state) {
		return redirect(
			`/_emdash/admin/login?error=invalid_callback&message=${encodeURIComponent("Missing code or state parameter")}`,
		);
	}

	try {
		// Get OAuth providers from environment
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- locals.runtime is injected by the Cloudflare adapter at runtime; not declared on App.Locals since the adapter is optional
		const runtimeLocals = locals as unknown as { runtime?: { env?: Record<string, unknown> } };
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- import.meta.env is typed as ImportMetaEnv but we need Record<string, unknown> for getOAuthConfig
		const env = runtimeLocals.runtime?.env ?? (import.meta.env as Record<string, unknown>);
		const providers = getOAuthConfig(env);

		if (!providers[provider]) {
			return redirect(
				`/_emdash/admin/login?error=provider_not_configured&message=${encodeURIComponent(`OAuth provider ${provider} is not configured`)}`,
			);
		}

		const config: OAuthConsumerConfig = {
			baseUrl: `${getPublicOrigin(url, emdash?.config)}/_emdash`,
			providers,
			canSelfSignup: async (email: string) => {
				// Extract domain from email
				const domain = email.split("@")[1]?.toLowerCase();
				if (!domain) {
					return null;
				}

				// Check allowed_domains table for a matching, enabled entry
				const entry = await emdash.db
					.selectFrom("allowed_domains")
					.selectAll()
					.where("domain", "=", domain)
					.where("enabled", "=", 1)
					.executeTakeFirst();

				if (!entry) {
					return null;
				}

				// Map the stored role level to the Role enum
				const roleLevel = entry.default_role;
				const roleMap: Record<number, RoleLevel> = {
					50: Role.ADMIN,
					40: Role.EDITOR,
					30: Role.AUTHOR,
					20: Role.CONTRIBUTOR,
					10: Role.SUBSCRIBER,
				};
				const role = roleMap[roleLevel] ?? Role.CONTRIBUTOR;
				if (!roleMap[roleLevel]) {
					console.warn(
						`[oauth] Unknown role level ${roleLevel} for domain ${domain}, defaulting to CONTRIBUTOR`,
					);
				}

				return { allowed: true, role };
			},
		};

		const adapter = createKyselyAdapter(emdash.db);
		const stateStore = createOAuthStateStore(emdash.db);

		const user = await handleOAuthCallback(config, adapter, provider, code, state, stateStore);

		// Create session
		if (session) {
			session.set("user", { id: user.id });
		}

		// Redirect to admin dashboard
		return redirect("/_emdash/admin");
	} catch (callbackError) {
		console.error("OAuth callback error:", callbackError);

		let message = "Authentication failed";
		let errorCode = "oauth_error";

		if (callbackError instanceof OAuthError) {
			errorCode = callbackError.code;

			// Map all error codes to user-friendly messages (never expose raw error.message)
			switch (callbackError.code) {
				case "invalid_state":
					message = "OAuth session expired or invalid. Please try again.";
					break;
				case "signup_not_allowed":
					message = "Self-signup is not allowed for your email. Please contact an administrator.";
					break;
				case "user_not_found":
					message = "Your account was not found. It may have been deleted.";
					break;
				case "token_exchange_failed":
					message = "Failed to complete authentication. Please try again.";
					break;
				case "profile_fetch_failed":
					message = "Failed to retrieve your profile. Please try again.";
					break;
				default:
					message = "Authentication failed. Please try again.";
					break;
			}
		}
		// For generic errors, keep the default "Authentication failed" message

		return redirect(
			`/_emdash/admin/login?error=${errorCode}&message=${encodeURIComponent(message)}`,
		);
	}
};
