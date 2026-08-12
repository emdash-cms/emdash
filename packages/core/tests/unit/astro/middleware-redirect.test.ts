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
import { invalidateRedirectCache } from "../../../src/redirects/cache.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type MiddlewareContext = Parameters<typeof onRequest>[0];

interface BuildContextOpts {
	pathname: string;
	emdashDb?: unknown;
}

function buildContext({ pathname, emdashDb }: BuildContextOpts): {
	context: MiddlewareContext;
	redirect: ReturnType<typeof vi.fn>;
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
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal Astro-shaped object for the middleware under test
	return { context: ctx as unknown as MiddlewareContext, redirect };
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

	it("warms the redirect cache from one query and reuses it across requests", async () => {
		const findAllEnabled = vi.spyOn(RedirectRepository.prototype, "findAllEnabled");

		// First request: cache cold, should issue exactly one query.
		const first = buildContext({ pathname: "/old" });
		const next1 = vi.fn(async () => new Response("not found", { status: 404 }));
		const r1 = await runMiddleware(first.context, next1);
		expect(r1.status).toBe(301);
		expect(findAllEnabled).toHaveBeenCalledTimes(1);

		// Second request (exact match): cache warm, no further queries.
		const second = buildContext({ pathname: "/old" });
		const next2 = vi.fn(async () => new Response("not found", { status: 404 }));
		const r2 = await runMiddleware(second.context, next2);
		expect(r2.status).toBe(301);
		expect(findAllEnabled).toHaveBeenCalledTimes(1);

		// Third request (pattern match): still warm, no further queries.
		const third = buildContext({ pathname: "/legacy/hello" });
		const next3 = vi.fn(async () => new Response("not found", { status: 404 }));
		const r3 = await runMiddleware(third.context, next3);
		expect(r3.status).toBe(301);
		expect(third.redirect).toHaveBeenCalledWith("/posts/hello", 301);
		expect(findAllEnabled).toHaveBeenCalledTimes(1);

		// Fourth request (no match): still warm, but next() runs and a 404 is logged.
		const fourth = buildContext({ pathname: "/nope" });
		const next4 = vi.fn(async () => new Response("not found", { status: 404 }));
		await runMiddleware(fourth.context, next4);
		expect(findAllEnabled).toHaveBeenCalledTimes(1);

		findAllEnabled.mockRestore();
	});

	it("refreshes redirect rules after another Worker isolate changes them", async () => {
		vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
		const findAllEnabled = vi.spyOn(RedirectRepository.prototype, "findAllEnabled");
		try {
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

			vi.advanceTimersByTime(29_999);

			const stillCached = buildContext({ pathname: "/old" });
			await runMiddleware(
				stillCached.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			expect(stillCached.redirect).toHaveBeenCalledWith("/new", 301);
			expect(findAllEnabled).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(1);

			const refreshed = buildContext({ pathname: "/old" });
			await runMiddleware(
				refreshed.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);

			expect(refreshed.redirect).toHaveBeenCalledWith("/newer", 301);
			expect(findAllEnabled).toHaveBeenCalledTimes(2);
		} finally {
			findAllEnabled.mockRestore();
			vi.useRealTimers();
		}
	});

	it("coalesces concurrent cache refreshes into one database query", async () => {
		const originalFindAllEnabled = RedirectRepository.prototype.findAllEnabled;
		let releaseRefresh!: () => void;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let markRefreshStarted!: () => void;
		const refreshStarted = new Promise<void>((resolve) => {
			markRefreshStarted = resolve;
		});
		const findAllEnabled = vi
			.spyOn(RedirectRepository.prototype, "findAllEnabled")
			.mockImplementation(async function () {
				markRefreshStarted();
				await refreshGate;
				return originalFindAllEnabled.call(this);
			});

		try {
			const first = buildContext({ pathname: "/old" });
			const firstResponse = runMiddleware(
				first.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			await refreshStarted;

			const second = buildContext({ pathname: "/old" });
			const secondResponse = runMiddleware(
				second.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);

			releaseRefresh();
			await Promise.all([firstResponse, secondResponse]);

			expect(findAllEnabled).toHaveBeenCalledTimes(1);
			expect(first.redirect).toHaveBeenCalledWith("/new", 301);
			expect(second.redirect).toHaveBeenCalledWith("/new", 301);
		} finally {
			findAllEnabled.mockRestore();
		}
	});

	it("does not restore stale rules when a write invalidates an in-flight refresh", async () => {
		const originalFindAllEnabled = RedirectRepository.prototype.findAllEnabled;
		let releaseRefresh!: () => void;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let markSnapshotLoaded!: () => void;
		const snapshotLoaded = new Promise<void>((resolve) => {
			markSnapshotLoaded = resolve;
		});
		const findAllEnabled = vi
			.spyOn(RedirectRepository.prototype, "findAllEnabled")
			.mockImplementation(async function () {
				const rows = await originalFindAllEnabled.call(this);
				markSnapshotLoaded();
				await refreshGate;
				return rows;
			});

		try {
			const request = buildContext({ pathname: "/old" });
			const response = runMiddleware(
				request.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);
			await snapshotLoaded;

			const repo = new RedirectRepository(db);
			const existing = await repo.findBySource("/old");
			expect(existing).not.toBeNull();
			await repo.update(existing!.id, { destination: "/newer" });
			invalidateRedirectCache();
			releaseRefresh();

			await response;

			expect(request.redirect).toHaveBeenCalledWith("/newer", 301);
			expect(findAllEnabled).toHaveBeenCalledTimes(2);
		} finally {
			findAllEnabled.mockRestore();
		}
	});

	it("bounds refresh retries when writes keep invalidating the cache", async () => {
		const originalFindAllEnabled = RedirectRepository.prototype.findAllEnabled;
		let invalidationsRemaining = 3;
		const findAllEnabled = vi
			.spyOn(RedirectRepository.prototype, "findAllEnabled")
			.mockImplementation(async function () {
				const rows = await originalFindAllEnabled.call(this);
				if (invalidationsRemaining > 0) {
					invalidationsRemaining--;
					invalidateRedirectCache();
				}
				return rows;
			});

		try {
			const first = buildContext({ pathname: "/old" });
			await runMiddleware(
				first.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);

			expect(first.redirect).toHaveBeenCalledWith("/new", 301);
			expect(findAllEnabled).toHaveBeenCalledTimes(3);

			const second = buildContext({ pathname: "/old" });
			await runMiddleware(
				second.context,
				vi.fn(async () => new Response("not found", { status: 404 })),
			);

			expect(second.redirect).toHaveBeenCalledWith("/new", 301);
			expect(findAllEnabled).toHaveBeenCalledTimes(4);
		} finally {
			findAllEnabled.mockRestore();
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
		// Await the fire-and-forget write before reading the table.
		await log404.mock.results[0]!.value;
		const rows = await db.selectFrom("_emdash_404_log").select("path").execute();
		expect(rows.map((r) => r.path)).toEqual(["/no-such-page"]);
		log404.mockRestore();
	});

	it("logs a content miss under its real path across the redirect-to-/404 flow", async () => {
		// The documented template pattern answers a content miss with
		// Astro.redirect("/404"): the first request is a 302, the browser then
		// requests /404, which renders with status 404.
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
