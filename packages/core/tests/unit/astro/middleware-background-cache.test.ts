import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { mockCreateRuntime, mockSetInvalidator } = vi.hoisted(() => {
	const setInvalidator = vi.fn();
	const runtime = new Proxy(
		{
			storage: null,
			db: {},
			hooks: {},
			email: null,
			configuredPlugins: [],
			rooms: null,
			sandboxedPluginEntries: [],
			setPluginContentCacheInvalidator: setInvalidator,
		},
		{
			get(target, property, receiver) {
				if (property === "then") return undefined;
				const value = Reflect.get(target, property, receiver);
				return Reflect.has(target, property) ? value : vi.fn(async () => ({ success: true }));
			},
		},
	);
	return {
		mockCreateRuntime: vi.fn(async () => runtime),
		mockSetInvalidator: setInvalidator,
	};
});

let schedulerValue: unknown = vi.fn();
vi.mock(
	"virtual:emdash/scheduler",
	() => ({
		get createScheduler() {
			return schedulerValue;
		},
	}),
	{ virtual: true },
);

vi.mock("virtual:emdash/build", () => ({ buildTime: undefined }), { virtual: true });
vi.mock(
	"virtual:emdash/config",
	() => ({
		default: { database: { config: {} }, auth: { mode: "none" } },
	}),
	{ virtual: true },
);
vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createRequestScopedDb: vi.fn(() => null),
		createCoalescingDialect: undefined,
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock("virtual:emdash/rooms", () => ({ createRoomHost: null }), { virtual: true });
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
vi.mock("../../../src/emdash-runtime.js", () => ({
	DB_INIT_DEADLINE_MS: 30_000,
	EmDashRuntime: { create: mockCreateRuntime },
}));
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(async () => ({
		selectFrom: () => ({ selectAll: () => ({ limit: () => ({ execute: async () => [] }) }) }),
	})),
}));

import onRequest from "../../../src/astro/middleware.js";

const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");
const SETUP_VERIFIED_KEY = Symbol.for("emdash:setup-verified");

function resetSingletons() {
	delete (globalThis as Record<symbol, unknown>)[RUNTIME_HOLDER_KEY];
	delete (globalThis as Record<symbol, unknown>)[SETUP_VERIFIED_KEY];
}

function createContext(
	options: { cache?: Record<string, unknown>; isPrerendered?: boolean; path?: string } = {},
) {
	const request = new Request(`https://example.com${options.path ?? "/robots.txt"}`);
	return {
		request,
		url: new URL(request.url),
		cookies: { get: vi.fn(() => undefined), set: vi.fn() },
		locals: {},
		redirect: vi.fn(),
		isPrerendered: options.isPrerendered ?? false,
		session: { get: vi.fn(async () => null) },
		cache: options.cache,
	};
}

beforeEach(() => {
	resetSingletons();
	schedulerValue = vi.fn();
	mockCreateRuntime.mockClear();
	mockSetInvalidator.mockClear();
});

describe("background route-cache invalidation binding", () => {
	it.each(["/", "/robots.txt"])(
		"forwards background invalidation to the request cache on %s",
		async (path) => {
			const cache = {
				enabled: true,
				invalidate: vi.fn(async () => {}),
			};
			const context = createContext({ cache, path });
			if (path === "/") {
				(globalThis as Record<symbol, unknown>)[SETUP_VERIFIED_KEY] = true;
			}

			expect((await onRequest(context as never, async () => new Response("ok"))).status).toBe(200);
			expect(mockSetInvalidator).toHaveBeenCalledOnce();

			const invalidator = mockSetInvalidator.mock.calls[0]?.[0] as (
				tags: string[],
			) => Promise<void>;
			await invalidator(["posts:post-1"]);
			expect(cache.invalidate).toHaveBeenCalledWith({ tags: ["posts:post-1"] });
		},
	);

	it.each([
		{ name: "the scheduler is unavailable", scheduler: false, enabled: true, prerendered: false },
		{ name: "route caching is disabled", scheduler: true, enabled: false, prerendered: false },
		{ name: "the request is prerendered", scheduler: true, enabled: true, prerendered: true },
		{ name: "the cache is absent", scheduler: true, enabled: undefined, prerendered: false },
	])("does not bind an invalidator when $name", async ({ scheduler, enabled, prerendered }) => {
		if (!scheduler) schedulerValue = null;
		const context = createContext({
			cache: enabled === undefined ? undefined : { enabled },
			isPrerendered: prerendered,
		});
		expect((await onRequest(context as never, async () => new Response("ok"))).status).toBe(200);
		expect(mockSetInvalidator).not.toHaveBeenCalled();
	});
});
