import { Hono } from "hono";

import { getThemeWithAuthor, searchThemes } from "../db/queries.js";
import type { ThemeSortOption } from "../db/types.js";

export const themeRoutes = new Hono<{ Bindings: Env }>();

// ── GET /themes — Search/list themes ────────────────────────────

const VALID_THEME_SORTS = new Set<ThemeSortOption>(["name", "created", "updated"]);

themeRoutes.get("/themes", async (c) => {
	const url = new URL(c.req.url);
	const q = url.searchParams.get("q") ?? undefined;
	const keyword = url.searchParams.get("keyword") ?? undefined;
	const sortParam = url.searchParams.get("sort");
	let sort: ThemeSortOption | undefined;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- validated by VALID_THEME_SORTS.has()
	if (sortParam && VALID_THEME_SORTS.has(sortParam as ThemeSortOption)) {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- validated by VALID_THEME_SORTS.has() on the line above
		sort = sortParam as ThemeSortOption;
	}
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limitStr = url.searchParams.get("limit");
	const limit = limitStr ? parseInt(limitStr, 10) : undefined;

	const baseUrl = url.origin;

	try {
		const result = await searchThemes(c.env.DB, { q, keyword, sort, cursor, limit });

		const items = result.items.map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			author: {
				name: row.author_name,
				verified: row.author_verified === 1,
				avatarUrl: row.author_avatar_url,
			},
			keywords: safeJsonParse<string[]>(row.keywords, []),
			previewUrl: row.preview_url,
			demoUrl: row.demo_url,
			hasThumbnail: row.has_thumbnail === 1,
			thumbnailUrl: row.has_thumbnail ? `${baseUrl}/api/v1/themes/${row.id}/thumbnail` : null,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));

		return c.json({ items, nextCursor: result.nextCursor });
	} catch (err) {
		console.error("Failed to search themes:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── GET /themes/:id — Theme detail ──────────────────────────────

themeRoutes.get("/themes/:id", async (c) => {
	const id = c.req.param("id");
	const baseUrl = new URL(c.req.url).origin;

	try {
		const theme = await getThemeWithAuthor(c.env.DB, id);
		if (!theme) return c.json({ error: "Theme not found" }, 404);

		const keywords = safeJsonParse<string[]>(theme.keywords, []);

		const screenshotUrls: string[] = [];
		for (let i = 0; i < theme.screenshot_count; i++) {
			screenshotUrls.push(`${baseUrl}/api/v1/themes/${id}/screenshots/screenshot-${i}.png`);
		}

		return c.json({
			id: theme.id,
			name: theme.name,
			description: theme.description,
			author: {
				id: theme.author_id,
				name: theme.author_name,
				verified: theme.author_verified === 1,
				avatarUrl: theme.author_avatar_url,
			},
			keywords,
			previewUrl: theme.preview_url,
			demoUrl: theme.demo_url,
			repositoryUrl: theme.repository_url,
			homepageUrl: theme.homepage_url,
			license: theme.license,
			hasThumbnail: theme.has_thumbnail === 1,
			thumbnailUrl: theme.has_thumbnail ? `${baseUrl}/api/v1/themes/${id}/thumbnail` : null,
			screenshotCount: theme.screenshot_count,
			screenshotUrls,
			createdAt: theme.created_at,
			updatedAt: theme.updated_at,
		});
	} catch (err) {
		console.error("Failed to get theme:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── Helpers ─────────────────────────────────────────────────────

function safeJsonParse<T>(value: string | null, fallback: T): T {
	if (!value) return fallback;
	try {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- caller provides type parameter
		const parsed: T = JSON.parse(value);
		return parsed;
	} catch {
		return fallback;
	}
}
