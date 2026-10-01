import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { CONFIG, LOCAL_STORAGE, MOCK_RUNTIME, mockCreateRuntime } = vi.hoisted(() => {
	const localStorage = {
		entrypoint: "emdash/storage/local",
		config: { directory: "", baseUrl: "/_emdash/api/media/file" },
	};
	return {
		LOCAL_STORAGE: localStorage,
		CONFIG: {
			database: { config: { binding: "DB" } },
			auth: { mode: "none" },
			storage: localStorage as { entrypoint: string; config: Record<string, unknown> },
			imageEndpointRoute: "/_image" as string | undefined,
		},
		// Every runtime method is a no-op. `then` stays undefined so the runtime is
		// not mistaken for a thenable when a mock resolves with it.
		MOCK_RUNTIME: new Proxy(
			{ storage: null as unknown },
			{
				get: (target, key) =>
					key in target || key === "then" ? Reflect.get(target, key) : () => undefined,
			},
		),
		mockCreateRuntime: vi.fn(),
	};
});

vi.mock("virtual:emdash/config", () => ({ default: CONFIG }), { virtual: true });
vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createRequestScopedDb: vi.fn().mockReturnValue(null),
		createCoalescingDialect: undefined,
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({ createSandboxRunner: null, sandboxBypassed: false, sandboxEnabled: false }),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/storage",
	async () => {
		const { createStorage } = await import("../../../src/storage/local.js");
		return { createStorage: vi.fn(createStorage) };
	},
	{ virtual: true },
);

vi.mock("../../../src/emdash-runtime.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/emdash-runtime.js")>();
	return {
		DB_INIT_DEADLINE_MS: actual.DB_INIT_DEADLINE_MS,
		EmDashRuntime: {
			create: mockCreateRuntime,
			getStorage: actual.EmDashRuntime.getStorage,
		},
	};
});

vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }), { virtual: true });
vi.mock("@emdash-cms/auth", () => ({
	TOKEN_PREFIXES: {},
	generatePrefixedToken: vi.fn(),
	hashPrefixedToken: vi.fn(),
	VALID_SCOPES: [],
	validateScopes: vi.fn(),
	hasScope: vi.fn(() => false),
	computeS256Challenge: vi.fn(),
	Role: { ADMIN: 50 },
}));
vi.mock("@emdash-cms/auth/adapters/kysely", () => ({
	createKyselyAdapter: vi.fn((db: unknown) => ({
		getUserById: async (id: string) => ({ id, role: 50, disabled: false, db }),
		getUserByEmail: vi.fn(),
	})),
}));

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(async () => ({
		selectFrom: () => ({
			selectAll: () => ({ limit: () => ({ execute: async () => [] }) }),
		}),
	})),
}));

import { createRequestScopedDb } from "virtual:emdash/dialect";
import { createStorage } from "virtual:emdash/storage";

import onRequest from "../../../src/astro/middleware.js";
import { onRequest as authOnRequest } from "../../../src/astro/middleware/auth.js";
import { getDb } from "../../../src/loader.js";
import { getRequestContext } from "../../../src/request-context.js";
import { LocalStorage } from "../../../src/storage/local.js";
import { EmDashStorageError, type Storage } from "../../../src/storage/types.js";

const MEDIA_KEY = "01JIMAGEENDPOINT.png";
const MEDIA_BYTES = "png-bytes";
const SCOPED_DB = { _marker: "scoped" };

let mediaDir: string;

beforeAll(async () => {
	mediaDir = await mkdtemp(join(tmpdir(), "emdash-image-endpoint-"));
	LOCAL_STORAGE.config.directory = mediaDir;
	const storage = new LocalStorage({ directory: mediaDir, baseUrl: "/_emdash/api/media/file" });
	await storage.upload({
		key: MEDIA_KEY,
		body: new TextEncoder().encode(MEDIA_BYTES),
		contentType: "image/png",
	});
	MOCK_RUNTIME.storage = storage;
});

afterAll(async () => {
	await rm(mediaDir, { recursive: true, force: true });
});

beforeEach(() => {
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:setup-verified")];
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:runtime-holder")];
	CONFIG.storage = LOCAL_STORAGE;
	CONFIG.imageEndpointRoute = "/_image";
	mockCreateRuntime.mockReset().mockResolvedValue(MOCK_RUNTIME);
	vi.mocked(getDb).mockClear();
	vi.mocked(createRequestScopedDb).mockReset().mockReturnValue(null);
});

function imageRequestContext({
	cookieValues = {},
	sessionUser = null,
	locals = {},
}: {
	cookieValues?: Record<string, string>;
	sessionUser?: unknown;
	locals?: Record<string, unknown>;
} = {}) {
	const href = encodeURIComponent(`/_emdash/api/media/file/${MEDIA_KEY}`);
	const url = new URL(`https://example.com/_image?href=${href}&w=640&f=webp`);
	const sessionGet = vi.fn(async () => sessionUser);
	return {
		locals,
		sessionGet,
		context: {
			request: new Request(url),
			url,
			routePattern: "/_image",
			cookies: {
				get: vi.fn((name: string) =>
					cookieValues[name] === undefined ? undefined : { value: cookieValues[name] },
				),
				set: vi.fn(),
			},
			locals,
			redirect: vi.fn(),
			isPrerendered: false,
			session: { get: sessionGet },
		} as unknown as Parameters<typeof onRequest>[0],
	};
}

/** Stands in for the image endpoint: records the request's db and streams the bytes from storage. */
function imageEndpoint(locals: Record<string, unknown>, seen: { db?: unknown } = {}) {
	return vi.fn(async () => {
		seen.db = getRequestContext()?.db;
		const storage = (locals.emdash as { storage?: Storage } | undefined)?.storage;
		if (!storage) return new Response("stock endpoint", { status: 200 });
		const { body, contentType } = await storage.download(MEDIA_KEY);
		return new Response(body, { headers: { "Content-Type": contentType } });
	});
}

describe("astro middleware image endpoint requests", () => {
	it.each([
		["signed-out", { cookieValues: {}, sessionUser: null, user: undefined }],
		[
			"signed-in",
			{
				cookieValues: { "astro-session": "session-id", "emdash-edit-mode": "true" },
				sessionUser: { id: "admin-id" },
				user: { id: "admin-id", role: 50, disabled: false, db: SCOPED_DB },
			},
		],
	] as const)(
		"serves a %s image request on the request-scoped db without runtime init or a bookmark cookie",
		async (_label, { cookieValues, sessionUser, user }) => {
			const commit = vi.fn();
			const close = vi.fn();
			vi.mocked(createRequestScopedDb).mockReturnValue({ db: SCOPED_DB as never, commit, close });
			const { context, locals } = imageRequestContext({ cookieValues, sessionUser });
			const seen: { db?: unknown } = {};

			const response = await onRequest(context, () =>
				authOnRequest(context as never, imageEndpoint(locals, seen)),
			);

			expect(seen.db).toBe(SCOPED_DB);
			expect(locals.user).toEqual(user);
			expect(close).not.toHaveBeenCalled();
			expect(await response.text()).toBe(MEDIA_BYTES);
			expect(close).toHaveBeenCalledTimes(1);
			expect(commit).not.toHaveBeenCalled();
			expect(getDb).not.toHaveBeenCalled();
			expect(mockCreateRuntime).not.toHaveBeenCalled();
		},
	);

	it("resolves the user of a signed-in image request on an adapter without request scoping", async () => {
		const { context, locals } = imageRequestContext({
			cookieValues: { "astro-session": "session-id" },
			sessionUser: { id: "admin-id" },
		});

		const response = await onRequest(context, () =>
			authOnRequest(context as never, imageEndpoint(locals)),
		);

		expect(await response.text()).toBe(MEDIA_BYTES);
		expect((locals.user as { id?: string } | undefined)?.id).toBe("admin-id");
		expect(mockCreateRuntime).not.toHaveBeenCalled();
	});

	it("keeps runtime init for playground image requests", async () => {
		const { context, locals } = imageRequestContext({ locals: { __playgroundDb: {} } });

		await onRequest(context, imageEndpoint(locals));

		expect(mockCreateRuntime).toHaveBeenCalledTimes(1);
	});

	it("keeps runtime init for an image endpoint EmDash did not install", async () => {
		CONFIG.imageEndpointRoute = undefined;
		const { context, locals } = imageRequestContext();

		await onRequest(context, imageEndpoint(locals));

		expect(mockCreateRuntime).toHaveBeenCalledTimes(1);
	});

	it("falls back to the runtime path when the storage adapter cannot be created", async () => {
		CONFIG.storage = {
			entrypoint: "@emdash-cms/cloudflare/storage/r2",
			config: { binding: "MEDIA" },
		};
		vi.mocked(createStorage!).mockImplementationOnce(() => {
			throw new EmDashStorageError('R2 binding "MEDIA" not found.', "BINDING_NOT_FOUND");
		});
		mockCreateRuntime.mockRejectedValue(
			new EmDashStorageError('R2 binding "MEDIA" not found.', "BINDING_NOT_FOUND"),
		);
		const { context, locals } = imageRequestContext();

		const response = await onRequest(context, imageEndpoint(locals));

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("stock endpoint");
		expect(mockCreateRuntime).toHaveBeenCalledTimes(1);
	});
});
