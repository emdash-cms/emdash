import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

// vi.mock factories are hoisted above normal `const` declarations; use
// vi.hoisted so the marker object is available both to the mock factory and
// to assertions below.
const { DB_DESCRIPTOR_MARKER, mockGetLastContentWriteAt } = vi.hoisted(() => {
	const config = { binding: "DB", session: "auto" };
	return {
		DB_CONFIG_MARKER: config,
		DB_DESCRIPTOR_MARKER: {
			config,
			needsLastContentWriteAt: undefined as boolean | undefined,
		},
		mockGetLastContentWriteAt: vi.fn(async () => 123_456),
	};
});

const { MOCK_RUNTIME } = vi.hoisted(() => {
	const publicPluginResult = { success: true, data: { ok: true } };
	const ok = async () => ({ success: true });
	const getPublicUrl = vi.fn((key: string) => `https://media.example.com/${key}`);
	const defaultRouteMeta = (pluginId: string, path: string) => {
		if (pluginId !== "emdash-forms") return null;
		if (path === "/definition") return { public: true, methods: ["POST"] as const };
		if (path === "/catalog") return { public: true, methods: ["GET"] as const };
		if (path === "/private") return { public: false };
		return null;
	};
	const getPluginRouteMeta = vi.fn(defaultRouteMeta);
	const handlePluginApiRoute = vi.fn(async (_pluginId: string, method: string, _path: string) => {
		if (method === "GET") return { success: true, data: { catalog: ["public"] } };
		return publicPluginResult;
	});
	const handleMediaUpload = vi.fn(ok);
	const refreshInstalledPluginRoute = vi.fn(async (_pluginId: string) => undefined);
	const mayNeedInstalledPluginRefresh = vi.fn((_pluginId: string) => true);
	const runPluginInstallLifecycle = vi.fn(async () => undefined);
	const runPluginActivateLifecycle = vi.fn(async () => undefined);
	const runPluginUninstallLifecycle = vi.fn(async () => undefined);
	const getRuntimePluginSettingsSchema = vi.fn(() => ({ apiKey: { type: "secret" } }));
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
			handleMediaUpload,
			handleMediaCreate: ok,
			handleMediaRegisterUpload: ok,
			handleMediaUpdate: ok,
			handleMediaDelete: ok,
			handleRevisionList: ok,
			handleRevisionEditors: ok,
			handleRevisionGet: ok,
			handleRevisionRestore: ok,
			getPluginRouteMeta,
			getPluginEditorExtension: () => null,
			getPluginEditorDraftSchema: async () => null,
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
			refreshInstalledPluginRoute,
			mayNeedInstalledPluginRefresh,
			runPluginInstallLifecycle,
			runPluginActivateLifecycle,
			runPluginUninstallLifecycle,
			getRuntimePluginSettingsSchema,
			setPluginStatus: async () => undefined,
		},
		mockGetPluginRouteMeta: getPluginRouteMeta,
		defaultGetPluginRouteMeta: defaultRouteMeta,
		mockHandleMediaUpload: handleMediaUpload,
		mockHandlePluginApiRoute: handlePluginApiRoute,
		mockGetPublicUrl: getPublicUrl,
		mockGetRuntimePluginSettingsSchema: getRuntimePluginSettingsSchema,
		mockRefreshInstalledPluginRoute: refreshInstalledPluginRoute,
		mockMayNeedInstalledPluginRefresh: mayNeedInstalledPluginRefresh,
		mockRunPluginActivateLifecycle: runPluginActivateLifecycle,
		mockRunPluginInstallLifecycle: runPluginInstallLifecycle,
		mockRunPluginUninstallLifecycle: runPluginUninstallLifecycle,
	};
});

const mockCreateRuntime = vi.hoisted(() => vi.fn());

const scopedDb = vi.hoisted(() => vi.fn().mockReturnValue(null));
const authConfig = vi.hoisted(() => ({ identityMode: "subject" }) as Record<string, unknown>);
vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {
			database: DB_DESCRIPTOR_MARKER,
			sessionEnabled: false,
			auth: { type: "siteboulder", entrypoint: "@siteboulder/emdash-auth", config: authConfig },
		},
	}),
	{ virtual: true },
);

vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createRequestScopedDb: scopedDb,
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
		create: mockCreateRuntime,
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

vi.mock("../../../src/object-cache/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/object-cache/index.js")>()),
	getLastContentWriteAt: mockGetLastContentWriteAt,
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("virtual:emdash/auth", () => ({ authenticate }), { virtual: true });

import runtimeMiddleware from "../../../src/astro/middleware.js";
import requestContextMiddleware from "../../../src/astro/middleware/request-context.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

let authMiddleware: typeof import("../../../src/astro/middleware/auth.js").onRequest;
beforeAll(async () => {
	vi.stubEnv("DEV", false);
	({ onRequest: authMiddleware } = await import("../../../src/astro/middleware/auth.js"));
});

const SETUP_VERIFIED_KEY = Symbol.for("emdash:setup-verified");
const RUNTIME_HOLDER_KEY = Symbol.for("emdash:runtime-holder");
beforeEach(() => {
	delete (globalThis as Record<symbol, unknown>)[SETUP_VERIFIED_KEY];
	delete (globalThis as Record<symbol, unknown>)[RUNTIME_HOLDER_KEY];
	mockCreateRuntime.mockReset().mockResolvedValue(MOCK_RUNTIME);
	authenticate.mockReset().mockResolvedValue({
		subject: "siteboulder-user-1",
		email: "owner@example.test",
		name: "Owner",
		role: 50,
	});
});

function chainContext(url: string, cookieValues: Record<string, string>, isPrerendered = false) {
	const cookieHeader = Object.entries(cookieValues)
		.map(([k, v]) => k + "=" + v)
		.join("; ");
	const parsed = new URL(url);
	const locals: Record<string, unknown> = {};
	const sessionRead = vi.fn();
	const context: Record<string, unknown> = {
		request: new Request(parsed, { headers: cookieHeader ? { cookie: cookieHeader } : {} }),
		url: parsed,
		cookies: {
			get: vi.fn((name: string) =>
				cookieValues[name] === undefined ? undefined : { value: cookieValues[name] },
			),
			set: vi.fn(),
		},
		locals,
		redirect: vi.fn(),
		isPrerendered,
	};
	Object.defineProperty(context, "session", { get: sessionRead });
	return { context, locals, sessionRead };
}

async function runChain(url: string, cookieValues: Record<string, string>, isPrerendered = false) {
	const { context, locals, sessionRead } = chainContext(url, cookieValues, isPrerendered);
	const response = await (runtimeMiddleware as any)(context, () =>
		(authMiddleware as any)(
			context,
			async () =>
				new Response("<html><body>page</body></html>", {
					headers: { "content-type": "text/html" },
				}),
		),
	);
	return { response, locals, sessionRead };
}

const credential = { "__Host-sbo-cms-access": "x".repeat(80) };

describe("a subject-mode editor on a public page, through the real runtime middleware", () => {
	afterEach(() => {
		delete authConfig.credentialCookie;
	});

	it("identifies a request carrying the declared credential instead of serving it anonymously", async () => {
		authConfig.credentialCookie = "__Host-sbo-cms-access";
		for (const url of [
			"https://admin.site.example/blog/post",
			"https://admin.site.example/blog/post?_edit=1",
		]) {
			authenticate.mockClear();
			const { response, locals, sessionRead } = await runChain(url, credential);
			expect(response.status, url).toBe(200);
			const emdash = locals.emdash as Record<string, unknown> | undefined;
			// The full runtime ran (config and db for the toolbar), and the credential was verified.
			expect(emdash && "config" in emdash && "db" in emdash, url).toBe(true);
			expect(authenticate, url).toHaveBeenCalledTimes(1);
			expect(sessionRead, url).not.toHaveBeenCalled();
			// A possible editor reads the primary, never a cached or replica binding.
			expect(scopedDb.mock.calls.at(-1)?.[0], url).toMatchObject({
				isAuthenticated: true,
				canUseCachedBinding: false,
			});
		}
	});

	it("never treats a prerendered render as carrying the credential", async () => {
		authConfig.credentialCookie = "__Host-sbo-cms-access";
		const { locals } = await runChain("https://admin.site.example/blog/post", credential, true);
		const emdash = locals.emdash as Record<string, unknown> | undefined;
		expect(!!emdash && "config" in emdash).toBe(false);
		expect(authenticate).not.toHaveBeenCalled();
	});

	it("keeps a visitor without the credential on the anonymous fast path, with no identity call", async () => {
		authConfig.credentialCookie = "__Host-sbo-cms-access";
		const { response } = await runChain("https://admin.site.example/blog/post", { other: "1" });
		expect(response.status).toBe(200);
		expect(authenticate).not.toHaveBeenCalled();
		expect(scopedDb.mock.calls.at(-1)?.[0]).toMatchObject({ isAuthenticated: false });
	});

	it("is unchanged for a descriptor that declares no credential, or is not in subject mode", async () => {
		for (const config of [
			{},
			{ identityMode: "email", credentialCookie: "__Host-sbo-cms-access" },
		]) {
			Object.assign(authConfig, { identityMode: "subject", ...config });
			const { locals } = await runChain("https://admin.site.example/blog/post", credential);
			const emdash = locals.emdash as Record<string, unknown> | undefined;
			expect(!!emdash && "config" in emdash, JSON.stringify(config)).toBe(false);
			expect(authenticate).not.toHaveBeenCalled();
		}
		authConfig.identityMode = "subject";
	});
});

describe("visual editing for a linked subject-mode editor, through runtime, auth and request context", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabase>>;
	beforeEach(async () => {
		db = await setupTestDatabase();
		const now = new Date().toISOString();
		await db
			.insertInto("users")
			.values({
				id: "u1",
				email: "owner@example.test",
				name: "Owner",
				role: 40,
				email_verified: 1,
				created_at: now,
				updated_at: now,
			})
			.execute();
		await db
			.insertInto("oauth_accounts")
			.values({
				provider: "external:siteboulder",
				provider_account_id: "siteboulder-user-1",
				user_id: "u1",
				created_at: now,
			})
			.execute();
		(MOCK_RUNTIME as { db: unknown }).db = db;
	});
	afterEach(async () => {
		delete authConfig.credentialCookie;
		(MOCK_RUNTIME as { db: unknown }).db = {};
		await teardownTestDatabase(db);
	});

	async function page(cookies: Record<string, string>) {
		const { context, locals } = chainContext("https://admin.site.example/blog/post", cookies);
		const response = await (runtimeMiddleware as any)(context, () =>
			(authMiddleware as any)(context, () =>
				(requestContextMiddleware as any)(
					context,
					async () =>
						new Response("<!doctype html><html><body>page</body></html>", {
							headers: { "content-type": "text/html", "cache-control": "public, max-age=60" },
						}),
				),
			),
		);
		return { response, locals, html: await response.text() };
	}

	it("shows the toolbar to a verified editor on a plain visit, never cached, at the provider's role", async () => {
		authConfig.credentialCookie = "__Host-sbo-cms-access";
		const editor = await page(credential);
		expect((editor.locals.user as { id: string; role: number }).id).toBe("u1");
		expect((editor.locals.user as { role: number }).role).toBe(50);
		expect(editor.html).toContain('id="emdash-toolbar"');
		expect(editor.response.headers.get("cache-control")).toContain("no-store");
	});

	it("shows no toolbar without the declaration, or when the provider rejects the credential", async () => {
		const undeclared = await page(credential);
		expect(undeclared.locals.user).toBeUndefined();
		expect(undeclared.html).not.toContain('id="emdash-toolbar"');
		authConfig.credentialCookie = "__Host-sbo-cms-access";
		authenticate.mockRejectedValue(new Error("No verified Site Boulder CMS identity"));
		const rejected = await page(credential);
		expect(rejected.response.status).toBe(200);
		expect(rejected.locals.user).toBeUndefined();
		expect(rejected.html).not.toContain('id="emdash-toolbar"');
	});
});
