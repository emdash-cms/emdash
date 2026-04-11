/**
 * GET /_emdash/api/auth/oauth/[provider]
 *
 * Start OAuth flow - redirects to provider authorization URL
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { createAuthorizationUrl, type OAuthConsumerConfig } from "@emdash-cms/auth";

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

export const GET: APIRoute = async ({ params, request, locals, redirect }) => {
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

	try {
		const url = new URL(request.url);

		// Get OAuth providers from environment
		// Access via locals.runtime for Cloudflare, or import.meta.env for Node
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
		};

		const stateStore = createOAuthStateStore(emdash.db);

		const { url: authUrl } = await createAuthorizationUrl(config, provider, stateStore);

		return redirect(authUrl);
	} catch (error) {
		console.error("OAuth initiation error:", error);
		return redirect(
			`/_emdash/admin/login?error=oauth_error&message=${encodeURIComponent("Failed to start OAuth flow. Please try again.")}`,
		);
	}
};
