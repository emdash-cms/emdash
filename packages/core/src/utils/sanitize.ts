import {
	SITE_HTML_ALLOWED_ATTRIBUTES,
	SITE_HTML_ALLOWED_SCHEMES,
	SITE_HTML_ALLOWED_TAGS,
	SITE_HTML_IFRAME_HOSTS,
} from "@emdash-cms/admin/html-block";
import sanitizeHtml from "sanitize-html";

/**
 * Sanitize HTML content to prevent XSS attacks.
 *
 * Allows standard formatting tags, images, iframes (from specific providers),
 * and basic attributes. The admin's inline HTML block preview uses the same
 * allowlist.
 */
export function sanitizeContent(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: [...SITE_HTML_ALLOWED_TAGS],
		allowedAttributes: Object.fromEntries(
			Object.entries(SITE_HTML_ALLOWED_ATTRIBUTES).map(([tag, names]) => [tag, [...names]]),
		),
		allowedSchemes: [...SITE_HTML_ALLOWED_SCHEMES],
		allowedIframeHostnames: [...SITE_HTML_IFRAME_HOSTS],
	});
}
