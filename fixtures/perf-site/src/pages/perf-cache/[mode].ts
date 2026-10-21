export const prerender = false;

import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings, getTaxonomyDefs } from "emdash";

const modes = new Set(["plain", "stored", "unstored"]);

export const GET: APIRoute = async ({ params, cache }) => {
	const mode = params.mode;
	if (!mode || !modes.has(mode)) {
		return Response.json({ error: "Unknown perf-cache mode" }, { status: 404 });
	}

	try {
		const settings = await getSiteSettings();
		const taxonomyDefs = await getTaxonomyDefs();
		const collection = await getEmDashCollection("posts", {
			where: { tag: "webdev" },
		});

		const more = await getEmDashCollection("posts", {
			where: { tag: "opinion" },
		});
		if (collection.error) throw collection.error;
		if (more.error) throw more.error;

		if (mode === "stored" && cache?.enabled) {
			cache.set({ ...collection.cacheHint, maxAge: 60 });
			cache.set(more.cacheHint);
		}

		return Response.json({
			mode,
			routeCacheEnabled: cache?.enabled === true,
			routeCacheMaxAge: cache?.options.maxAge ?? null,
			settings,
			taxonomyDefs: taxonomyDefs.map(({ name }) => name),
			posts: collection.entries.map((entry) => ({ id: entry.id, data: entry.data })),
			morePosts: more.entries.map((entry) => ({ id: entry.id, data: entry.data })),
		});
	} catch {
		return Response.json({ error: "Perf-cache fixture request failed" }, { status: 500 });
	}
};
