/**
 * Configuration schema for @emdash-cms/auth
 */

import { z } from "zod";

import type { RoleName } from "./types.js";

/** Matches http(s) scheme at start of URL */
const HTTP_SCHEME_RE = /^https?:\/\//i;

/** Validates that a URL string uses http or https scheme. Rejects javascript:/data: URI XSS vectors. */
const httpUrl = z
	.string()
	.url()
	.refine((url) => HTTP_SCHEME_RE.test(url), "URL must use http or https");

/**
 * OAuth provider configuration
 */
const oauthProviderSchema = z.object({
	clientId: z.string(),
	clientSecret: z.string(),
});

/**
 * Full auth configuration schema
 */
export const authConfigSchema = z.object({
	/**
	 * Secret key for encrypting tokens and session data.
	 * Generate with: `emdash auth secret`
	 */
	secret: z.string().min(32, "Auth secret must be at least 32 characters"),

	/**
	 * Passkey (WebAuthn) configuration
	 */
	passkeys: z
		.object({
			/**
			 * Relying party name shown to users during passkey registration
			 */
			rpName: z.string(),
			/**
			 * Relying party ID (domain). Defaults to the hostname from baseUrl.
			 */
			rpId: z.string().optional(),
		})
		.optional(),

	/**
	 * Self-signup configuration
	 */
	selfSignup: z
		.object({
			/**
			 * Email domains allowed to self-register
			 */
			domains: z.array(z.string()),
			/**
			 * Default role for self-registered users
			 */
			defaultRole: z.enum(["subscriber", "contributor", "author"] as const).default("contributor"),
		})
		.optional(),

	/**
	 * OAuth provider configurations (for "Login with X")
	 */
	oauth: z
		.object({
			github: oauthProviderSchema.optional(),
			google: oauthProviderSchema.optional(),
		})
		.optional(),

	/**
	 * Configure EmDash as an OAuth provider
	 */
	provider: z
		.object({
			enabled: z.boolean(),
			/**
			 * Issuer URL for OIDC. Defaults to site URL.
			 */
			issuer: httpUrl.optional(),
		})
		.optional(),

	/**
	 * Enterprise SSO configuration
	 */
	sso: z
		.object({
			enabled: z.boolean(),
		})
		.optional(),

	/**
	 * Session configuration
	 */
	session: z
		.object({
			/**
			 * Session max age in seconds. Default: 30 days
			 */
			maxAge: z.number().default(30 * 24 * 60 * 60),
			/**
			 * Extend session on activity. Default: true
			 */
			sliding: z.boolean().default(true),
		})
		.optional(),

	/**
	 * TOTP (authenticator app) configuration.
	 *
	 * TOTP is enabled by default because its whole reason for existing
	 * is to unblock deployers who hit passkey-UX friction on first run.
	 * Deployers in regulated environments (where TOTP is disallowed as
	 * a phishable factor) can set `enabled: false` to hide the method
	 * everywhere — the routes return 404 and the UI hides the picker.
	 */
	totp: z
		.object({
			/**
			 * Whether TOTP is offered as an auth method. Default: true.
			 * When false, all TOTP routes return 404 and the setup wizard
			 * + login page hide the TOTP option.
			 */
			enabled: z.boolean().default(true),
			/**
			 * Optional custom issuer label shown by authenticator apps
			 * when the user scans the QR code. Defaults to the site name
			 * at resolve time.
			 */
			issuer: z.string().optional(),
		})
		.optional(),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

/**
 * Validated and resolved auth configuration
 */
export interface ResolvedAuthConfig {
	secret: string;
	baseUrl: string;
	siteName: string;

	passkeys: {
		rpName: string;
		rpId: string;
		origin: string;
	};

	selfSignup?: {
		domains: string[];
		defaultRole: RoleName;
	};

	oauth?: {
		github?: {
			clientId: string;
			clientSecret: string;
		};
		google?: {
			clientId: string;
			clientSecret: string;
		};
	};

	provider?: {
		enabled: boolean;
		issuer: string;
	};

	sso?: {
		enabled: boolean;
	};

	session: {
		maxAge: number;
		sliding: boolean;
	};

	totp: {
		enabled: boolean;
		issuer: string;
	};
}

const selfSignupRoleMap: Record<"subscriber" | "contributor" | "author", RoleName> = {
	subscriber: "SUBSCRIBER",
	contributor: "CONTRIBUTOR",
	author: "AUTHOR",
};

/**
 * Resolve auth configuration with defaults
 */
export function resolveConfig(
	config: AuthConfig,
	baseUrl: string,
	siteName: string,
): ResolvedAuthConfig {
	const url = new URL(baseUrl);

	return {
		secret: config.secret,
		baseUrl,
		siteName,

		passkeys: {
			rpName: config.passkeys?.rpName ?? siteName,
			rpId: config.passkeys?.rpId ?? url.hostname,
			origin: url.origin,
		},

		selfSignup: config.selfSignup
			? {
					domains: config.selfSignup.domains.map((d) => d.toLowerCase()),
					defaultRole: selfSignupRoleMap[config.selfSignup.defaultRole],
				}
			: undefined,

		oauth: config.oauth,

		provider: config.provider
			? {
					enabled: config.provider.enabled,
					issuer: config.provider.issuer ?? baseUrl,
				}
			: undefined,

		sso: config.sso,

		session: {
			maxAge: config.session?.maxAge ?? 30 * 24 * 60 * 60,
			sliding: config.session?.sliding ?? true,
		},

		totp: {
			// TOTP is enabled by default; a deployer who needs to disable
			// it for compliance reasons has to opt out explicitly.
			enabled: config.totp?.enabled ?? true,
			// The issuer is shown by authenticator apps as the group label.
			// Defaults to the site name so the QR code looks coherent out
			// of the box.
			issuer: config.totp?.issuer ?? siteName,
		},
	};
}
