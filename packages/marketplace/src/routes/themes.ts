import type { Context, Next } from "hono";
import { Hono } from "hono";
import { jwtVerify } from "jose";
import { z } from "zod";

/** Matches http(s) scheme at start of URL */
const HTTP_SCHEME_RE = /^https?:\/\//i;

/** Validates that a URL string uses http or https scheme. Rejects javascript:/data: URI XSS vectors. */
const httpUrl = z
	.string()
	.url()
	.refine((url) => HTTP_SCHEME_RE.test(url), "URL must use http or https");

import {
	createTheme,
	getTheme,
	getThemeWithAuthor,
	searchThemes,
	updateTheme,
} from "../db/queries.js";
import type { AuthorRow, ThemeSortOption } from "../db/types.js";

// ─��� Types ───────────────────────────────────────────────────────

type AuthEnv = { Bindings: Env; Variables: { author: AuthorRow } };

export const themeRoutes = new Hono<AuthEnv>();

// ── Auth middleware (shared pattern with author.ts) ─────────────

// eslint-disable-next-line typescript-eslint(no-redundant-type-constituents) -- Hono middleware returns Response | void
async function authMiddleware(c: Context<AuthEnv>, next: Next): Promise<Response | void> {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return c.json({ error: "Authorization header required" }, 401);
	}

	const token = header.slice(7);

	try {
		const key = new TextEncoder().encode(c.env.GITHUB_CLIENT_SECRET);
		const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
		if (!payload || typeof payload.sub !== "string") {
			return c.json({ error: "Invalid token" }, 401);
		}

		const author = await c.env.DB.prepare("SELECT * FROM authors WHERE id = ?")
			.bind(payload.sub)
			.first<AuthorRow>();

		if (!author) {
			return c.json({ error: "Author not found" }, 401);
		}

		c.set("author", author);
		return next();
	} catch {
		return c.json({ error: "Invalid or expired token" }, 401);
	}
}

// Apply auth to state-changing methods on /themes/*
themeRoutes.post("/themes/*", authMiddleware);
themeRoutes.put("/themes/*", authMiddleware);

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

// ── POST /themes — Register new theme ───────────────────────────

const createThemeSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(64)
		.regex(
			/^[a-z][a-z0-9-]*$/,
			"ID must start with a letter and contain only lowercase letters, numbers, and hyphens",
		),
	name: z.string().min(1).max(100),
	description: z.string().max(200).optional(),
	previewUrl: httpUrl,
	demoUrl: httpUrl.optional(),
	repositoryUrl: httpUrl.optional(),
	homepageUrl: httpUrl.optional(),
	license: z.string().max(64).optional(),
	keywords: z.array(z.string().max(50)).max(20).optional(),
});

themeRoutes.post("/themes", async (c) => {
	const author = c.get("author");

	let body: z.infer<typeof createThemeSchema>;
	try {
		const raw = await c.req.json();
		body = createThemeSchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Validation error", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	try {
		const existing = await getTheme(c.env.DB, body.id);
		if (existing) {
			return c.json({ error: "Theme ID already exists" }, 409);
		}

		const theme = await createTheme(c.env.DB, {
			id: body.id,
			name: body.name,
			description: body.description,
			authorId: author.id,
			previewUrl: body.previewUrl,
			demoUrl: body.demoUrl,
			repositoryUrl: body.repositoryUrl,
			homepageUrl: body.homepageUrl,
			license: body.license,
			keywords: body.keywords,
		});

		return c.json(theme, 201);
	} catch (err) {
		console.error("Failed to create theme:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── PUT /themes/:id — Update theme metadata ─────────────────────

const updateThemeSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	description: z.string().max(200).optional(),
	previewUrl: httpUrl.optional(),
	demoUrl: httpUrl.optional(),
	repositoryUrl: httpUrl.optional(),
	homepageUrl: httpUrl.optional(),
	license: z.string().max(64).optional(),
	keywords: z.array(z.string().max(50)).max(20).optional(),
});

themeRoutes.put("/themes/:id", async (c) => {
	const author = c.get("author");
	const themeId = c.req.param("id");

	let body: z.infer<typeof updateThemeSchema>;
	try {
		const raw = await c.req.json();
		body = updateThemeSchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Validation error", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	try {
		const theme = await getTheme(c.env.DB, themeId);
		if (!theme) return c.json({ error: "Theme not found" }, 404);
		if (theme.author_id !== author.id) {
			return c.json({ error: "Not authorized to update this theme" }, 403);
		}

		const updated = await updateTheme(c.env.DB, themeId, {
			name: body.name,
			description: body.description,
			previewUrl: body.previewUrl,
			demoUrl: body.demoUrl,
			repositoryUrl: body.repositoryUrl,
			homepageUrl: body.homepageUrl,
			license: body.license,
			keywords: body.keywords,
		});

		return c.json(updated);
	} catch (err) {
		console.error("Failed to update theme:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── PUT /themes/:id/images — Replace thumbnail + screenshots ────

/** Max file size for thumbnails and screenshots (5 MB) */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
/** Max number of screenshots per theme */
const MAX_SCREENSHOTS = 10;
/** Allowed image content types */
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

themeRoutes.put("/themes/:id/images", async (c) => {
	const author = c.get("author");
	const themeId = c.req.param("id");

	try {
		const theme = await getTheme(c.env.DB, themeId);
		if (!theme) return c.json({ error: "Theme not found" }, 404);
		if (theme.author_id !== author.id) {
			return c.json({ error: "Not authorized to update this theme" }, 403);
		}

		const formData = await c.req.formData();

		// Handle thumbnail
		const thumbnailFile = formData.get("thumbnail");
		let hasThumbnail = theme.has_thumbnail === 1;
		if (thumbnailFile instanceof File && thumbnailFile.size > 0) {
			if (thumbnailFile.size > MAX_IMAGE_SIZE) {
				return c.json({ error: `Thumbnail exceeds ${MAX_IMAGE_SIZE / 1024 / 1024}MB limit` }, 400);
			}
			if (!ALLOWED_IMAGE_TYPES.has(thumbnailFile.type)) {
				return c.json({ error: "Thumbnail must be image/png, image/jpeg, or image/webp" }, 400);
			}
			const data = await thumbnailFile.arrayBuffer();
			await c.env.R2.put(`themes/${themeId}/thumbnail.png`, data, {
				httpMetadata: { contentType: thumbnailFile.type },
			});
			hasThumbnail = true;
		}

		// Handle screenshots — numbered screenshot-0.png, screenshot-1.png, etc.
		const screenshotFiles: File[] = [];
		for (const entry of formData.getAll("screenshots")) {
			if (entry instanceof File && entry.size > 0) {
				screenshotFiles.push(entry);
			}
		}

		if (screenshotFiles.length > MAX_SCREENSHOTS) {
			return c.json({ error: `Maximum ${MAX_SCREENSHOTS} screenshots allowed` }, 400);
		}

		for (const file of screenshotFiles) {
			if (file.size > MAX_IMAGE_SIZE) {
				return c.json(
					{ error: `Screenshot "${file.name}" exceeds ${MAX_IMAGE_SIZE / 1024 / 1024}MB limit` },
					400,
				);
			}
			if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
				return c.json(
					{ error: `Screenshot "${file.name}" must be image/png, image/jpeg, or image/webp` },
					400,
				);
			}
		}

		let screenshotCount = theme.screenshot_count;
		if (screenshotFiles.length > 0) {
			// Delete old screenshots
			for (let i = 0; i < theme.screenshot_count; i++) {
				await c.env.R2.delete(`themes/${themeId}/screenshots/screenshot-${i}.png`);
			}
			// Upload new
			for (let i = 0; i < screenshotFiles.length; i++) {
				const file = screenshotFiles[i]!;
				const data = await file.arrayBuffer();
				await c.env.R2.put(`themes/${themeId}/screenshots/screenshot-${i}.png`, data, {
					httpMetadata: { contentType: file.type },
				});
			}
			screenshotCount = screenshotFiles.length;
		}

		const updated = await updateTheme(c.env.DB, themeId, {
			hasThumbnail,
			screenshotCount,
		});

		return c.json(updated);
	} catch (err) {
		console.error("Failed to update theme images:", err);
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
