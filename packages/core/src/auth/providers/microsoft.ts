/**
 * Microsoft OAuth Auth Provider
 *
 * Returns an AuthProviderDescriptor for Microsoft Entra ID login.
 * Credentials are read from environment variables at runtime.
 *
 * @example
 * ```ts
 * import { microsoft } from "emdash/auth/providers/microsoft";
 *
 * emdash({
 *   authProviders: [microsoft()],
 * })
 * ```
 */

import type { AuthProviderDescriptor } from "../types.js";

export interface MicrosoftProviderOptions {
	/**
	 * Whether sign-in email addresses count as verified, which EmDash requires
	 * before it links an existing user, accepts an invite, or allows
	 * self-signup. By default, only accounts that sign in through a configured
	 * directory (tenant) ID count as verified, and only for an address in the
	 * domain of their sign-in name or confirmed by the `xms_edov` claim;
	 * accounts homed in another directory or identity provider, such as
	 * guests, and sign-ins through `common`, `organizations` or `consumers`
	 * do not.
	 */
	emailVerified?: boolean;
}

/**
 * Configure Microsoft Entra ID as an auth provider.
 *
 * Requires `EMDASH_OAUTH_MICROSOFT_CLIENT_ID`, `EMDASH_OAUTH_MICROSOFT_CLIENT_SECRET`
 * and `EMDASH_OAUTH_MICROSOFT_TENANT_ID` (or `MICROSOFT_CLIENT_ID` /
 * `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID`) environment variables.
 */
export function microsoft(options: MicrosoftProviderOptions = {}): AuthProviderDescriptor {
	return {
		id: "microsoft",
		label: "Microsoft",
		config: options,
		adminEntry: "emdash/auth/providers/microsoft-admin",
	};
}
