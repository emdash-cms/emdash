/**
 * Site identity head injection.
 *
 * Emits first-party `<head>` tags sourced from the user-configured Site
 * Identity. These are rendered alongside, but separate from, the plugin
 * contribution pipeline (`page/metadata.ts`) because:
 *
 * - Site identity is first-party, not plugin-supplied. The contribution
 *   pipeline's `isSafeHref` allowlist rejects same-origin paths like
 *   `/_emdash/api/media/file/...` (which is correct for sandboxed plugin
 *   contributions, but blocks our own favicon URLs).
 * - The data shape is fixed and small. Routing it through a generic
 *   deduper buys nothing.
 *
 * Currently emits only `<link rel="icon">`. Other site-identity tags
 * (`apple-touch-icon`, `theme-color`, `application-name`) need their own
 * configurable fields in `SiteSettings` before they ship; emitting them
 * automatically from the favicon would produce broken icons on iOS for
 * SVG favicons or blurry home-screen icons when the favicon is a small
 * PNG. Tracked separately.
 *
 * Templates that previously emitted their own `<link rel="icon">` are
 * getting their lines dropped in the same change that introduced this
 * helper.
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
