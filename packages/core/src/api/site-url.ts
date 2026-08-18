/**
 * Resolve the canonical site base URL for use in outbound links (emails, etc.).
 *
 * Precedence mirrors `getPublicOrigin`: the operator-configured origin
 * (`config.siteUrl`, then the `EMDASH_SITE_URL`/`SITE_URL` env vars) wins,
 * then the stored `emdash:site_url` option (written once during setup on the
 * real domain), and only before setup completes does the request URL fill in.
 * A configured or stored value always beats the request, so Host header
 * spoofing cannot redirect users to attacker-controlled domains.
 */

import type { Kysely } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";
import { getConfiguredOrigin, type SiteUrlConfig } from "./public-url.js";

export async function getSiteBaseUrl(
	db: Kysely<Database>,
	request: Request,
	config?: SiteUrlConfig,
): Promise<string> {
	const configured = getConfiguredOrigin(config);
	if (configured) {
		return `${configured}/_emdash`;
	}
	const options = new OptionsRepository(db);
	const storedUrl = await options.get<string>("emdash:site_url");
	if (storedUrl) {
		return `${storedUrl}/_emdash`;
	}
	// Fallback: derive from request (only reached before setup completes)
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}/_emdash`;
}
