/**
 * Regression tests: preview and toolbar responses must opt out of Astro's
 * route cache, not just set `Cache-Control`.
 *
 * `Cache-Control: private, no-store` governs browsers and downstream
 * proxies, but the shared edge cache (e.g. Workers Cache on Cloudflare)
 * follows the route-cache options — on Cloudflare the adapter emits
 * `Cloudflare-CDN-Cache-Control` from them. Verified on a stock deploy:
 * a valid preview URL was a MISS on request 1 and a shared-cache HIT on
 * requests 2+, i.e. draft content was served without any token
 * verification until TTL/purge, even after token expiry.
 *
 * The fix calls `context.cache.set(false)` for requests carrying a
 * `_preview` param and for toolbar-injected editor responses.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("virtual:emdash/config", () => ({ default: { objectCacheEnabled: true } }));
// Route Astro's live-collection API to the real EmDash loader, so page renders
// read the database the middleware puts in the request context.
vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../../src/loader.js");
	const loader = emdashLoader();
	return {
		getLiveEntry: async (_name: string, filter: never) => {
			const entry = await loader.loadEntry!({ filter });
			return entry && !("error" in entry) ? { entry, cacheHint: {} } : { entry: undefined };
		},
	};
});

import type { Kysely } from "kysely";

import onRequest from "../../../src/astro/middleware/request-context.js";
import { resolveSecretsCached } from "../../../src/config/secrets.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import { __setObjectCacheBackendForTests, cachedQuery } from "../../../src/object-cache/index.js";
import { generatePreviewToken } from "../../../src/preview/tokens.js";
import { getEmDashEntry } from "../../../src/query.js";
import { getRequestContext, runWithContext } from "../../../src/request-context.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

function buildContext(opts: {
	pathname?: string;
	search?: string;
	user?: { id: string; role: number } | null;
	editCookie?: boolean;
	playgroundDb?: Kysely<Database>;
	emdashDb?: Kysely<Database>;
	cache: { enabled?: boolean; set: (input: unknown) => void } | undefined;
}) {
	const url = new URL(`https://example.com${opts.pathname ?? "/blog"}${opts.search ?? ""}`);
	return {
		request: new Request(url),
		url,
		cookies: {
			get: vi.fn((name: string) =>
				name === "emdash-edit-mode" && opts.editCookie ? { value: "true" } : undefined,
			),
			set: vi.fn(),
		},
		locals: {
			user: opts.user ?? null,
			emdash: opts.emdashDb && { db: opts.emdashDb },
			__playgroundDb: opts.playgroundDb,
		},
		cache: opts.cache,
	} as unknown as Parameters<typeof onRequest>[0];
}

const htmlResponse = () =>
	new Response("<html><body>hello</body></html>", {
		headers: { "content-type": "text/html" },
	});

afterEach(() => {
	__setObjectCacheBackendForTests(null);
});

describe("route-cache request context", () => {
	it("marks anonymous production cache renders as route-cache fills", async () => {
		const cache = { enabled: true, set: vi.fn() };
		const context = buildContext({ cache });
		let routeCacheFill: boolean | undefined;

		await onRequest(context, () => {
			routeCacheFill = getRequestContext()?.routeCacheFill;
			return htmlResponse();
		});

		expect(routeCacheFill).toBe(true);
	});

	it("rebuilds an anonymous route-cache fill from the loader", async () => {
		const store = new Map<string, string>();
		__setObjectCacheBackendForTests({
			get: (key) => Promise.resolve(store.get(key) ?? null),
			set: (key, value) => {
				store.set(key, value);
				return Promise.resolve();
			},
			delete: (key) => {
				store.delete(key);
				return Promise.resolve();
			},
		});
		await cachedQuery({
			namespace: "content:v2:posts",
			key: "list",
			load: () => Promise.resolve("Before publish"),
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		const context = buildContext({ cache: { enabled: true, set: vi.fn() } });
		const response = await onRequest(context, async () => {
			const title = await cachedQuery({
				namespace: "content:v2:posts",
				key: "list",
				load: () => Promise.resolve("After publish"),
			});
			return new Response(title);
		});

		expect(await response.text()).toBe("After publish");
	});

	it("keeps the anonymous fast path when route caching is disabled", async () => {
		const cache = { enabled: false, set: vi.fn() };
		const context = buildContext({ cache });
		let requestContext: ReturnType<typeof getRequestContext> = undefined;

		await onRequest(context, () => {
			requestContext = getRequestContext();
			return htmlResponse();
		});

		expect(requestContext).toBeUndefined();
	});

	it("opts out of the route cache when a _preview param is present", async () => {
		const cache = { set: vi.fn() };
		// No emdash.db on locals — token can't be verified, but the response
		// still must not be stored under the per-token URL.
		const context = buildContext({ search: "?_preview=some-token", cache });

		await onRequest(context, async () => htmlResponse());

		expect(cache.set).toHaveBeenCalledWith(false);
	});

	it("opts out of the route cache when the toolbar is injected", async () => {
		const cache = { set: vi.fn() };
		const context = buildContext({ user: { id: "u1", role: 30 }, cache });

		const response = await onRequest(context, async () => htmlResponse());

		// Confirm we're on the actual-injection path.
		expect(await response.text()).toContain('id="emdash-toolbar"');
		expect(cache.set).toHaveBeenCalledWith(false);
	});

	it("leaves the route cache alone for editor requests without injection (non-HTML)", async () => {
		const cache = { set: vi.fn() };
		const context = buildContext({
			pathname: "/api/data.json",
			user: { id: "u1", role: 30 },
			cache,
		});

		await onRequest(
			context,
			async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
		);

		expect(cache.set).not.toHaveBeenCalled();
	});

	it("leaves the route cache alone for anonymous requests without CMS signals", async () => {
		const cache = { set: vi.fn() };
		const context = buildContext({ cache });

		await onRequest(context, async () => htmlResponse());

		expect(cache.set).not.toHaveBeenCalled();
	});
});

describe("requests without a route-cache handle", () => {
	// Astro leaves `context.cache` undefined when its cache handler did not run
	// for the request, e.g. the 404 render for a URL that matches no route.
	it("serves a preview request instead of throwing", async () => {
		const context = buildContext({ search: "?_preview=some-token", cache: undefined });

		const response = await onRequest(context, async () => htmlResponse());

		expect(await response.text()).toContain("hello");
	});

	it("serves an editor request with the toolbar instead of throwing", async () => {
		const context = buildContext({ user: { id: "u1", role: 30 }, cache: undefined });

		const response = await onRequest(context, async () => htmlResponse());

		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await response.text()).toContain('id="emdash-toolbar"');
	});
});

describe("preview links", () => {
	let db: Kysely<Database>;
	let postId: string;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		const content = new ContentRepository(db);
		const created = await content.create(
			createPostFixture({ slug: "first", data: { title: "First live" } }),
		);
		await content.publish("post", created.id);
		const revision = await new RevisionRepository(db).create({
			collection: "post",
			entryId: created.id,
			data: { title: "First draft" },
		});
		await content.setDraftRevision("post", created.id, revision.id);
		postId = created.id;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function renderWithToken(token: string, site: "Playground" | "standard" = "Playground") {
		const cache = { set: vi.fn() };
		const context = buildContext({
			pathname: "/posts/first",
			search: `?_preview=${encodeURIComponent(token)}`,
			...(site === "Playground" ? { playgroundDb: db } : { emdashDb: db }),
			cache,
		});
		// The runtime middleware runs first and puts the site database in the
		// request context.
		const response = await runWithContext({ editMode: false, db }, () =>
			onRequest(context, async () => {
				const { entry } = await getEmDashEntry("post", "first");
				return new Response(String(entry?.data.title));
			}),
		);
		return { response, cache };
	}

	async function siteToken(expiresIn: string | number = "1h") {
		const { previewSecret } = await resolveSecretsCached(db);
		return generatePreviewToken({ contentId: `post:${postId}`, secret: previewSecret, expiresIn });
	}

	it.each(["Playground", "standard"] as const)(
		"renders the draft, uncached, for a valid token on a %s site",
		async (site) => {
			const { response, cache } = await renderWithToken(await siteToken(), site);

			expect(await response.text()).toBe("First draft");
			expect(response.headers.get("Cache-Control")).toBe("private, no-store");
			expect(cache.set).toHaveBeenCalledWith(false);
		},
	);

	it.each([
		{ name: "an expired token", token: () => siteToken(-60) },
		{
			name: "a token signed with another secret",
			token: () => generatePreviewToken({ contentId: `post:${postId}`, secret: "other-secret" }),
		},
	])("renders the published page in the Playground for $name", async ({ token }) => {
		const { response, cache } = await renderWithToken(await token());

		expect(await response.text()).toBe("First live");
		expect(cache.set).toHaveBeenCalledWith(false);
	});
});
