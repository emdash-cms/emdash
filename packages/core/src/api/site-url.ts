/**
 * Resolve the canonical site base URL for use in outbound links (emails, etc.).
 *
 * Precedence: the operator-configured origin (`config.siteUrl`, then the
 * `EMDASH_SITE_URL`/`SITE_URL` env vars), then the **Site URL** an admin set
 * in Settings > General (`site:url`, origin only), then the `emdash:site_url` option
 * written once during setup, and only before setup completes the request URL.
 * A configured or stored value always beats the request, so Host header
 * spoofing cannot redirect users to attacker-controlled domains.
 */

import type { Kysely } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";
import { getConfiguredOrigin, type SiteUrlConfig } from "./public-url.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Sign-in tokens travel in these links, so plain HTTP is only accepted for loopback hosts. */
function siteUrlSettingOrigin(value: unknown): string | undefined {
	if (typeof value !== "string" || !URL.canParse(value)) return undefined;
	const url = new URL(value);
	if (url.protocol === "https:") return url.origin;
	if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
	return undefined;
}

/**
 * The site's public origin for outbound links, in the precedence order
 * described above. `siteUrlSetting` and `setupUrl` are the stored
 * `site:url` and `emdash:site_url` option values.
 */
export function resolveSiteOrigin(
	config: SiteUrlConfig | undefined,
	siteUrlSetting: unknown,
	setupUrl: unknown,
): string | undefined {
	return (
		getConfiguredOrigin(config) ??
		siteUrlSettingOrigin(siteUrlSetting) ??
		(typeof setupUrl === "string" && setupUrl ? setupUrl : undefined)
	);
}

/**
 * The origin chosen for the site: the configured origin, then the **Site URL**.
 * Unlike `getSiteBaseUrl`, it never falls back to the origin recorded during
 * setup, which may be an address the site has since moved away from.
 */
export async function getChosenSiteOrigin(
	db: Kysely<Database>,
	config?: SiteUrlConfig,
): Promise<string | undefined> {
	return (
		getConfiguredOrigin(config) ??
		siteUrlSettingOrigin(await new OptionsRepository(db).get("site:url"))
	);
}

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
	const stored = await options.getMany(["site:url", "emdash:site_url"]);
	const storedUrl = resolveSiteOrigin(
		config,
		stored.get("site:url"),
		stored.get("emdash:site_url"),
	);
	if (storedUrl) {
		return `${storedUrl}/_emdash`;
	}
	// Fallback: derive from request (only reached before setup completes)
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}/_emdash`;
}
