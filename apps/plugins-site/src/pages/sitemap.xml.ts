import type { APIRoute } from "astro";

import { searchCatalog } from "../lib/catalog.js";
import { pluginPath, publisherPath } from "../lib/registry.js";

export const GET: APIRoute = async ({ site }) => {
	const origin = site ?? new URL("https://plugins.emdashcms.com");
	const result = await searchCatalog("");
	if ("error" in result) {
		return new Response(null, { status: 503, headers: { "retry-after": "30" } });
	}
	const plugins = result.packages.map((plugin) => new URL(pluginPath(plugin), origin).href);
	const publishers = [
		...new Set(result.packages.map((plugin) => new URL(publisherPath(plugin), origin).href)),
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
