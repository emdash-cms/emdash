import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

// vi.mock factories are hoisted above normal `const` declarations; use
// vi.hoisted so the marker object is available both to the mock factory and
// to assertions below.
const { DB_CONFIG_MARKER } = vi.hoisted(() => ({
	DB_CONFIG_MARKER: { binding: "DB", session: "auto" },
}));

const {
	MOCK_RUNTIME,
	PUBLIC_PLUGIN_RESULT,
	mockGetPluginRouteMeta,
	mockHandlePluginApiRoute,
	mockGetPublicUrl,
} = vi.hoisted(() => {
	const publicPluginResult = { success: true, data: { ok: true } };
	const ok = async () => ({ success: true });
	const getPublicUrl = vi.fn((key: string) => `https://media.example.com/${key}`);
	const getPluginRouteMeta = vi.fn((pluginId: string, path: string) => {
		if (pluginId !== "emdash-forms") return null;
		if (path === "/definition") return { public: true };
		if (path === "/private") return { public: false };
		return null;
	});
	const handlePluginApiRoute = vi.fn(async () => publicPluginResult);

	return {
		MOCK_RUNTIME: {
			storage: { getPublicUrl },
			db: {},
			hooks: {},
			email: null,
			configuredPlugins: [],
			handleContentList: ok,
			handleContentGet: ok,
			handleContentAuthors: ok,
			handleContentCreate: ok,
			handleContentUpdate: ok,
			handleContentDelete: ok,
			handleContentListTrashed: ok,
			handleContentRestore: ok,
			handleContentPermanentDelete: ok,
			handleContentCountTrashed: ok,
			handleContentGetIncludingTrashed: ok,
			handleContentDuplicate: ok,
			handleContentPublish: ok,
			handleContentUnpublish: ok,
			handleContentSchedule: ok,
			handleContentUnschedule: ok,
			handleContentCountScheduled: ok,
			handleContentDiscardDraft: ok,
			handleContentCompare: ok,
			handleContentTranslations: ok,
			handleMediaList: ok,
			handleMediaGet: ok,
			handleMediaCreate: ok,
			handleMediaUpdate: ok,
			handleMediaDelete: ok,
			handleRevisionList: ok,
			handleRevisionGet: ok,
			handleRevisionRestore: ok,
			getPluginRouteMeta,
			handlePluginApiRoute,
			getPluginMcpTools: async () => [],
			getEnabledPluginMcpTools: async () => [],
			serializePluginMcpConsent: () => "[]",
			handlePluginMcpTool: ok,
			handlePluginMcpDenied: async () => undefined,
			getMediaProvider: () => undefined,
			getMediaProviderList: () => [],
			collectPageMetadata: async () => [],
			collectPageFragments: async () => [],
			ensureSearchHealthy: async () => undefined,
			getManifest: async () => ({}),
			getSandboxRunner: () => null,
			isSandboxBypassed: () => false,
			syncMarketplacePlugins: async () => undefined,
			syncRegistryPlugins: async () => undefined,
			setPluginStatus: async () => undefined,
		},
		PUBLIC_PLUGIN_RESULT: publicPluginResult,
		mockGetPluginRouteMeta: getPluginRouteMeta,
		mockHandlePluginApiRoute: handlePluginApiRoute,
		mockGetPublicUrl: getPublicUrl,
	};
});

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {
			database: { config: DB_CONFIG_MARKER },
			auth: { mode: "none" },
		},
	}),
	{ virtual: true },
);

vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createRequestScopedDb: vi.fn().mockReturnValue(null),
		// Absent on non-batching backends; the runtime falls back to the singleton.
		createCoalescingDialect: undefined,
	}),
	{ virtual: true },
);

vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({
		createSandboxRunner: null,
		sandboxBypassed: false,
		sandboxEnabled: false,
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }), { virtual: true });
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("virtual:emdash/scheduler", () => ({ createScheduler: null }), { virtual: true });

vi.mock("../../../src/emdash-runtime.js", () => ({
	DB_INIT_DEADLINE_MS: 30_000,
	EmDashRuntime: {
		create: async () => MOCK_RUNTIME,
	},
}));

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(async () => ({
		selectFrom: () => ({
			selectAll: () => ({
				limit: () => ({
					execute: async () => [],
				}),
			}),
		}),
	})),
}));

import { createRequestScopedDb } from "virtual:emdash/dialect";

import onRequest from "../../../src/astro/middleware.js";
import { getDb } from "../../../src/loader.js";
import { getRequestContext } from "../../../src/request-context.js";

/** Reset the globalThis-backed singletons between tests. */
const SETUP_VERIFIED_KEY = Symbol.for("emdash:setup-verified");
const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");
function resetSetupVerified() {
	delete (globalThis as Record<symbol, unknown>)[SETUP_VERIFIED_KEY];
	delete (globalThis as Record<symbol, unknown>)[RUNTIME_HOLDER_KEY];
}

/** A getDb stub whose migrations-probe query throws `error`. */
function getDbThatFailsProbe(error: Error) {
	return {
		selectFrom: () => ({
			selectAll: () => ({
				limit: () => ({
					execute: async () => {
						throw error;
					},
				}),
			}),
		}),
	};
}

function createAnonymousPublicPageContext(locals: Record<string, unknown> = {}) {
	const cookies = {
		get: vi.fn((name: string) => {
			if (name === "astro-session") return undefined;
			return undefined;
		}),
		set: vi.fn(),
	};
	const sessionGet = vi.fn(async () => null);
	const astroSession = { get: sessionGet };

	return {
		context: {
			request: new Request("https://example.com/contact"),
			url: new URL("https://example.com/contact"),
			cookies,
			locals,
			redirect: vi.fn(),
			isPrerendered: false,
			session: astroSession,
		} as Record<string, unknown>,
		cookies,
		sessionGet,
	};
}

describe("astro middleware prerendered routes", () => {
	beforeEach(() => {
		vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
		mockGetPluginRouteMeta.mockClear();
		mockHandlePluginApiRoute.mockClear();
		mockGetPublicUrl.mockClear();
	});

	it("does not access context.session on prerendered public runtime routes", async () => {
		const cookies = {
			get: vi.fn(() => undefined),
		};
		const locals: Record<string, unknown> = {};

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/robots.txt"),
			url: new URL("https://example.com/robots.txt"),
			cookies,
			locals,
			redirect: vi.fn(),
			isPrerendered: true,
		};

		Object.defineProperty(context, "session", {
			get() {
				throw new Error("context.session should not be accessed during prerender");
			},
		});

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok"),
		);

		expect(response.status).toBe(200);
		const emdash = locals.emdash as Record<string, unknown>;
		expect(typeof emdash.handlePluginApiRoute).toBe("function");
		expect(typeof emdash.handlePublicPluginApiRoute).toBe("function");
		// Regression for #1462: the author filter route reads
		// `locals.emdash.handleContentAuthors`; it must be wired onto the
		// runtime helpers object or every `/authors` request 500s.
		expect(typeof emdash.handleContentAuthors).toBe("function");
	});

	it("does not access context.session when prerendering public pages", async () => {
		const cookies = {
			get: vi.fn(() => undefined),
		};
		const redirect = vi.fn(
			(location: string) => new Response(null, { status: 302, headers: { Location: location } }),
		);

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/"),
			url: new URL("https://example.com/"),
			cookies,
			locals: {},
			redirect,
			isPrerendered: true,
		};

		Object.defineProperty(context, "session", {
			get() {
				throw new Error("context.session should not be accessed during prerender");
			},
		});

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok"),
		);

		expect(response.status).toBe(200);
		expect(redirect).not.toHaveBeenCalled();
	});
});

describe("astro middleware anonymous session reads", () => {
	beforeEach(() => {
		vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
		mockGetPluginRouteMeta.mockClear();
		mockHandlePluginApiRoute.mockClear();
		mockGetPublicUrl.mockClear();
	});

	it("does not read the Astro session when no astro-session cookie is present", async () => {
		// Regression test for #733: on Cloudflare Workers the Astro session
		// backend is KV, so calling session.get() on every anonymous public
		// request produces a flood of KV read misses. The middleware must
		// skip the session lookup entirely when no astro-session cookie is set.
		const cookies = {
			get: vi.fn((name: string) => {
				if (name === "astro-session") return undefined;
				return undefined;
			}),
			set: vi.fn(),
		};
		const sessionGet = vi.fn(async () => null);
		const astroSession = { get: sessionGet };

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/"),
			url: new URL("https://example.com/"),
			cookies,
			locals: {},
			redirect: vi.fn(),
			isPrerendered: false,
			session: astroSession,
		};

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok"),
		);

		expect(response.status).toBe(200);
		expect(sessionGet).not.toHaveBeenCalled();
	});

	it("exposes only restricted public runtime helpers to anonymous public pages", async () => {
		const locals: Record<string, unknown> = {};
		const { context, sessionGet } = createAnonymousPublicPageContext(locals);

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok"),
		);

		expect(response.status).toBe(200);
		expect(sessionGet).not.toHaveBeenCalled();
		const emdash = locals.emdash as Record<string, unknown>;
		expect(typeof emdash.handlePublicPluginApiRoute).toBe("function");
		expect(typeof emdash.collectPageMetadata).toBe("function");
		expect(typeof emdash.collectPageFragments).toBe("function");
		expect(typeof emdash.getPublicMediaUrl).toBe("function");
		expect((emdash.getPublicMediaUrl as (key: string) => string)("01ABC.jpg")).toBe(
			"https://media.example.com/01ABC.jpg",
		);
		expect(mockGetPublicUrl).toHaveBeenCalledWith("01ABC.jpg");
		expect("handlePluginApiRoute" in emdash).toBe(false);
		expect("getPluginRouteMeta" in emdash).toBe(false);
		expect("handleContentList" in emdash).toBe(false);
		expect("db" in emdash).toBe(false);
		expect("config" in emdash).toBe(false);
	});

	it("dispatches public plugin API routes through the anonymous public-page helper", async () => {
		const locals: Record<string, unknown> = {};
		const { context } = createAnonymousPublicPageContext(locals);

		await onRequest(context as Parameters<typeof onRequest>[0], async () => new Response("ok"));

		const emdash = locals.emdash as Record<string, unknown>;
		const request = new Request("https://example.com/_emdash/api/plugins/emdash-forms/definition", {
			method: "POST",
			body: "{}",
		});

		await expect(
			(
				emdash.handlePublicPluginApiRoute as (
					pluginId: string,
					method: string,
					path: string,
					request: Request,
				) => Promise<unknown>
			)("emdash-forms", "POST", "/definition", request),
		).resolves.toBe(PUBLIC_PLUGIN_RESULT);

		expect(mockGetPluginRouteMeta).toHaveBeenCalledWith("emdash-forms", "/definition");
		expect(mockHandlePluginApiRoute).toHaveBeenCalledWith(
			"emdash-forms",
			"POST",
			"/definition",
			request,
		);
	});

	it("does not dispatch private plugin API routes through the anonymous public-page helper", async () => {
		const locals: Record<string, unknown> = {};
		const { context } = createAnonymousPublicPageContext(locals);

		await onRequest(context as Parameters<typeof onRequest>[0], async () => new Response("ok"));

		const emdash = locals.emdash as Record<string, unknown>;

		await expect(
			(
				emdash.handlePublicPluginApiRoute as (
					pluginId: string,
					method: string,
					path: string,
					request: Request,
				) => Promise<unknown>
			)(
				"emdash-forms",
				"POST",
				"/private",
				new Request("https://example.com/_emdash/api/plugins/emdash-forms/private"),
			),
		).resolves.toEqual({
			success: false,
			error: { code: "NOT_FOUND", message: "Plugin route not found" },
		});

		expect(mockGetPluginRouteMeta).toHaveBeenCalledWith("emdash-forms", "/private");
		expect(mockHandlePluginApiRoute).not.toHaveBeenCalled();
	});

	it("reads the Astro session when an astro-session cookie is present", async () => {
		const cookies = {
			get: vi.fn((name: string) => {
				if (name === "astro-session") return { value: "abc123" };
				return undefined;
			}),
			set: vi.fn(),
		};
		const sessionGet = vi.fn(async () => null);
		const astroSession = { get: sessionGet };

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/", {
				headers: { cookie: "astro-session=abc123" },
			}),
			url: new URL("https://example.com/"),
			cookies,
			locals: {},
			redirect: vi.fn(),
			isPrerendered: false,
			session: astroSession,
		};

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok"),
		);

		expect(response.status).toBe(200);
		expect(sessionGet).toHaveBeenCalledWith("user");
	});
});

describe("astro middleware request-scoped db", () => {
	beforeEach(() => {
		vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
		mockGetPluginRouteMeta.mockClear();
		mockHandlePluginApiRoute.mockClear();
		mockGetPublicUrl.mockClear();
	});

	it("asks the adapter for a scoped db on anonymous public pages and exposes it via ALS", async () => {
		const commit = vi.fn();
		const scopedDb = { _marker: "scoped" };
		vi.mocked(createRequestScopedDb).mockReturnValue({
			db: scopedDb as never,
			commit,
		});

		const cookies = {
			get: vi.fn(() => undefined),
			set: vi.fn(),
		};
		const astroSession = {
			get: vi.fn(async () => null),
		};

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/"),
			url: new URL("https://example.com/"),
			cookies,
			locals: {},
			redirect: vi.fn(),
			isPrerendered: false,
			session: astroSession,
		};

		let dbSeenByNext: unknown;
		const response = await onRequest(context as Parameters<typeof onRequest>[0], async () => {
			dbSeenByNext = getRequestContext()?.db;
			return new Response("ok");
		});

		expect(response.status).toBe(200);
		expect(createRequestScopedDb).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(createRequestScopedDb).mock.calls[0]?.[0];
		// Opts shape matches the RequestScopedDbOpts contract declared in
		// virtual-modules.d.ts. The `config` field name must match exactly —
		// it's what the D1 adapter reads; a rename silently breaks D1 sessions.
		expect(opts).toMatchObject({
			config: DB_CONFIG_MARKER,
			isAuthenticated: false,
			isWrite: false,
			cookies,
		});
		expect(dbSeenByNext).toBe(scopedDb);
		expect(commit).toHaveBeenCalledTimes(1);
		// ALS must be fully torn down after the middleware returns; otherwise
		// a refactor to enterWith() could silently leak request state into
		// other async work on the same worker.
		expect(getRequestContext()).toBeUndefined();
	});

	it("marks an API-token (Bearer) request as authenticated even without a session cookie", async () => {
		// API tokens (ec_pat_*) and OAuth tokens (ec_oat_*) authenticate via the
		// Authorization header, not the astro-session cookie, so sessionUser is
		// null. They still expect read-your-writes, so the adapter must see
		// isAuthenticated: true (keeps them on the primary/uncached connection,
		// not a replica or the Hyperdrive query cache). These hit /_emdash/api/*,
		// which is the main scoped path (the anonymous fast path is public-only).
		const commit = vi.fn();
		vi.mocked(createRequestScopedDb).mockReturnValue({
			db: { _marker: "scoped" } as never,
			commit,
		});

		const cookies = { get: vi.fn(() => undefined), set: vi.fn() };
		const astroSession = { get: vi.fn(async () => null) };

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/_emdash/api/content/posts", {
				headers: { authorization: "Bearer ec_pat_example" },
			}),
			url: new URL("https://example.com/_emdash/api/content/posts"),
			cookies,
			locals: {},
			redirect: vi.fn(),
			isPrerendered: false,
			session: astroSession,
		};

		await onRequest(context as Parameters<typeof onRequest>[0], async () => new Response("ok"));

		const opts = vi.mocked(createRequestScopedDb).mock.calls[0]?.[0];
		expect(opts).toMatchObject({
			config: DB_CONFIG_MARKER,
			isAuthenticated: true,
			isWrite: false,
		});
	});

	it("forces isWrite true for POST requests on public pages", async () => {
		const commit = vi.fn();
		vi.mocked(createRequestScopedDb).mockReturnValue({
			db: { _marker: "scoped" } as never,
			commit,
		});

		const cookies = { get: vi.fn(() => undefined), set: vi.fn() };
		const astroSession = { get: vi.fn(async () => null) };

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/", { method: "POST" }),
			url: new URL("https://example.com/"),
			cookies,
			locals: {},
			redirect: vi.fn(),
			isPrerendered: false,
			session: astroSession,
		};

		await onRequest(context as Parameters<typeof onRequest>[0], async () => new Response("ok"));

		const opts = vi.mocked(createRequestScopedDb).mock.calls[0]?.[0];
		expect(opts).toMatchObject({
			config: DB_CONFIG_MARKER,
			isAuthenticated: false,
			isWrite: true,
		});
	});
});

describe("astro middleware setup probe", () => {
	beforeEach(() => {
		// The "setup verified" flag is a globalThis singleton that latches once a
		// probe (or runtime init) succeeds. Reset it so each test exercises a
		// fresh probe.
		resetSetupVerified();
		vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
		vi.mocked(getDb).mockReset();
	});

	/** Anonymous GET to a public frontend page (e.g. a category page). */
	function anonymousCategoryPageContext() {
		const cookies = {
			get: vi.fn((name: string) => {
				if (name === "astro-session") return undefined;
				return undefined;
			}),
			set: vi.fn(),
		};
		const redirect = vi.fn(
			(location: string) => new Response(null, { status: 302, headers: { Location: location } }),
		);
		return {
			context: {
				request: new Request("https://example.com/category/news"),
				url: new URL("https://example.com/category/news"),
				cookies,
				locals: {} as Record<string, unknown>,
				redirect,
				isPrerendered: false,
				session: { get: vi.fn(async () => null) },
			} as Record<string, unknown>,
			redirect,
		};
	}

	it("redirects to setup when the migrations table is genuinely missing", async () => {
		// Fresh, un-migrated database: the probe query reports a missing table.
		vi.mocked(getDb).mockResolvedValue(
			getDbThatFailsProbe(new Error("no such table: _emdash_migrations")) as never,
		);

		const { context, redirect } = anonymousCategoryPageContext();
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(context as Parameters<typeof onRequest>[0], next);

		expect(redirect).toHaveBeenCalledWith("/_emdash/admin/setup");
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/_emdash/admin/setup");
		expect(next).not.toHaveBeenCalled();
	});

	it("does NOT redirect to setup on a transient DB error (regression)", async () => {
		// A set-up site whose probe hits a transient failure (D1 connection
		// loss, replica unavailable, timeout, locked SQLite) must keep serving
		// the page — never bounce real visitors to the setup wizard.
		vi.mocked(getDb).mockResolvedValue(
			getDbThatFailsProbe(new Error("D1_ERROR: Network connection lost")) as never,
		);

		const { context, redirect } = anonymousCategoryPageContext();
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(context as Parameters<typeof onRequest>[0], next);

		expect(redirect).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
	});

	it("does NOT redirect to setup during prerender even when migrations are missing (regression)", async () => {
		// A prerendered route is built to static HTML. If the setup probe ran at
		// build time it would see CI's legitimately-empty database, report a
		// missing migrations table, and bake context.redirect("/_emdash/admin/setup")
		// into every prerendered page -- shipping that redirect to production. The
		// probe must be skipped entirely when prerendering.
		vi.mocked(getDb).mockResolvedValue(
			getDbThatFailsProbe(new Error("no such table: _emdash_migrations")) as never,
		);

		const { context, redirect } = anonymousCategoryPageContext();
		context.isPrerendered = true;
		const next = vi.fn(async () => new Response("page"));

		const response = await onRequest(context as Parameters<typeof onRequest>[0], next);

		expect(redirect).not.toHaveBeenCalled();
		expect(getDb).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
	});
});
