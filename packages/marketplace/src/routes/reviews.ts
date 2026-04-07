import type { Context, Next } from "hono";
import { Hono } from "hono";
import { jwtVerify } from "jose";
import { z } from "zod";

import {
	addPublisherReply,
	createReview,
	deleteReview,
	getPlugin,
	getPluginReviews,
	updateReview,
} from "../db/queries.js";
import type { AuthorRow } from "../db/types.js";

// ── Types ───────────────────────────────────────────────────────

type ReviewEnv = { Bindings: Env; Variables: { author: AuthorRow } };

export const reviewRoutes = new Hono<ReviewEnv>();

// ── Auth middleware (JWT only, no seed token) ───────────────────

// eslint-disable-next-line typescript-eslint(no-redundant-type-constituents) -- Hono middleware returns Response | void
async function reviewAuthMiddleware(c: Context<ReviewEnv>, next: Next): Promise<Response | void> {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return c.json({ error: "Authorization header required" }, 401);
	}

	const token = header.slice(7);

	try {
		const key = new TextEncoder().encode(c.env.GITHUB_CLIENT_SECRET);
		const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
		if (!payload.sub || typeof payload.sub !== "string") {
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

// Auth required for write operations
reviewRoutes.post("/plugins/:id/reviews", reviewAuthMiddleware);
reviewRoutes.put("/plugins/:id/reviews/*", reviewAuthMiddleware);
reviewRoutes.delete("/plugins/:id/reviews/*", reviewAuthMiddleware);
reviewRoutes.post("/plugins/:id/reviews/*/reply", reviewAuthMiddleware);

// ── Rate limiting (simple in-memory, per author) ────────────────

const REVIEW_RATE_LIMIT_MS = 60_000; // 1 review per minute per author
const MAX_TRACKED_AUTHORS = 1000;
const recentReviews = new Map<string, number>();

function pruneRecentReviews(now: number): void {
	for (const [key, ts] of recentReviews) {
		if (now - ts > REVIEW_RATE_LIMIT_MS) {
			recentReviews.delete(key);
		} else {
			break;
		}
	}
	// Hard cap: evict oldest entries if still over limit
	while (recentReviews.size > MAX_TRACKED_AUTHORS) {
		const oldest = recentReviews.keys().next().value;
		if (oldest === undefined) break;
		recentReviews.delete(oldest);
	}
}

function isRateLimited(authorId: string): boolean {
	const now = Date.now();
	pruneRecentReviews(now);
	const last = recentReviews.get(authorId);
	return !!last && now - last < REVIEW_RATE_LIMIT_MS;
}

function recordRateLimit(authorId: string): void {
	recentReviews.delete(authorId);
	recentReviews.set(authorId, Date.now());
}

/** Reset rate limiter state. Exported for tests only. */
export function resetRateLimiter(): void {
	recentReviews.clear();
}

// ── GET /plugins/:id/reviews — List reviews ─────────────────────

reviewRoutes.get("/plugins/:id/reviews", async (c) => {
	const pluginId = c.req.param("id");
	const url = new URL(c.req.url);
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limitStr = url.searchParams.get("limit");
	const limit = limitStr ? parseInt(limitStr, 10) : undefined;

	try {
		const result = await getPluginReviews(c.env.DB, pluginId, { cursor, limit });

		const items = result.items.map((r) => ({
			id: r.id,
			pluginId: r.plugin_id,
			author: {
				id: r.author_id,
				name: r.author_name,
				avatarUrl: r.author_avatar_url,
			},
			rating: r.rating,
			body: r.body,
			publisherReply: r.publisher_reply,
			repliedAt: r.replied_at,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		}));

		return c.json({ items, nextCursor: result.nextCursor });
	} catch (err) {
		console.error("Failed to list reviews:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── POST /plugins/:id/reviews — Submit review ──────────────────

const createReviewSchema = z.object({
	rating: z.number().int().min(1).max(5),
	body: z.string().max(5000).optional(),
});

reviewRoutes.post("/plugins/:id/reviews", async (c) => {
	const pluginId = c.req.param("id");
	const author = c.get("author");

	let body: z.infer<typeof createReviewSchema>;
	try {
		const raw = await c.req.json();
		body = createReviewSchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Validation error", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	if (isRateLimited(author.id)) {
		return c.json({ error: "Too many reviews. Please wait before submitting another." }, 429);
	}

	try {
		// Verify plugin exists
		const plugin = await getPlugin(c.env.DB, pluginId);
		if (!plugin) return c.json({ error: "Plugin not found" }, 404);

		const review = await createReview(c.env.DB, {
			pluginId,
			authorId: author.id,
			rating: body.rating,
			body: body.body,
		});

		// Only record rate limit after successful creation
		recordRateLimit(author.id);

		return c.json(
			{
				id: review.id,
				pluginId: review.plugin_id,
				rating: review.rating,
				body: review.body,
				createdAt: review.created_at,
			},
			201,
		);
	} catch (err) {
		// UNIQUE constraint violation = already reviewed
		if (err instanceof Error && err.message.includes("UNIQUE")) {
			return c.json({ error: "You have already reviewed this plugin" }, 409);
		}
		console.error("Failed to create review:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── PUT /plugins/:id/reviews/:reviewId — Update own review ─────

const updateReviewSchema = z.object({
	rating: z.number().int().min(1).max(5).optional(),
	body: z.string().max(5000).optional(),
});

reviewRoutes.put("/plugins/:id/reviews/:reviewId", async (c) => {
	const pluginId = c.req.param("id");
	const reviewId = c.req.param("reviewId");
	const author = c.get("author");

	let body: z.infer<typeof updateReviewSchema>;
	try {
		const raw = await c.req.json();
		body = updateReviewSchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Validation error", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	try {
		const updated = await updateReview(c.env.DB, reviewId, author.id, body, pluginId);
		if (!updated) return c.json({ error: "Review not found or not yours" }, 404);

		return c.json({
			id: updated.id,
			rating: updated.rating,
			body: updated.body,
			updatedAt: updated.updated_at,
		});
	} catch (err) {
		console.error("Failed to update review:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── DELETE /plugins/:id/reviews/:reviewId — Delete own review ──

reviewRoutes.delete("/plugins/:id/reviews/:reviewId", async (c) => {
	const pluginId = c.req.param("id");
	const reviewId = c.req.param("reviewId");
	const author = c.get("author");

	try {
		const result = await deleteReview(c.env.DB, reviewId, author.id, pluginId);
		if (!result.deleted) return c.json({ error: "Review not found or not yours" }, 404);

		return c.json({ ok: true });
	} catch (err) {
		console.error("Failed to delete review:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── POST /plugins/:id/reviews/:reviewId/reply — Publisher reply ─

const replySchema = z.object({
	body: z.string().min(1).max(2000),
});

reviewRoutes.post("/plugins/:id/reviews/:reviewId/reply", async (c) => {
	const pluginId = c.req.param("id");
	const reviewId = c.req.param("reviewId");
	const author = c.get("author");

	let body: z.infer<typeof replySchema>;
	try {
		const raw = await c.req.json();
		body = replySchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Validation error", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	try {
		const updated = await addPublisherReply(c.env.DB, reviewId, author.id, body.body, pluginId);
		if (!updated) {
			return c.json({ error: "Review not found or you don't own the plugin" }, 404);
		}

		return c.json({
			id: updated.id,
			publisherReply: updated.publisher_reply,
			repliedAt: updated.replied_at,
		});
	} catch (err) {
		console.error("Failed to add publisher reply:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});
