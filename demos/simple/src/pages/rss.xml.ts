import type { APIRoute } from "astro";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { getEmDashCollection, getRequestContext, getSiteSettings, runWithContext } from "emdash";
import { PortableText } from "emdash/ui";

import { getSiteLocale } from "../utils/locale";
import { absoluteFeedUrls, cdata, escapeXml } from "../utils/rss";
import { resolveBlogSiteIdentity } from "../utils/site-identity";

export const GET: APIRoute = async ({ site, url, locals, request }) =>
	runWithContext({ ...getRequestContext(), editMode: false, preview: undefined }, async () => {
		const siteUrl = site ?? new URL(url.origin);
		const { siteTitle, siteTagline } = resolveBlogSiteIdentity(await getSiteSettings());
		const { entries: posts } = await getEmDashCollection("posts", {
			status: "published",
			orderBy: { published_at: "desc" },
			limit: 20,
		});
		const renderer = posts.length > 0 ? await AstroContainer.create() : undefined;
		const items = await Promise.all(
			posts.map(async (post) => {
				if (!post.data.publishedAt) return null;
				const postUrl = new URL(`/posts/${post.id}`, siteUrl).href;
				const content =
					Array.isArray(post.data.content) && post.data.content.length > 0
						? await renderer!.renderToString(PortableText, {
								props: { value: post.data.content },
								locals,
								request,
							})
						: "";
				return `    <item>
      <title>${escapeXml(post.data.title || "Untitled")}</title>
      <link>${escapeXml(postUrl)}</link>
      <guid isPermaLink="true">${escapeXml(postUrl)}</guid>
      <pubDate>${post.data.publishedAt.toUTCString()}</pubDate>
      <description>${escapeXml(post.data.excerpt || "")}</description>${
				content
					? `
      <content:encoded>${cdata(absoluteFeedUrls(content, postUrl))}</content:encoded>`
					: ""
			}
    </item>`;
			}),
		);

		const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <description>${escapeXml(siteTagline)}</description>
    <link>${escapeXml(siteUrl.href)}</link>
    <atom:link href="${escapeXml(new URL("/rss.xml", siteUrl).href)}" rel="self" type="application/rss+xml"/>
    <language>${escapeXml(getSiteLocale() ?? "en-us")}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.filter(Boolean).join("\n")}
  </channel>
</rss>`;

		return new Response(rss, {
			headers: {
				"Content-Type": "application/rss+xml; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		});
	});
