/**
 * Regression tests for issue #808: redirect middleware silently no-oped for
 * unauthenticated public visitors because `locals.emdash.db` is intentionally
 * absent on the public-visitor branch of runtime init. The fix routes the
 * lookup through `getDb()` (ALS-aware, falls back to singleton).
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { getDbMock } = vi.hoisted(() => ({
	getDbMock: vi.fn(),
}));

vi.mock("../../../src/loader.js", () => ({
	getDb: getDbMock,
}));

import { onRequest } from "../../../src/astro/middleware/redirect.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { publishRedirectArtifacts } from "../../../src/redirects/artifacts.js";
import { invalidateRedirectCache } from "../../../src/redirects/cache.js";
import { runWithContext } from "../../../src/request-context.js";
import { getSiteSettings, setSiteSettings } from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type MiddlewareContext = Parameters<typeof onRequest>[0];

interface BuildContextOpts {
	pathname: string;
	emdashDb?: unknown;
	cache?: { enabled?: boolean; options?: { tags: string[] }; set: ReturnType<typeof vi.fn> };
}

function buildContext({ pathname, emdashDb, cache = { set: vi.fn() } }: BuildContextOpts): {
	context: MiddlewareContext;
	redirect: ReturnType<typeof vi.fn>;
	cache: { enabled?: boolean; set: ReturnType<typeof vi.fn> };
} {
	const redirect = vi.fn(
		(location: string, status: number) =>
			new Response(null, { status, headers: { Location: location } }),
	);
	const url = new URL(`https://example.com${pathname}`);
	const locals = emdashDb !== undefined ? { emdash: { db: emdashDb } } : {};
	const ctx = {
		url,
		request: new Request(url.toString()),
		locals,
		redirect,
		cache,
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal Astro-shaped object for the middleware under test
	return { context: ctx as unknown as MiddlewareContext, redirect, cache };
}

describe("redirect middleware — issue #808", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/old", destination: "/new", type: 301 });
		await repo.create({
			source: "/legacy/[slug]",
			destination: "/posts/[slug]",
			type: 301,
			isPattern: true,
		});
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function runMiddleware(
		context: MiddlewareContext,
		next: () => Promise<Response>,
	): Promise<Response> {
		const result = await onRequest(context, next);
		if (!(result instanceof Response)) {
			throw new Error("Middleware returned void; expected a Response");
		}
		return result;
	}

	it("fires for an unauthenticated visitor on a public path (no locals.emdash.db)", async () => {
		const { context, redirect } = buildContext({ pathname: "/old" });

		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(getDbMock).toHaveBeenCalledTimes(1);
		expect(redirect).toHaveBeenCalledWith("/new", 301);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/new");
		expect(next).not.toHaveBeenCalled();
	});

	it("fires pattern matches for unauthenticated visitors", async () => {
		const { context, redirect } = buildContext({ pathname: "/legacy/hello" });

		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/posts/hello", 301);
		expect(response.status).toBe(301);
	});

	it("still uses locals.emdash.db when present (authenticated/edit-mode/preview path)", async () => {
		const { context, redirect } = buildContext({ pathname: "/old", emdashDb: db });

		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		// When locals.emdash.db is provided, getDb() must not be called.
		expect(getDbMock).not.toHaveBeenCalled();
		expect(redirect).toHaveBeenCalledWith("/new", 301);
		expect(response.status).toBe(301);
	});

	it("skips silently when no database is available at all", async () => {
		getDbMock.mockRejectedValueOnce(new Error("EmDash database not configured"));
		const { context, redirect } = buildContext({ pathname: "/old" });

		const next = vi.fn(async () => new Response("ok"));
		const response = await runMiddleware(context, next);

		expect(redirect).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
	});

	it("loads published redirects in one query and reuses them across requests", async () => {
		await publishRedirectArtifacts(db);
		const findAllEnabled = vi.spyOn(RedirectRepository.prototype, "findAllEnabled");
		let selects = 0;
		getDbMock.mockResolvedValue(
			db.withPlugin({
				transformQuery(args) {
					if (args.node.kind === "SelectQueryNode") selects++;
					return args.node;
				},
				async transformResult(args) {
					return args.result;
				},
			}),
		);

		try {
			const first = buildContext({ pathname: "/old" });
			const r1 = await runMiddleware(
				first.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			expect(r1.status).toBe(301);
			expect(selects).toBe(1);

			const second = buildContext({ pathname: "/legacy/hello" });
			const r2 = await runMiddleware(
				second.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			expect(r2.status).toBe(301);
			expect(second.redirect).toHaveBeenCalledWith("/posts/hello", 301);

			const third = buildContext({ pathname: "/nope" });
			await runMiddleware(
				third.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);

			await waitForDeferredTasks();
			expect(selects).toBe(1);
			expect(findAllEnabled).not.toHaveBeenCalled();
		} finally {
			findAllEnabled.mockRestore();
		}
	});

	it("picks up redirects another Worker isolate published once the cache expires", async () => {
		vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z"), toFake: ["Date"] });
		try {
			await publishRedirectArtifacts(db);
			const repo = new RedirectRepository(db);

			const first = buildContext({ pathname: "/old" });
			await runMiddleware(
				first.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			expect(first.redirect).toHaveBeenCalledWith("/new", 301);

			const existing = await repo.findBySource("/old");
			expect(existing).not.toBeNull();
			await repo.update(existing!.id, { destination: "/newer" });
			await publishRedirectArtifacts(db);

			vi.advanceTimersByTime(29_999);
			const stillCached = buildContext({ pathname: "/old" });
			await runMiddleware(
				stillCached.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			expect(stillCached.redirect).toHaveBeenCalledWith("/new", 301);

			vi.advanceTimersByTime(1);
			const expired = buildContext({ pathname: "/old" });
			await runMiddleware(
				expired.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			expect(expired.redirect).toHaveBeenCalledWith("/new", 301);
			await waitForDeferredTasks();

			const refreshed = buildContext({ pathname: "/old" });
			await runMiddleware(
				refreshed.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			expect(refreshed.redirect).toHaveBeenCalledWith("/newer", 301);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not intercept /_emdash routes", async () => {
		const { context, redirect } = buildContext({ pathname: "/_emdash/admin" });

		const next = vi.fn(async () => new Response("ok"));
		await runMiddleware(context, next);

		expect(getDbMock).not.toHaveBeenCalled();
		expect(redirect).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});
});

describe("redirect middleware — 404 logging attributes misses to the requested path", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("logs an unmatched path exactly once", async () => {
		const log404 = vi.spyOn(RedirectRepository.prototype, "log404");
		const { context } = buildContext({ pathname: "/no-such-page" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		await onRequest(context, next);

		expect(log404).toHaveBeenCalledTimes(1);
		expect(log404).toHaveBeenCalledWith(expect.objectContaining({ path: "/no-such-page" }));
		// Await the deferred write before reading the table.
		await log404.mock.results[0]!.value;
		const rows = await db.selectFrom("_emdash_404_log").select("path").execute();
		expect(rows.map((r) => r.path)).toEqual(["/no-such-page"]);
		log404.mockRestore();
	});

	it("logs a content miss under its real path across the redirect-to-/404 flow", async () => {
		// A site that answers a content miss with Astro.redirect("/404") sends a
		// 302 first; the browser then requests /404, which renders with status 404.
		const log404 = vi.spyOn(RedirectRepository.prototype, "log404");

		const miss = buildContext({ pathname: "/posts/deleted-post" });
		const redirectNext = vi.fn(
			async () => new Response(null, { status: 302, headers: { Location: "/404" } }),
		);
		await onRequest(miss.context, redirectNext);

		const errorPage = buildContext({ pathname: "/404" });
		const errorNext = vi.fn(async () => new Response("not found", { status: 404 }));
		await onRequest(errorPage.context, errorNext);

		expect(log404).toHaveBeenCalledTimes(1);
		expect(log404).toHaveBeenCalledWith(expect.objectContaining({ path: "/posts/deleted-post" }));
		await log404.mock.results[0]!.value;
		const rows = await db.selectFrom("_emdash_404_log").select("path").execute();
		expect(rows.map((r) => r.path)).toEqual(["/posts/deleted-post"]);
		log404.mockRestore();
	});

	it("does not enable caching for a 404 on a route without cache options", async () => {
		const miss = buildContext({
			pathname: "/posts/deleted-post",
			cache: { enabled: true, options: { tags: [] }, set: vi.fn() },
		});
		await onRequest(miss.context, async () => new Response("not found", { status: 404 }));
		expect(miss.cache.set).not.toHaveBeenCalled();

		const hit = buildContext({
			pathname: "/posts/live-post",
			cache: { enabled: true, options: { tags: [] }, set: vi.fn() },
		});
		await onRequest(hit.context, async () => new Response("ok", { status: 200 }));
		expect(hit.cache.set).not.toHaveBeenCalled();
	});

	it("does not set an explicitly disabled cache for a 404", async () => {
		const cache = { enabled: false, set: vi.fn() };
		const miss = buildContext({ pathname: "/posts/deleted-post", cache });

		await onRequest(miss.context, async () => new Response("not found", { status: 404 }));

		expect(cache.set).not.toHaveBeenCalled();
	});

	it("logs a missing path rendered by a prerendered 404 without reading headers", async () => {
		const { context } = buildContext({ pathname: "/missing" });
		Object.defineProperty(context, "isPrerendered", { value: true });
		const headersGet = vi.spyOn(context.request.headers, "get");

		const response = await onRequest(
			context,
			async () => new Response("not found", { status: 404 }),
		);
		await waitForDeferredTasks();

		expect(response.status).toBe(404);
		expect(headersGet).not.toHaveBeenCalled();
		const rows = await db.selectFrom("_emdash_404_log").selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ path: "/missing", referrer: null, user_agent: null });
	});

	it("does not log ordinary redirects", async () => {
		const log404 = vi.spyOn(RedirectRepository.prototype, "log404");
		const { context } = buildContext({ pathname: "/moved" });
		const next = vi.fn(
			async () => new Response(null, { status: 302, headers: { Location: "/new-home" } }),
		);
		await onRequest(context, next);

		expect(log404).not.toHaveBeenCalled();
		log404.mockRestore();
	});

	it("does not log the site's own /404 error page render", async () => {
		const log404 = vi.spyOn(RedirectRepository.prototype, "log404");
		for (const pathname of ["/404", "/404/"]) {
			const { context } = buildContext({ pathname });
			const next = vi.fn(async () => new Response("not found", { status: 404 }));
			await onRequest(context, next);
		}

		expect(log404).not.toHaveBeenCalled();
		const rows = await db.selectFrom("_emdash_404_log").select("path").execute();
		expect(rows).toEqual([]);
		log404.mockRestore();
	});
});

describe("redirect middleware — trailing-slash normalisation (issue #1271)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function runMiddleware(
		context: MiddlewareContext,
		next: () => Promise<Response>,
	): Promise<Response> {
		const result = await onRequest(context, next);
		if (!(result instanceof Response)) {
			throw new Error("Middleware returned void; expected a Response");
		}
		return result;
	}

	it("matches an unslashed request when the redirect source has a trailing slash", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/test-3/", destination: "/", type: 301 });

		const { context, redirect } = buildContext({ pathname: "/test-3" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/", 301);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/");
		expect(next).not.toHaveBeenCalled();
	});

	it("matches a slashed request when the redirect source has no trailing slash", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/test-3", destination: "/", type: 301 });

		const { context, redirect } = buildContext({ pathname: "/test-3/" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/", 301);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/");
		expect(next).not.toHaveBeenCalled();
	});

	it("prefers an exact match over the alternate slash form", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/old", destination: "/new", type: 301 });
		await repo.create({ source: "/old/", destination: "/newer", type: 301 });

		const { context: ctx1, redirect: redirect1 } = buildContext({ pathname: "/old" });
		const next1 = vi.fn(async () => new Response("not found", { status: 404 }));
		const r1 = await runMiddleware(ctx1, next1);
		expect(redirect1).toHaveBeenCalledWith("/new", 301);
		expect(r1.headers.get("Location")).toBe("/new");

		const { context: ctx2, redirect: redirect2 } = buildContext({ pathname: "/old/" });
		const next2 = vi.fn(async () => new Response("not found", { status: 404 }));
		const r2 = await runMiddleware(ctx2, next2);
		expect(redirect2).toHaveBeenCalledWith("/newer", 301);
		expect(r2.headers.get("Location")).toBe("/newer");
	});
});

describe("redirect middleware — only redirects to site-relative paths", () => {
	let db: Kysely<Database>;
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(async () => {
		warn.mockRestore();
		await teardownTestDatabase(db);
	});

	async function runMiddleware(
		context: MiddlewareContext,
		next: () => Promise<Response>,
	): Promise<Response> {
		const result = await onRequest(context, next);
		if (!(result instanceof Response)) {
			throw new Error("Middleware returned void; expected a Response");
		}
		return result;
	}

	it.each([
		"https://evil.example",
		"http:/evil.example",
		"javascript:alert(1)",
		"evil.example/path",
		"//evil.example",
		"/\\evil.example",
		"/\t/evil.example",
		"/\n/evil.example",
		"/ok\r\nSet-Cookie: a=b",
		"/\u007f/evil.example",
	])("skips a stored exact rule whose destination is %j", async (destination) => {
		const repo = new RedirectRepository(db);
		const rule = await repo.create({ source: "/away", destination, type: 301 });

		const { context, redirect } = buildContext({ pathname: "/away" });
		const next = vi.fn(async () => new Response("ok"));
		const response = await runMiddleware(context, next);

		expect(redirect).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
		expect((await repo.findById(rule.id))?.hits).toBe(0);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(rule.id));
	});

	it("skips a stored pattern rule that resolves to an external URL", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/out/[slug]",
			destination: "https://evil.example/[slug]",
			type: 302,
			isPattern: true,
		});

		const { context, redirect } = buildContext({ pathname: "/out/page" });
		const next = vi.fn(async () => new Response("ok"));
		const response = await runMiddleware(context, next);

		expect(redirect).not.toHaveBeenCalled();
		expect(response.status).toBe(200);
	});

	it("skips a pattern rule whose captured path makes the destination protocol-relative", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/go/[...rest]",
			destination: "/[...rest]",
			type: 301,
			isPattern: true,
		});

		const { context, redirect } = buildContext({ pathname: "/go//evil.example" });
		const next = vi.fn(async () => new Response("ok"));
		await runMiddleware(context, next);

		expect(redirect).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("still redirects to site-relative paths with a query string and fragment", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/find", destination: "/search?q=a%20b#results", type: 302 });

		const { context, redirect } = buildContext({ pathname: "/find" });
		const next = vi.fn(async () => new Response("ok"));
		const response = await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/search?q=a%20b#results", 302);
		expect(response.status).toBe(302);
	});

	it("ignores a stored pattern rule whose source is not a valid pattern", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/[a][b][c]",
			destination: "/elsewhere",
			type: 301,
			isPattern: true,
		});

		const { context, redirect } = buildContext({ pathname: "/abc" });
		const next = vi.fn(async () => new Response("ok"));
		const response = await runMiddleware(context, next);

		expect(redirect).not.toHaveBeenCalled();
		expect(response.status).toBe(200);
	});
});

/**
 * Astro's per-request route cache: a response is stored when a max age or a
 * tag is set by the time the middleware chain returns it.
 */
describe("redirect middleware — does not rerun route when next() throws (issue #4158)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("calls next() exactly once and rethrows when the route throws", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/old", destination: "/new", type: 301 });
		await publishRedirectArtifacts(db);

		const { context } = buildContext({ pathname: "/unmatched" });
		const thrown = new Error("the real failure");
		const next = vi.fn(async () => {
			throw thrown;
		});

		await expect(onRequest(context, next)).rejects.toBe(thrown);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("still swallows redirect-table errors and skips redirects", async () => {
		getDbMock.mockResolvedValue(db);
		const spy = vi.spyOn(RedirectRepository.prototype, "findAllEnabled");
		spy.mockRejectedValueOnce(new Error("redirects table missing"));

		const { context } = buildContext({ pathname: "/page" });
		const next = vi.fn(async () => new Response("ok"));
		const response = await onRequest(context, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
		spy.mockRestore();
	});

	it("does not disable an explicitly disabled cache when redirect lookup fails", async () => {
		const spy = vi.spyOn(RedirectRepository.prototype, "findAllEnabled");
		spy.mockRejectedValueOnce(new Error("redirects table missing"));
		const cache = { enabled: false, set: vi.fn() };
		const { context } = buildContext({ pathname: "/page", cache });

		await onRequest(context, async () => new Response("ok"));

		expect(cache.set).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

function storingRouteCache(initial: { maxAge?: number; swr?: number; tags?: string[] } = {}) {
	let options: { maxAge?: number; swr?: number; tags: string[] } = { tags: [], ...initial };
	return {
		enabled: true,
		get options() {
			return options;
		},
		set: vi.fn((input: false | { maxAge?: number; swr?: number; tags?: string[] }) => {
			options =
				input === false
					? { tags: [] }
					: { ...options, ...input, tags: [...options.tags, ...(input.tags ?? [])] };
		}),
	};
}

describe("redirect middleware — responses the route cache stores", () => {
	let db: Kysely<Database>;
	let repo: RedirectRepository;
	let selects: number;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		repo = new RedirectRepository(db);
		await publishRedirectArtifacts(db);
		selects = 0;
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(
			db.withPlugin({
				transformQuery(args) {
					if (args.node.kind === "SelectQueryNode") selects++;
					return args.node;
				},
				async transformResult(args) {
					return args.result;
				},
			}),
		);
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		await teardownTestDatabase(db);
	});

	async function runMiddleware(
		context: MiddlewareContext,
		next: () => Promise<Response>,
	): Promise<Response> {
		const result = await onRequest(context, next);
		if (!(result instanceof Response)) {
			throw new Error("Middleware returned void; expected a Response");
		}
		return result;
	}

	/** Loads the published rules into this isolate's cache. */
	async function warm(): Promise<void> {
		const { context } = buildContext({ pathname: "/warm" });
		await runMiddleware(context, async () => new Response("warm"));
		await waitForDeferredTasks();
		selects = 0;
	}

	/** A page render that asks the route cache to store it, as `Astro.cache.set(cacheHint)` does. */
	function storedPage(cache: ReturnType<typeof storingRouteCache>) {
		return async () => {
			cache.set({ tags: ["posts", "post-1"] });
			return new Response("page");
		};
	}

	it.each([
		{ maxAge: 86_400, swr: 604_800, expectedMaxAge: 60 },
		{ maxAge: 15, swr: 300, expectedMaxAge: 15 },
		{ maxAge: 0, swr: 300, expectedMaxAge: 0 },
		{ expectedMaxAge: 60 },
	])("bounds a cached content miss with options %j", async ({ expectedMaxAge, ...initial }) => {
		await warm();
		const cache = storingRouteCache({ ...initial, tags: ["posts"] });
		const { context } = buildContext({ pathname: "/posts/missing", cache });
		const response = await runMiddleware(
			context,
			async () => new Response("not found", { status: 404 }),
		);

		expect(response.status).toBe(404);
		expect(cache.options).toEqual({ maxAge: expectedMaxAge, swr: 0, tags: ["posts"] });
		expect(selects).toBe(1);
	});

	it("caches a 404 whose page or layout supplies only chrome tags without a route rule", async () => {
		await warm();
		const cache = storingRouteCache();
		const { context } = buildContext({ pathname: "/posts/missing", cache });
		const response = await runMiddleware(context, async () => {
			cache.set({ tags: ["emdash:settings", "emdash:menu:primary"] });
			return new Response("not found", { status: 404 });
		});

		expect(response.status).toBe(404);
		expect(cache.options).toEqual({
			maxAge: 60,
			swr: 0,
			tags: ["emdash:settings", "emdash:menu:primary"],
		});
		expect(selects).toBe(1);
	});

	it("bounds a rewritten 404 across nested middleware passes on one cache handle", async () => {
		await warm();
		const cache = storingRouteCache({ maxAge: 86_400, swr: 604_800, tags: ["posts"] });
		const outer = buildContext({ pathname: "/posts/missing", cache });
		const inner = buildContext({ pathname: "/404", cache });
		const response = await runMiddleware(outer.context, () =>
			runMiddleware(inner.context, async () => new Response("not found", { status: 404 })),
		);

		expect(response.status).toBe(404);
		expect(cache.options).toEqual({ maxAge: 60, swr: 0, tags: ["posts"] });
		expect(selects).toBe(2);
	});

	it("preserves a content miss's explicit cache opt-out", async () => {
		await warm();
		const cache = storingRouteCache({ maxAge: 300, tags: ["posts"] });
		const { context } = buildContext({ pathname: "/posts/missing", cache });
		await runMiddleware(context, async () => {
			cache.set(false);
			return new Response("not found", { status: 404 });
		});

		expect(cache.options).toEqual({ tags: [] });
		expect(selects).toBe(0);
	});

	it("replaces a cacheable 404 when a redirect was added in another isolate", async () => {
		await warm();
		await repo.create({ source: "/posts/missing", destination: "/moved", type: 301 });
		await publishRedirectArtifacts(db);
		const cache = storingRouteCache({ maxAge: 300, tags: ["posts"] });
		const { context } = buildContext({ pathname: "/posts/missing", cache });
		const response = await runMiddleware(
			context,
			async () => new Response("not found", { status: 404 }),
		);

		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/moved");
		expect(cache.options).toEqual({ tags: [] });
	});

	it("does not cache a 404 when settings freshness cannot be verified", async () => {
		await warm();
		const cache = storingRouteCache({ maxAge: 300, tags: ["posts"] });
		const { context } = buildContext({ pathname: "/posts/missing", cache });
		getDbMock.mockResolvedValue(
			db.withPlugin({
				transformQuery() {
					throw new Error("database unavailable");
				},
				async transformResult(args) {
					return args.result;
				},
			}),
		);
		await runMiddleware(context, async () => new Response("not found", { status: 404 }));

		expect(cache.options).toEqual({ tags: [] });
	});

	it("redirects a stored render when another isolate has added a redirect for its path", async () => {
		await warm();
		await repo.create({ source: "/page", destination: "/moved", type: 301 });
		await publishRedirectArtifacts(db);

		const cache = storingRouteCache();
		const { context } = buildContext({ pathname: "/page", cache });
		const response = await runMiddleware(context, storedPage(cache));

		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/moved");
	});

	it("lets a render it replaces with a redirect run to completion", async () => {
		await warm();
		await repo.create({ source: "/page", destination: "/moved", type: 301 });
		await publishRedirectArtifacts(db);

		let rendered = false;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode("page"));
				rendered = true;
				controller.close();
			},
			cancel() {
				cancelled = true;
			},
		});
		const cache = storingRouteCache();
		const { context } = buildContext({ pathname: "/page", cache });
		const response = await runMiddleware(context, async () => {
			cache.set({ tags: ["posts"] });
			return new Response(body);
		});
		await waitForDeferredTasks();

		expect(response.status).toBe(301);
		expect(cancelled).toBe(false);
		expect(rendered).toBe(true);
	});

	it("redirects a stored render for a redirect written before its rules were published", async () => {
		await warm();
		await repo.create({ source: "/page", destination: "/moved", type: 301 });

		const cache = storingRouteCache();
		const { context } = buildContext({ pathname: "/page", cache });
		const response = await runMiddleware(context, storedPage(cache));

		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/moved");
	});

	it("renders the page rather than store a redirect another isolate has deleted", async () => {
		const rule = await repo.create({ source: "/page", destination: "/moved", type: 301 });
		await publishRedirectArtifacts(db);
		await warm();
		await repo.delete(rule.id);
		await publishRedirectArtifacts(db);

		const cache = storingRouteCache({ maxAge: 300 });
		const { context } = buildContext({ pathname: "/page", cache });
		const response = await runMiddleware(context, storedPage(cache));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("page");
	});

	it("checks current rules with one read before a render is stored", async () => {
		await warm();

		const cache = storingRouteCache();
		const { context } = buildContext({ pathname: "/page", cache });
		const response = await runMiddleware(context, storedPage(cache));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("page");
		expect(selects).toBe(1);
	});

	it.each(["/page", "/rss.xml"])(
		"restores the outer settings tracker after rendering %s",
		async (pathname) => {
			const cache = storingRouteCache();
			const outerReads: string[] = [];

			await runWithContext(
				{
					editMode: false,
					routeCacheFill: true,
					siteSettings: { onRead: (version) => outerReads.push(version) },
				},
				async () => {
					const { context } = buildContext({ pathname, cache });
					await runMiddleware(context, async () => {
						await setSiteSettings({ title: "updated" }, db);
						await getSiteSettings();
						return new Response("page");
					});

					await getSiteSettings();
				},
			);

			expect(outerReads).toHaveLength(1);
			expect(cache.set).toHaveBeenCalledWith(false);
		},
	);

	it("does not read the database for a render the route cache will not store", async () => {
		await warm();
		await repo.create({ source: "/page", destination: "/moved", type: 301 });
		await publishRedirectArtifacts(db);

		const cache = storingRouteCache();
		const { context } = buildContext({ pathname: "/page", cache });
		const response = await runMiddleware(context, async () => new Response("page"));

		expect(response.status).toBe(200);
		expect(selects).toBe(0);
	});
});

describe("redirect middleware: non-ASCII source paths", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function runMiddleware(
		context: MiddlewareContext,
		next: () => Promise<Response>,
	): Promise<Response> {
		const result = await onRequest(context, next);
		if (!(result instanceof Response)) {
			throw new Error("Middleware returned void; expected a Response");
		}
		return result;
	}

	it("fires for a redirect whose stored source is raw Unicode", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/stitek/domácí-zvířata",
			destination: "/stitek/domaci-zvirata",
			type: 301,
		});
		await publishRedirectArtifacts(db);

		// The browser sends the path percent-encoded, so `context.url.pathname`
		// arrives encoded while the stored source is raw Unicode.
		const { context, redirect } = buildContext({ pathname: "/stitek/domácí-zvířata" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/stitek/domaci-zvirata", 301);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/stitek/domaci-zvirata");
		expect(next).not.toHaveBeenCalled();
	});

	it("still fires when the stored source is already percent-encoded", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/stitek/dom%C3%A1c%C3%AD-zv%C3%AD%C5%99ata",
			destination: "/stitek/domaci-zvirata",
			type: 301,
		});
		await publishRedirectArtifacts(db);

		const { context, redirect } = buildContext({ pathname: "/stitek/domácí-zvířata" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/stitek/domaci-zvirata", 301);
	});

	it("fires when the stored source uses lowercase percent-escapes", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/stitek/dom%c3%a1c%c3%ad",
			destination: "/stitek/domaci",
			type: 301,
		});
		await publishRedirectArtifacts(db);

		const { context, redirect } = buildContext({ pathname: "/stitek/domácí" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/stitek/domaci", 301);
	});

	it("matches a source with percent-encoded brackets as that literal path only", async () => {
		const repo = new RedirectRepository(db);
		const rule = await repo.create({
			source: "/posts/%5Bslug%5D",
			destination: "/posts",
			type: 301,
		});
		expect(rule.isPattern).toBe(false);
		await publishRedirectArtifacts(db);

		const literal = buildContext({ pathname: "/posts/[slug]" });
		const literalNext = vi.fn(async () => new Response("not found", { status: 404 }));
		await runMiddleware(literal.context, literalNext);
		expect(literal.redirect).toHaveBeenCalledWith("/posts", 301);
		expect(literalNext).not.toHaveBeenCalled();

		const other = buildContext({ pathname: "/posts/hello" });
		const otherNext = vi.fn(async () => new Response("ok", { status: 200 }));
		const response = await runMiddleware(other.context, otherNext);
		expect(other.redirect).not.toHaveBeenCalled();
		expect(response.status).toBe(200);
	});

	it("percent-encodes a non-ASCII destination for the Location header", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/stitek/zvířata", destination: "/štítek/zvířata", type: 301 });
		await publishRedirectArtifacts(db);

		const { context } = buildContext({ pathname: "/stitek/zvířata" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/%C5%A1t%C3%ADtek/zv%C3%AD%C5%99ata");
	});

	it("percent-encodes a non-ASCII pattern destination", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/clanky/[...slug]",
			destination: "/články/[...slug]",
			type: 301,
			isPattern: true,
		});
		await publishRedirectArtifacts(db);

		const { context } = buildContext({ pathname: "/clanky/hello" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(response.headers.get("Location")).toBe("/%C4%8Dl%C3%A1nky/hello");
	});

	it("matches a pattern whose literal segment contains non-ASCII characters", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/články/[...slug]",
			destination: "/articles/[...slug]",
			type: 301,
			isPattern: true,
		});
		await publishRedirectArtifacts(db);

		const { context, redirect } = buildContext({ pathname: "/články/hello" });
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/articles/hello", 301);
	});
	it("does not let a source with a query string redirect its bare path", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/?p=123", destination: "/hello-world", type: 301 });
		await publishRedirectArtifacts(db);

		const { context, redirect } = buildContext({ pathname: "/" });
		const next = vi.fn(async () => new Response("home", { status: 200 }));
		const response = await runMiddleware(context, next);

		expect(redirect).not.toHaveBeenCalled();
		expect(response.status).toBe(200);
	});
});

describe("redirect middleware — file-extension exact rules", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		await teardownTestDatabase(db);
	});

	async function run(
		pathname: string,
		next: () => Promise<Response>,
		cache?: ReturnType<typeof storingRouteCache>,
	) {
		const { context, redirect } = buildContext({ pathname, ...(cache ? { cache } : {}) });
		const response = await onRequest(context, next);
		return { response, redirect };
	}

	it("redirects exact file sources, including either trailing-slash form, with direct precedence", async () => {
		const repo = new RedirectRepository(db);
		const rule = await repo.create({ source: "/old/report.pdf", destination: "/", type: 301 });
		await publishRedirectArtifacts(db);

		const first = await run(
			"/old/report.pdf",
			async () => new Response("missing", { status: 404 }),
		);
		const alternate = await run(
			"/old/report.pdf/",
			async () => new Response("missing", { status: 404 }),
		);
		expect(first.response.status).toBe(301);
		expect(first.response.headers.get("Location")).toBe("/");
		expect(alternate.response.status).toBe(301);
		expect(alternate.response.headers.get("Location")).toBe("/");

		await repo.create({ source: "/old/report.pdf/", destination: "/slash", type: 301 });
		await publishRedirectArtifacts(db);
		invalidateRedirectCache();
		const direct = await run(
			"/old/report.pdf",
			async () => new Response("missing", { status: 404 }),
		);
		const slashed = await run(
			"/old/report.pdf/",
			async () => new Response("missing", { status: 404 }),
		);
		expect(direct.redirect).toHaveBeenCalledWith("/", 301);
		expect(slashed.redirect).toHaveBeenCalledWith("/slash", 301);
		await waitForDeferredTasks();
		expect((await repo.findById(rule.id))?.hits).toBe(3);
	});

	it("matches a file source stored with a trailing slash for an unslashed request", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/old/report.pdf/", destination: "/", type: 302 });
		const next = vi.fn(async () => new Response("missing", { status: 404 }));
		const { response } = await run("/old/report.pdf", next);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/");
		expect(next).not.toHaveBeenCalled();
	});

	it("does not apply patterns to file paths, log misses, or change cache policy", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/old/[...rest]",
			destination: "/new/[...rest]",
			type: 301,
			isPattern: true,
		});
		await publishRedirectArtifacts(db);
		const log404 = vi.spyOn(RedirectRepository.prototype, "log404");

		for (const pathname of ["/old/missing.pdf", "/old/missing.xml"]) {
			const cache = storingRouteCache({ maxAge: 60 });
			const expected = new Response("unchanged", { status: 404 });
			const { response } = await run(pathname, async () => expected, cache);
			expect(response).toBe(expected);
			expect(cache.set).not.toHaveBeenCalled();
		}
		expect(log404).not.toHaveBeenCalled();
		log404.mockRestore();
	});

	it("keeps pattern redirects and 404 handling for dotted page paths ending in a slash", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({
			source: "/old/[...rest]",
			destination: "/new/[...rest]",
			type: 301,
			isPattern: true,
		});
		const { response } = await run(
			"/old/node.js/",
			async () => new Response("missing", { status: 404 }),
		);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/new/node.js/");

		const cache = storingRouteCache({ maxAge: 60 });
		const miss = await run(
			"/missing/v1.5/",
			async () => new Response("missing", { status: 404 }),
			cache,
		);
		expect(miss.response.status).toBe(404);
		expect(cache.set).toHaveBeenCalledWith({ maxAge: 60, swr: 0 });
		expect(cache.set).not.toHaveBeenCalledWith(false);
		await waitForDeferredTasks();
		const rows = await db.selectFrom("_emdash_404_log").select("path").execute();
		expect(rows.map((row) => row.path)).toEqual(["/missing/v1.5/"]);
	});

	it("keeps internal file paths skipped even when exact rules exist", async () => {
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/_emdash/file.pdf", destination: "/", type: 301 });
		await repo.create({ source: "/_image/file.pdf", destination: "/", type: 301 });
		await publishRedirectArtifacts(db);

		for (const pathname of ["/_emdash/file.pdf", "/_image/file.pdf"]) {
			const next = vi.fn(async () => new Response("ok"));
			const { response, redirect } = await run(pathname, next);
			expect(response.status).toBe(200);
			expect(next).toHaveBeenCalledTimes(1);
			expect(redirect).not.toHaveBeenCalled();
		}
		expect(getDbMock).not.toHaveBeenCalled();
	});

	it.each([410, 451] as const)(
		"serves terminal %i for an exact file source without Location",
		async (type) => {
			const repo = new RedirectRepository(db);
			const rule = await repo.create({ source: `/old/file-${type}.pdf`, destination: "/", type });
			await publishRedirectArtifacts(db);
			const { response } = await run(
				`/old/file-${type}.pdf`,
				async () => new Response("missing", { status: 404 }),
			);
			expect(response.status).toBe(type);
			expect(response.headers.has("Location")).toBe(false);
			await waitForDeferredTasks();
			expect((await repo.findById(rule.id))?.hits).toBe(1);
		},
	);

	it("skips an unsafe exact file destination without a hit or 404 log", async () => {
		const repo = new RedirectRepository(db);
		const rule = await repo.create({
			source: "/old/unsafe.pdf",
			destination: "https://evil.example",
			type: 301,
		});
		await publishRedirectArtifacts(db);
		const log404 = vi.spyOn(RedirectRepository.prototype, "log404");
		const next = vi.fn(async () => new Response("missing", { status: 404 }));
		const { response, redirect } = await run("/old/unsafe.pdf", next);
		expect(response.status).toBe(404);
		expect(next).toHaveBeenCalledTimes(1);
		expect(redirect).not.toHaveBeenCalled();
		await waitForDeferredTasks();
		expect((await repo.findById(rule.id))?.hits).toBe(0);
		expect(log404).not.toHaveBeenCalled();
		log404.mockRestore();
	});

	it("delegates once when the database is unavailable", async () => {
		getDbMock.mockRejectedValueOnce(new Error("database unavailable"));
		const next = vi.fn(async () => new Response("ok"));
		const { response } = await run("/old/file.pdf", next);
		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledTimes(1);
		expect(getDbMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ isPattern: false, storesResponse: true, expectedStatus: 301 },
		{ isPattern: true, storesResponse: true, expectedStatus: 200 },
		{ isPattern: false, storesResponse: false, expectedStatus: 200 },
	])(
		"checks new file rules before storing a response: %j",
		async ({ isPattern, storesResponse, expectedStatus }) => {
			await publishRedirectArtifacts(db);
			await run("/feed.xml", async () => new Response("warm"));
			await waitForDeferredTasks();

			const repo = new RedirectRepository(db);
			await repo.create({
				source: isPattern ? "/[...path]" : "/feed.xml",
				destination: "/rss.xml",
				type: 301,
				isPattern,
			});
			await publishRedirectArtifacts(db);

			const cache = storingRouteCache();
			const downstream = new Response("feed");
			const next = vi.fn(async () => {
				if (storesResponse) cache.set({ maxAge: 60 });
				return downstream;
			});
			const { response } = await run("/feed.xml", next, cache);
			expect(next).toHaveBeenCalledTimes(1);
			expect(response.status).toBe(expectedStatus);
			if (expectedStatus === 301) {
				expect(response.headers.get("Location")).toBe("/rss.xml");
				expect(cache.set).toHaveBeenCalledWith(false);
			} else {
				expect(response).toBe(downstream);
				expect(cache.set).not.toHaveBeenCalledWith(false);
			}
		},
	);

	it("verifies a warmed exact file rule before serving a cached response", async () => {
		const repo = new RedirectRepository(db);
		const rule = await repo.create({ source: "/old/stale.pdf", destination: "/before", type: 301 });
		await publishRedirectArtifacts(db);
		const warmCache = storingRouteCache({ maxAge: 60 });
		await run("/old/stale.pdf", async () => new Response("missing", { status: 404 }), warmCache);

		await repo.update(rule.id, { destination: "/after" });
		await publishRedirectArtifacts(db);
		const updated = await run(
			"/old/stale.pdf",
			async () => new Response("missing", { status: 404 }),
			storingRouteCache({ maxAge: 60 }),
		);
		expect(updated.redirect).toHaveBeenCalledWith("/after", 301);

		await repo.delete(rule.id);
		await publishRedirectArtifacts(db);
		const cache = storingRouteCache({ maxAge: 60 });
		const downstream = new Response("downstream", { status: 200 });
		const deleted = await run("/old/stale.pdf", async () => downstream, cache);
		expect(deleted.response).toBe(downstream);
		expect(cache.set).not.toHaveBeenCalled();
	});
});
