import type { APIRoute } from "astro";
import { getLiveCollection } from "astro:content";

import { pluginPath, publisherPath } from "../lib/registry.js";

export const GET: APIRoute = async ({ site }) => {
	const origin = site ?? new URL("https://plugins.emdashcms.com");
	const result = await getLiveCollection("plugins", { limit: 100 });
	const plugins = (result.entries ?? []).map(({ data }) => {
		const plugin = data.package;
		return new URL(pluginPath(plugin), origin).href;
	});
	const publishers = [
		...new Set(
			(result.entries ?? []).map(({ data }) => new URL(publisherPath(data.package), origin).href),
		),
	];
	const urls = [...publishers, ...plugins];

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<url><loc>${escapeXml(new URL("/", origin).href)}</loc></url>
	${urls.map((url) => `<url><loc>${escapeXml(url)}</loc></url>`).join("\n\t")}
</urlset>`;

	return new Response(body, {
		headers: {
			"content-type": "application/xml; charset=utf-8",
			"cache-control": "public, max-age=300, stale-while-revalidate=3600",
		},
	});
};

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
