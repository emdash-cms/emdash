/**
 * Rate-limit behaviour on POST /_emdash/api/comments/:collection/:contentId.
 *
 * Submitters without a trusted IP share the "unknown" bucket, so rotating
 * the User-Agent doesn't earn a fresh allowance, and concurrent submissions
 * can't exceed the cap.
 *
 * Operators behind a reverse proxy they control should set
 * `trustedProxyHeaders` (or EMDASH_TRUSTED_PROXY_HEADERS) so this path
 * isn't hit for legitimate traffic. Those tests live alongside the
 * extractRequestMeta unit tests.
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postComment } from "../../../src/astro/routes/api/comments/[collection]/[contentId]/index.js";
import { _resetTrustedProxyHeadersCache } from "../../../src/auth/trusted-proxy.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// Keep the env-derived trusted-header cache from leaking into this file
// (a stale EMDASH_TRUSTED_PROXY_HEADERS would route every UA to its own
// bucket and make the test pass for the wrong reason).
const ORIGINAL_TRUSTED_ENV = process.env.EMDASH_TRUSTED_PROXY_HEADERS;

function buildRequest(opts: { userAgent?: string; body: unknown }): Request {
	return new Request("http://localhost/_emdash/api/comments/post/post-1", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(opts.userAgent ? { "user-agent": opts.userAgent } : {}),
		},
		body: JSON.stringify(opts.body),
	});
}

function buildContext(opts: {
	db: Kysely<Database>;
	request: Request;
	beforeCreateDelayMs?: number;
}): APIContext {
	return {
		params: { collection: "post", contentId: "post-1" },
		request: opts.request,
		locals: {
			emdash: {
				db: opts.db,
				config: {},
				hooks: {
					// Pass-through beforeCreate (returns the event unchanged). The
					// optional delay stands in for a slow plugin hook such as a
					// remote spam check.
					runCommentBeforeCreate: async (event: unknown) => {
						if (opts.beforeCreateDelayMs) {
							await new Promise((resolve) => setTimeout(resolve, opts.beforeCreateDelayMs));
						}
						return event;
					},
					// No moderator configured — returns null (route coerces to pending).
					invokeExclusiveHook: async () => null,
					runCommentAfterCreate: async () => undefined,
				},
			},
			user: null,
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

describe("POST /comments rate limit", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		// Pin the clock inside one 10-minute window; timers stay real.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
		delete process.env.EMDASH_TRUSTED_PROXY_HEADERS;
		_resetTrustedProxyHeadersCache();
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			commentsEnabled: true,
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		// Create a published content row so the comment route can target it.
		await db
			.insertInto("ec_post" as never)
			.values({
				id: "post-1",
				slug: "post-1",
				status: "published",
				published_at: new Date().toISOString(),
				title: "Test post",
			} as never)
			.execute();
	});

	afterEach(async () => {
		vi.useRealTimers();
		await teardownTestDatabase(db);
		if (ORIGINAL_TRUSTED_ENV === undefined) {
			delete process.env.EMDASH_TRUSTED_PROXY_HEADERS;
		} else {
			process.env.EMDASH_TRUSTED_PROXY_HEADERS = ORIGINAL_TRUSTED_ENV;
		}
		_resetTrustedProxyHeadersCache();
	});

	it("buckets no-trusted-IP requests together regardless of User-Agent", async () => {
		// Submit 20 comments from different UA strings but without any
		// trusted IP header. The limit for the "unknown" bucket is 20/10min.
		// Before the fix, rotating UAs would give each request its own
		// bucket; with the fix, they share the "unknown" bucket.
		for (let i = 0; i < 20; i++) {
			const res = await postComment(
				buildContext({
					db,
					request: buildRequest({
						userAgent: `Bot/${i}`,
						body: {
							authorName: "Spam",
							authorEmail: "s@example.com",
							body: `message ${i}`,
						},
					}),
				}),
			);
			expect([200, 201]).toContain(res.status);
		}

		// 21st call with a fresh UA must still hit the shared bucket and
		// get rate-limited.
		const limitedRes = await postComment(
			buildContext({
				db,
				request: buildRequest({
					userAgent: "Bot/fresh",
					body: {
						authorName: "Spam",
						authorEmail: "s@example.com",
						body: "one more",
					},
				}),
			}),
		);
		expect(limitedRes.status).toBe(429);
		expect(limitedRes.headers.get("Retry-After")).toBe("600");
	});

	it("enforces the limit for concurrent submissions", async () => {
		const responses = await Promise.all(
			Array.from({ length: 30 }, async (_, i) =>
				postComment(
					buildContext({
						db,
						beforeCreateDelayMs: 20,
						request: buildRequest({
							body: {
								authorName: "Spam",
								authorEmail: "s@example.com",
								body: `burst ${i}`,
							},
						}),
					}),
				),
			),
		);
		const statuses = responses.map((res) => res.status);
		expect(statuses.filter((status) => status === 429)).toHaveLength(10);

		const stored = await db
			.selectFrom("_emdash_comments")
			.select((eb) => eb.fn.countAll<number>().as("n"))
			.executeTakeFirstOrThrow();
		expect(Number(stored.n)).toBe(20);
	});
});
