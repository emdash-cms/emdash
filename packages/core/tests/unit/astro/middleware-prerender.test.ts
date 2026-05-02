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
	}),
	{ virtual: true },
);

vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({
		createSandboxRunner: null,
		sandboxEnabled: false,
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }), { virtual: true });
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

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
import { getRequestContext } from "../../../src/request-context.js";

describe("astro middleware prerendered routes", () => {
	beforeEach(() => {
		vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
	});

	it("does not access context.session on prerendered public runtime routes", async () => {
		const cookies = {
			get: vi.fn(() => undefined),
		};

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/robots.txt"),
			url: new URL("https://example.com/robots.txt"),
			cookies,
			locals: {},
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
