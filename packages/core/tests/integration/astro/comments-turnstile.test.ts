/**
 * Server-side Turnstile enforcement on
 * POST /_emdash/api/comments/:collection/:contentId (issue #1589).
 *
 * The form widget submits a `turnstileToken`, but the route previously
 * never verified it — a bot POSTing directly to the API bypassed
 * Turnstile entirely. When a secret key is configured
 * (EMDASH_TURNSTILE_SECRET_KEY / TURNSTILE_SECRET_KEY), the route must
 * verify the token via Cloudflare's siteverify before persisting, and
 * reject submissions without a valid token. Without a configured secret
 * the behavior is unchanged (backward compatible).
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postComment } from "../../../src/astro/routes/api/comments/[collection]/[contentId]/index.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildRequest(body: Record<string, unknown>, headers?: Record<string, string>): Request {
	return new Request("http://localhost/_emdash/api/comments/post/post-1", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function buildContext(
	db: Kysely<Database>,
	request: Request,
	config: Record<string, unknown> = {},
): APIContext {
	return {
		params: { collection: "post", contentId: "post-1" },
		request,
		locals: {
			emdash: {
				db,
				config,
				hooks: {
					runCommentBeforeCreate: async (event: unknown) => event,
					invokeExclusiveHook: async () => null,
					runCommentAfterCreate: async () => undefined,
				},
			},
			user: null,
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

const VALID_BODY = {
	authorName: "Alice",
	authorEmail: "alice@example.com",
	body: "Nice post!",
};

/** Stub global fetch for the siteverify call; returns the spy. */
function stubSiteverify(success: boolean) {
	const fetchSpy = vi.fn(async () =>
		Response.json(success ? { success: true } : { success: false, "error-codes": ["bad-token"] }),
	);
	vi.stubGlobal("fetch", fetchSpy);
	return fetchSpy;
}

describe("POST /comments — Turnstile verification", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			commentsEnabled: true,
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
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
		await teardownTestDatabase(db);
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	async function commentCount(): Promise<number> {
		const rows = await db.selectFrom("_emdash_comments").select("id").execute();
		return rows.length;
	}

	it("rejects a submission without a token when a secret is configured", async () => {
		vi.stubEnv("EMDASH_TURNSTILE_SECRET_KEY", "test-secret");
		const fetchSpy = stubSiteverify(true);

		const res = await postComment(buildContext(db, buildRequest(VALID_BODY)));

		expect(res.status).toBe(403);
		// No siteverify subrequest for a missing token
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await commentCount()).toBe(0);
	});

	it("rejects a submission whose token fails siteverify", async () => {
		vi.stubEnv("EMDASH_TURNSTILE_SECRET_KEY", "test-secret");
		const fetchSpy = stubSiteverify(false);

		const res = await postComment(
			buildContext(db, buildRequest({ ...VALID_BODY, turnstileToken: "forged" })),
		);

		expect(res.status).toBe(403);
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(await commentCount()).toBe(0);
	});

	it("accepts a submission whose token passes siteverify", async () => {
		vi.stubEnv("EMDASH_TURNSTILE_SECRET_KEY", "test-secret");
		const fetchSpy = stubSiteverify(true);

		const res = await postComment(
			buildContext(db, buildRequest({ ...VALID_BODY, turnstileToken: "valid-token" })),
		);

		expect(res.status).toBe(201);
		expect(fetchSpy).toHaveBeenCalledOnce();
		// The secret and token must reach siteverify
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- shape fixed by the code under test
		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
		expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
		expect(JSON.parse(init.body)).toMatchObject({
			secret: "test-secret",
			response: "valid-token",
		});
		expect(await commentCount()).toBe(1);
	});

	it("forwards the trusted remote IP to siteverify", async () => {
		vi.stubEnv("EMDASH_TURNSTILE_SECRET_KEY", "test-secret");
		const fetchSpy = stubSiteverify(true);

		const request = buildRequest(
			{ ...VALID_BODY, turnstileToken: "valid-token" },
			{ "x-forwarded-for": "203.0.113.45" },
		);
		const res = await postComment(
			buildContext(db, request, { trustedProxyHeaders: ["x-forwarded-for"] }),
		);

		expect(res.status).toBe(201);
		expect(fetchSpy).toHaveBeenCalledOnce();
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- shape fixed by the code under test
		const [, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
		expect(JSON.parse(init.body)).toMatchObject({
			secret: "test-secret",
			response: "valid-token",
			remoteip: "203.0.113.45",
		});
	});

	it("fails closed when siteverify itself errors", async () => {
		vi.stubEnv("EMDASH_TURNSTILE_SECRET_KEY", "test-secret");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);

		const res = await postComment(
			buildContext(db, buildRequest({ ...VALID_BODY, turnstileToken: "valid-token" })),
		);

		expect(res.status).toBe(403);
		expect(await commentCount()).toBe(0);
	});

	it("ignores the token when no secret is configured (backward compatible)", async () => {
		const fetchSpy = stubSiteverify(true);

		const res = await postComment(
			buildContext(db, buildRequest({ ...VALID_BODY, turnstileToken: "anything" })),
		);

		expect(res.status).toBe(201);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await commentCount()).toBe(1);
	});
});
