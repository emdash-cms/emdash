import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";
import { resolveModernStarterSiteIdentity } from "../utils/site-identity";

export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = site?.toString() || url.origin;
	const { siteTitle, siteTagline } = resolveModernStarterSiteIdentity(await getSiteSettings());
	const { entries: posts } = await getEmDashCollection("posts", {
		orderBy: { published_at: "desc" },
		limit: 20,
	});

	const items = posts
		.map((post) => {
			if (!post.data.publishedAt) return null;
			const postUrl = `${siteUrl}/posts/${post.id}`;
			return `    <item>
      <title>${escapeXml(post.data.title || "Untitled")}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <pubDate>${post.data.publishedAt.toUTCString()}</pubDate>
      <description>${escapeXml(post.data.excerpt || "")}</description>
    </item>`;
		})
		.filter(Boolean)
		.join("
");

	const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <description>${escapeXml(siteTagline)}</description>
    <link>${siteUrl}</link>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

	return new Response(rss, {
		headers: {
			"Content-Type": "application/rss+xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};

const XML_ESCAPE_PATTERNS = [
	[/&/g, "&amp;"],
	[/</g, "&lt;"],
	[/>/g, "&gt;"],
	[/"/g, "&quot;"],
	[/'/g, "&apos;"],
] as const;

function escapeXml(str: string): string {
	let result = str;
	for (const [pattern, replacement] of XML_ESCAPE_PATTERNS) result = result.replace(pattern, replacement);
	return result;
}
