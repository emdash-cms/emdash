/**
 * Resolves a Bluesky post reference (bsky.app URL or AT-URI) to the
 * canonical `https://bsky.app/profile/{authority}/post/{rkey}` form
 * that Bluesky's oEmbed endpoint accepts.
 */

const BSKY_POST_URL_RE = /^https?:\/\/(?:staging\.)?bsky\.app\/profile\/[^/]+\/post\/[^/?#]+/i;
const AT_URI_POST_RE = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/;

export function resolveBlueskyPostUrl(postId: string): string | null {
	const trimmed = postId.trim();

	const atMatch = AT_URI_POST_RE.exec(trimmed);
	if (atMatch) {
		const [, authority, rkey] = atMatch;
		return `https://bsky.app/profile/${authority}/post/${rkey}`;
	}

	if (BSKY_POST_URL_RE.test(trimmed)) {
		return trimmed;
	}

	return null;
}
