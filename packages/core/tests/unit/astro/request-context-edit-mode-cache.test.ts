/**
 * In edit mode every content query of a render returns draft revisions, so the
 * response must stay out of shared caches whether or not it is a page the
 * toolbar is injected into.
 *
 * The middleware reads `virtual:emdash/config` at module scope, so each case
 * loads a fresh module instance via `vi.resetModules()`.
 */
import { describe, expect, it, vi } from "vitest";

type Middleware = (context: unknown, next: () => Promise<Response>) => Promise<Response> | Response;

async function loadMiddleware(config: Record<string, unknown> = {}): Promise<Middleware> {
	vi.resetModules();
	vi.doMock("astro:middleware", () => ({
		defineMiddleware: (handler: unknown) => handler,
	}));
	vi.doMock("virtual:emdash/config", () => ({ default: config }));
	const mod = await import("../../../src/astro/middleware/request-context.js");
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test harness casts the middleware to a plain function
	return mod.default as unknown as Middleware;
}

function buildContext(opts: {
	path: string;
	routePattern?: string;
	user?: { id: string; role: number } | null;
	editCookie?: boolean;
	playground?: boolean;
}) {
	const url = new URL(`https://example.com${opts.path}`);
	return {
		request: new Request(url),
		url,
		routePattern: opts.routePattern ?? url.pathname,
		cache: { set: vi.fn() },
		cookies: {
			get: vi.fn((name: string) =>
				name === "emdash-edit-mode" && opts.editCookie ? { value: "true" } : undefined,
			),
			set: vi.fn(),
		},
		locals: { user: opts.user ?? null, __playgroundDb: opts.playground ? {} : undefined },
	};
}

const PUBLIC = "public, max-age=3600";

const publicResponse = (contentType: string, body = "payload") =>
	new Response(body, { headers: { "content-type": contentType, "Cache-Control": PUBLIC } });

const CONTRIBUTOR = { id: "u0", role: 20 };
const AUTHOR = { id: "u1", role: 30 };

const STORED_MEDIA = "/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2F01ABC.jpg&w=640";

describe("edit-mode responses and shared caches", () => {
	it.each([
		["/rss.xml", "application/rss+xml; charset=utf-8"],
		["/api/posts.json", "application/json"],
		["/partials/latest", "text/html"],
	])("keeps the edit-mode render of %s uncached", async (path, contentType) => {
		const onRequest = await loadMiddleware();
		const context = buildContext({ path, user: AUTHOR, editCookie: true });

		const res = await onRequest(context, async () => publicResponse(contentType));

		expect(await res.text()).toBe("payload");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(context.cache.set).toHaveBeenCalledWith(false);
	});

	it("keeps an edit-mode page uncached when the toolbar is turned off", async () => {
		const onRequest = await loadMiddleware({ toolbar: false });
		const context = buildContext({ path: "/blog", user: AUTHOR, editCookie: true });

		const res = await onRequest(context, async () =>
			publicResponse("text/html", "<html><body>hello</body></html>"),
		);

		expect(await res.text()).not.toContain("emdash-toolbar");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(context.cache.set).toHaveBeenCalledWith(false);
	});

	it("keeps an edit-mode feed uncached in the Playground", async () => {
		const onRequest = await loadMiddleware();
		const context = buildContext({
			path: "/rss.xml",
			user: AUTHOR,
			editCookie: true,
			playground: true,
		});

		const res = await onRequest(context, async () => publicResponse("application/rss+xml"));

		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		expect(context.cache.set).toHaveBeenCalledWith(false);
	});

	it.each([
		["an editor with edit mode off", { user: AUTHOR }],
		["a contributor sending the edit cookie", { user: CONTRIBUTOR, editCookie: true }],
		["a signed-out visitor sending the edit cookie", { editCookie: true }],
	])("leaves a feed's caching to the route for %s", async (_who, who) => {
		const onRequest = await loadMiddleware();
		const context = buildContext({ path: "/rss.xml", ...who });

		const res = await onRequest(context, async () => publicResponse("application/rss+xml"));

		expect(res.headers.get("Cache-Control")).toBe(PUBLIC);
		expect(context.cache.set).not.toHaveBeenCalled();
	});

	it("leaves a stored media image cacheable in edit mode", async () => {
		const onRequest = await loadMiddleware({ imageEndpointRoute: "/_image" });
		const context = buildContext({ path: STORED_MEDIA, user: AUTHOR, editCookie: true });

		const res = await onRequest(context, async () => publicResponse("image/webp"));

		expect(res.headers.get("Cache-Control")).toBe(PUBLIC);
		expect(context.cache.set).not.toHaveBeenCalled();
	});

	it.each([
		["another image source", { imageEndpointRoute: "/_image" }, "/_image?href=%2Fog%2Fpost.png"],
		["an image endpoint EmDash did not install", {}, STORED_MEDIA],
	])("keeps %s uncached in edit mode", async (_case, config, path) => {
		const onRequest = await loadMiddleware(config);
		const context = buildContext({ path, user: AUTHOR, editCookie: true });

		const res = await onRequest(context, async () => publicResponse("image/webp"));

		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});
});
