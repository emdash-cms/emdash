/**
 * Page fragment collection and rendering
 *
 * Collects raw markup / script contributions from trusted plugins via
 * the page:fragments hook. Sandboxed plugins are never invoked.
 */

import type { PageFragmentContribution, PagePlacement } from "../plugins/types.js";
import { escapeHtmlAttr } from "./metadata.js";

/** Escape sequences that would break out of a script tag */
const SCRIPT_CLOSE_RE = /<\//g;

// ── Dedupe and filter ───────────────────────────────────────────

/**
 * Filter contributions to a specific placement and deduplicate.
 * - Contributions with the same `key + placement` are deduped (first wins).
 * - External scripts with the same `src + placement` are deduped.
 */
export function resolveFragments(
	contributions: PageFragmentContribution[],
	placement: PagePlacement,
): PageFragmentContribution[] {
	const filtered = contributions.filter((c) => c.placement === placement);
	const seen = new Set<string>();
	const result: PageFragmentContribution[] = [];

	for (const c of filtered) {
		// Key-based dedupe
		if (c.key) {
			const dedupeKey = `key:${c.key}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
		} else if (c.kind === "external-script") {
			const dedupeKey = `src:${c.src}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
		}

		result.push(c);
	}

	return result;
}

// ── HTML rendering ──────────────────────────────────────────────

const EVENT_HANDLER_RE = /^on/i;

function renderAttributes(attrs: Record<string, string>): string {
	return Object.entries(attrs)
		.filter(([k]) => !EVENT_HANDLER_RE.test(k))
		.map(([k, v]) => ` ${escapeHtmlAttr(k)}="${escapeHtmlAttr(v)}"`)
		.join("");
}

/** Render a single fragment contribution to HTML */
function renderFragment(c: PageFragmentContribution, nonce?: string): string {
	const nonceAttr = nonce ? ` nonce="${escapeHtmlAttr(nonce)}"` : "";
	switch (c.kind) {
		case "external-script": {
			let tag = `<script src="${escapeHtmlAttr(c.src)}"${nonceAttr}`;
			if (c.async) tag += " async";
			if (c.defer) tag += " defer";
			if (c.attributes) tag += renderAttributes(c.attributes);
			tag += "></script>";
			return tag;
		}
		case "inline-script": {
			let tag = `<script${nonceAttr}`;
			if (c.attributes) tag += renderAttributes(c.attributes);
			// Escape </ to <\/ to prevent breaking out of the script tag.
			// This is valid JS and protects against code built from user data.
			tag += `>${c.code.replace(SCRIPT_CLOSE_RE, "<\\/")}</script>`;
			return tag;
		}
		case "html":
			return c.html;
	}
}

/** Render a list of fragment contributions to an HTML string */
export function renderFragments(
	contributions: PageFragmentContribution[],
	placement: PagePlacement,
	nonce?: string,
): string {
	const resolved = resolveFragments(contributions, placement);
	return resolved.map((c) => renderFragment(c, nonce)).join("\n");
}
