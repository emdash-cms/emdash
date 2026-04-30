/**
 * Site identity head injection.
 *
 * Emits first-party `<head>` tags sourced from the user-configured Site
 * Identity (favicon, etc.). These are rendered alongside, but separate
 * from, the plugin contribution pipeline (`page/metadata.ts`) because:
 *
 * - Site identity is first-party, not plugin-supplied. The contribution
 *   pipeline's `isSafeHref` allowlist rejects same-origin paths like
 *   `/_emdash/api/media/file/...` (which is correct for sandboxed plugin
 *   contributions, but blocks our own favicon URLs).
 * - The data shape is fixed and small (favicon today, apple-touch-icon
 *   and theme-color later). Routing it through a generic deduper buys
 *   nothing.
 *
 * Templates that already emit their own `<link rel="icon">` continue to
 * work; browsers tolerate the duplicate. A follow-up cleanup can remove
 * the per-template line once this has shipped.
 */

import type { MediaReference } from "../settings/types.js";
import { escapeHtmlAttr } from "./metadata.js";

/**
 * Subset of site settings consumed by `renderSiteIdentity`. Kept narrow
 * so callers don't have to fetch fields they don't use.
 */
export interface SiteIdentityInput {
	favicon?: MediaReference;
}

/**
 * Build the `<head>` HTML for site identity tags. Returns an empty string
 * when no identity fields are configured.
 */
export function renderSiteIdentity(input: SiteIdentityInput | undefined): string {
	if (!input) return "";

	const parts: string[] = [];

	const favicon = input.favicon;
	if (favicon?.url) {
		let tag = `<link rel="icon" href="${escapeHtmlAttr(favicon.url)}"`;
		if (favicon.contentType) {
			tag += ` type="${escapeHtmlAttr(favicon.contentType)}"`;
		}
		tag += ">";
		parts.push(tag);
	}

	return parts.join("\n");
}
