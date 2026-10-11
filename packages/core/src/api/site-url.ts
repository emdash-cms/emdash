/**
 * Resolve the canonical site base URL for use in outbound links (emails, etc.).
 *
 * Precedence: the operator-configured origin (`config.siteUrl`, then the
 * `EMDASH_SITE_URL`/`SITE_URL` env vars), then the selected site's **Site URL**
 * setting, then the request URL. A configured or stored value beats the
 * request, so Host header spoofing cannot override it.
 */

import type { Kysely } from "kysely";

import { SiteSettingsRepository, selectedSiteId } from "../database/repositories/site-settings.js";
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
 * Resolve an origin from explicit configuration and stored values.
 * `setupUrl` is retained for callers that resolve legacy setup data.
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
 * The origin chosen for the selected site: the configured origin, then its **Site URL**.
 */
export async function getChosenSiteOrigin(
	db: Kysely<Database>,
	config?: SiteUrlConfig,
): Promise<string | undefined> {
	selectedSiteId();
	return (
		getConfiguredOrigin(config) ??
		siteUrlSettingOrigin(await new SiteSettingsRepository(db).get("url"))
	);
}

export async function getSiteBaseUrl(
	db: Kysely<Database>,
	request: Request,
	config?: SiteUrlConfig,
): Promise<string> {
	selectedSiteId();
	const configured = getConfiguredOrigin(config);
	if (configured) {
		return `${configured}/_emdash`;
	}
	const storedUrl = resolveSiteOrigin(
		config,
		await new SiteSettingsRepository(db).get("url"),
		undefined,
	);
	if (storedUrl) {
		return `${storedUrl}/_emdash`;
	}
	// The host must resolve this request before the URL can be used.
	const url = new URL(request.url);
	return `${url.protocol}//${url.host}/_emdash`;
}
