import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";

const siteTitle = "My Blog";
const siteDescription = "Thoughts, stories, and ideas.";

export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = site?.toString() || url.origin;

	const { entries: posts } = await getEmDashCollection("posts", {
		orderBy: { published_at: "desc" },
		limit: 20,
	});

	const XML_ESCAPE: Array<[RegExp, string]> = [
		[/&/g, "&amp;"],
		[/</g, "&lt;"],
		[/>/g, "&gt;"],
		[/"/g, "&quot;"],
		[/'/g, "&apos;"],
	];

	function esc(str: string): string {
		return XML_ESCAPE.reduce((s, [p, r]) => s.replace(p, r), str);
	}

	const items = posts
		.filter((p) => !!p.data.publishedAt)
		.map((post) => {
			const postUrl = `${siteUrl}/posts/${post.id}`;
			return `    <item>
      <title>${esc(post.data.title || "Untitled")}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <pubDate>${post.data.publishedAt!.toUTCString()}</pubDate>
      <description>${esc(post.data.excerpt || "")}</description>
    </item>`;
		})
		.join("\n");

	const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(siteTitle)}</title>
    <description>${esc(siteDescription)}</description>
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
