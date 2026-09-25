/**
 * Image link normalisation.
 *
 * A Portable Text image block carries its optional link in one of two shapes:
 *
 * - `{ href, blank? }` — the canonical shape the editor writes
 * - `"https://…"` — a bare string, emitted by `gutenberg-to-portable-text`
 *   for linked images and therefore present on WordPress-imported content
 *
 * Every consumer reads through this helper so the legacy shape keeps working
 * and is upgraded to the canonical shape the first time the block round-trips
 * through the editor.
 */
import type { PortableTextImageLink } from "./types.js";

export function normalizeImageLink(raw: unknown): PortableTextImageLink | null {
	if (typeof raw === "string") {
		const href = raw.trim();
		return href ? { href } : null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { href, blank } = raw as { href?: unknown; blank?: unknown };
	if (typeof href !== "string") return null;
	const trimmed = href.trim();
	if (!trimmed) return null;
	return blank === true ? { href: trimmed, blank: true } : { href: trimmed };
}
