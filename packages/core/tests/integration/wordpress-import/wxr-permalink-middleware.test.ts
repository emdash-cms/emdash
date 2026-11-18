import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";

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
import { importWxrPermalinks } from "../../../src/import/wxr-permalinks.js";
import { invalidateRedirectCache } from "../../../src/redirects/cache.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const pattern = "/{slug}";

type MiddlewareContext = Parameters<typeof onRequest>[0];

function buildContext(pathname: string, db?: DialectTestContext["db"]): MiddlewareContext {
	const url = new URL(`https://example.com${pathname}`);
	return {
		url,
		request: new Request(url),
		locals: { emdash: { db } },
		redirect: vi.fn(
			(location: string, status: number) =>
				new Response(null, { status, headers: { Location: location } }),
		),
		cache: { set: vi.fn() },
	} as unknown as MiddlewareContext;
}

describeEachDialect("WordPress extension-bearing permalink middleware boundary", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(ctx.db);
		invalidateRedirectCache();
	});

	afterEach(async () => {
		invalidateRedirectCache();
		await waitForDeferredTasks();
		await teardownForDialect(ctx);
	});

	it("reports an extension-bearing WXR permalink instead of saving an ineffective redirect", async () => {
		const result = await importWxrPermalinks(ctx.db, [
			{
				title: "Example",
				link: "https://wp.test/example.html",
				collection: "posts",
				pattern,
				item: {
					id: "example",
					slug: "example",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(result).toHaveLength(1);
		expect(result[0]?.title).toBe("Example");
		expect(result[0]?.error).toContain("supported paths");
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);

		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await onRequest(buildContext("/example.html", ctx.db), next);

		expect(response.status).toBe(404);
		expect(response.headers.has("Location")).toBe(false);
		expect(next).toHaveBeenCalledOnce();
	});

	it("matches lowercase WordPress UTF-8 escapes with one cold read and no extra warm reads", async () => {
		const result = await importWxrPermalinks(ctx.db, [
			{
				title: "Пр",
				link: "https://wp.test/%d0%bf%d1%80/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "pr",
					slug: "пр",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);
		expect(result).toEqual([]);
		const rule = await ctx.db
			.selectFrom("_emdash_redirects")
			.select(["source", "destination"])
			.executeTakeFirstOrThrow();
		expect(rule).toEqual({ source: "/%D0%BF%D1%80", destination: "/posts/%D0%BF%D1%80" });

		let selects = 0;
		const countedDb = ctx.db.withPlugin({
			transformQuery(args) {
				if (args.node.kind === "SelectQueryNode") selects++;
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		getDbMock.mockResolvedValue(countedDb);
		const paths = [
			"/%d0%bf%d1%80",
			"/%d0%bf%d1%80/",
			"/%D0%BF%D1%80",
			"/%D0%BF%D1%80/",
			"/%d0%BF%d1%80",
			"/%d0%BF%d1%80/",
			"/пр",
			"/пр/",
		];
		for (const path of paths) {
			const next = vi.fn(async () => new Response("not found", { status: 404 }));
			const response = await onRequest(buildContext(path), next);
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe("/posts/%D0%BF%D1%80");
			expect(next).not.toHaveBeenCalled();
		}
		expect(selects).toBe(1);
	});

	it("keeps percent layers distinct in middleware redirects and its cache", async () => {
		const repository = new RedirectRepository(ctx.db);
		await repository.create({ source: "/café", destination: "/normal", type: 301 });
		await repository.create({ source: "/a%2F", destination: "/slash", type: 301 });
		invalidateRedirectCache();

		for (const [path, destination] of [
			["/café", "/normal"],
			["/caf%C3%A9", "/normal"],
			["/a%2F", "/slash"],
		] as const) {
			const response = await onRequest(buildContext(path), vi.fn());
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(destination);
		}

		for (const path of ["/caf%25C3%25A9", "/a%252F"]) {
			const next = vi.fn(async () => new Response("not found", { status: 404 }));
			const response = await onRequest(buildContext(path), next);
			expect(response.status).toBe(404);
			expect(next).toHaveBeenCalledOnce();
		}

		await repository.create({ source: "/caf%25C3%25A9", destination: "/double-cafe", type: 301 });
		await repository.create({ source: "/a%252F", destination: "/double-slash", type: 301 });
		invalidateRedirectCache();
		for (const [path, destination] of [
			["/caf%C3%A9", "/normal"],
			["/caf%25C3%25A9", "/double-cafe"],
			["/a%2F", "/slash"],
			["/a%252F", "/double-slash"],
		] as const) {
			const response = await onRequest(buildContext(path), vi.fn());
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(destination);
		}
	});

	it("preserves percent layers in pattern literals and leaves captures raw", async () => {
		const repository = new RedirectRepository(ctx.db);
		await repository.create({
			source: "/pct%25/[...rest]",
			destination: "/new/[...rest]",
			isPattern: true,
		});
		await repository.create({
			source: "/bare%/[...rest]",
			destination: "/raw/[...rest]",
			isPattern: true,
		});
		invalidateRedirectCache();
		for (const [path, location] of [
			["/pct%25/a%252F", "/new/a%252F"],
			["/bare%/a%252F", "/raw/a%252F"],
		]) {
			const response = await onRequest(buildContext(path), vi.fn());
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(location);
		}
		const response = await onRequest(
			buildContext("/pct%2525/a"),
			async () => new Response("missing", { status: 404 }),
		);
		expect(response.status).toBe(404);
	});

	it("preserves a double-encoded imported source without matching its Unicode alias", async () => {
		const result = await importWxrPermalinks(ctx.db, [
			{
				title: "Double encoded",
				link: "https://wp.test/x%25D0%25BF/",
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "double-encoded",
					slug: "target",
					status: "published",
					publishedAt: "2004-05-02T00:00:00.000Z",
					locale: "en",
				},
			},
		]);
		expect(result).toEqual([]);
		expect(
			await ctx.db.selectFrom("_emdash_redirects").select(["source", "destination"]).execute(),
		).toEqual([{ source: "/x%25D0%25BF", destination: "/posts/target" }]);

		for (const path of ["/x%25D0%25BF", "/x%25D0%25BF/"]) {
			const response = await onRequest(buildContext(path), vi.fn());
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe("/posts/target");
		}
		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await onRequest(buildContext("/x%D0%BF"), next);
		expect(response.status).toBe(404);
		expect(next).toHaveBeenCalledOnce();
	});

	it("does not report a redirect failure when the extension-bearing URL is already canonical", async () => {
		expect(
			await importWxrPermalinks(ctx.db, [
				{
					title: "Example",
					link: "https://wp.test/example.html",
					collection: "posts",
					pattern: "/{slug}.html",
					item: {
						id: "example",
						slug: "example",
						status: "published",
						publishedAt: "2004-05-02T00:00:00.000Z",
						locale: "en",
					},
				},
			]),
		).toEqual([]);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toEqual([]);
	});
});
