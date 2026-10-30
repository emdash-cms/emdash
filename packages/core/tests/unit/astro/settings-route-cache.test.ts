import type { Kysely } from "kysely";
import { Kysely as KyselyClass, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
const config = vi.hoisted(() => ({ objectCacheEnabled: false, toolbar: false }));
vi.mock("virtual:emdash/config", () => ({ default: config }));

import { onRequest as redirectMiddleware } from "../../../src/astro/middleware/redirect.js";
import requestContextMiddleware from "../../../src/astro/middleware/request-context.js";
import { prefetchLayoutData } from "../../../src/astro/prefetch.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { getMenu } from "../../../src/menus/index.js";
import { __setObjectCacheBackendForTests } from "../../../src/object-cache/index.js";
import { createObjectCache as createMemoryCache } from "../../../src/object-cache/memory.js";
import { publishRedirectArtifacts } from "../../../src/redirects/artifacts.js";
import { invalidateRedirectCache } from "../../../src/redirects/cache.js";
import { requestCached } from "../../../src/request-cache.js";
import { runWithContext } from "../../../src/request-context.js";
import {
	getSiteSettings,
	invalidateSiteSettingsSnapshot,
	setSiteSettings,
} from "../../../src/settings/index.js";

interface QueryCounts {
	selects: number;
	redirectStateSelects: number;
}

function createCountingDatabase(counts: QueryCounts): Kysely<Database> {
	const sqlite = openNodeSqliteDatabase(":memory:");
	return new KyselyClass<Database>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level !== "query" || !/^select/i.test(event.query.sql.trim())) return;
			counts.selects++;
			if (event.query.sql.includes("_emdash_redirect_state")) counts.redirectStateSelects++;
		},
	});
}

function resetCounts(counts: QueryCounts): void {
	counts.selects = 0;
	counts.redirectStateSelects = 0;
}

function buildContext(
	cache: {
		enabled: boolean;
		options: { tags: string[]; maxAge: number | undefined };
		set: ReturnType<typeof vi.fn>;
	},
	db: Kysely<Database>,
) {
	const url = new URL("https://example.com/");
	return {
		url,
		request: new Request(url),
		cookies: { get: vi.fn(), set: vi.fn() },
		locals: { emdash: { db } },
		cache,
	};
}

type MiddlewareContext = Parameters<typeof redirectMiddleware>[0];

async function renderPipeline(
	db: Kysely<Database>,
	cache: {
		enabled: boolean;
		options: { tags: string[]; maxAge: number };
		set: ReturnType<typeof vi.fn>;
	},
) {
	const context = buildContext(cache, db) as unknown as MiddlewareContext;
	return runWithContext({ editMode: false, db }, () =>
		redirectMiddleware(context, () =>
			requestContextMiddleware(context, async () => {
				const settings = await getSiteSettings();
				return new Response(settings.seo?.googleVerification ?? "missing");
			}),
		),
	);
}

function lazyResponse(gate: Promise<void>): Response {
	return new Response(
		new ReadableStream({
			async start(controller) {
				await gate;
				const settings = await getSiteSettings();
				controller.enqueue(new TextEncoder().encode(settings.seo?.googleVerification ?? "missing"));
				controller.close();
			},
		}),
	);
}

async function renderLazyPipeline(
	db: Kysely<Database>,
	cache: {
		enabled: boolean;
		options: { tags: string[]; maxAge: number };
		set: ReturnType<typeof vi.fn>;
	},
	gate: Promise<void>,
) {
	const context = buildContext(cache, db) as unknown as MiddlewareContext;
	return runWithContext({ editMode: false, db }, () =>
		redirectMiddleware(context, () =>
			requestContextMiddleware(context, async () => lazyResponse(gate)),
		),
	);
}

describe("settings freshness in route-cache renders", () => {
	let db: Kysely<Database>;
	let counts: QueryCounts;

	beforeEach(async () => {
		config.objectCacheEnabled = false;
		counts = { selects: 0, redirectStateSelects: 0 };
		db = createCountingDatabase(counts);
		await runMigrations(db);
		await setSiteSettings({ seo: { googleVerification: "old" } }, db);
		await db
			.insertInto("_emdash_menus")
			.values({ id: "primary", name: "primary", label: "Primary" })
			.execute();
		await publishRedirectArtifacts(db);
		invalidateRedirectCache();
		invalidateSiteSettingsSnapshot();
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		__setObjectCacheBackendForTests(null);
		invalidateRedirectCache();
		invalidateSiteSettingsSnapshot();
		await db.destroy();
	});

	it("opts out stale renders, refreshes settings, and caches the next fresh render", async () => {
		const warmCache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		expect(await (await renderPipeline(db, warmCache)).text()).toBe("old");
		expect(warmCache.set).not.toHaveBeenCalled();

		resetCounts(counts);
		await new OptionsRepository(db).set("site:seo", { googleVerification: "new" });
		const staleCache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		expect(await (await renderPipeline(db, staleCache)).text()).toBe("old");
		expect(staleCache.set).toHaveBeenCalledWith(false);
		expect(counts.redirectStateSelects).toBe(1);
		expect(counts.selects).toBe(1);

		const freshCache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		expect(await (await renderPipeline(db, freshCache)).text()).toBe("new");
		expect(freshCache.set).not.toHaveBeenCalled();
	});

	it("reloads a pre-write cold load first consumed after cache headers are finalized", async () => {
		const cache = () => ({
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		});
		await renderPipeline(db, cache());
		invalidateSiteSettingsSnapshot();

		let releaseLoad!: () => void;
		const loadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		let loadReached!: () => void;
		const started = new Promise<void>((resolve) => {
			loadReached = resolve;
		});
		let releaseStream!: () => void;
		const streamGate = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		const original = OptionsRepository.prototype.getVersionedByPrefix;
		let first = true;
		const spy = vi
			.spyOn(OptionsRepository.prototype, "getVersionedByPrefix")
			.mockImplementation(async function (this: OptionsRepository, prefix, options) {
				const result = await original.call(this, prefix, options);
				if (first) {
					first = false;
					loadReached();
					await loadGate;
				}
				return result;
			});
		try {
			const pending = runWithContext({ editMode: false, db }, () => getSiteSettings());
			await started;
			await new OptionsRepository(db).set("site:seo", { googleVerification: "new" });
			const candidate = cache();
			const response = await renderLazyPipeline(db, candidate, streamGate);
			expect(candidate.set).not.toHaveBeenCalled();
			releaseLoad();
			expect((await pending).seo?.googleVerification).toBe("old");
			releaseStream();
			expect(await response.text()).toBe("new");
		} finally {
			releaseLoad();
			releaseStream();
			spy.mockRestore();
		}
	});

	it("uses the existing warm redirect-state verification for the settings version", async () => {
		await renderPipeline(db, {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		});
		resetCounts(counts);

		await renderPipeline(db, {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		});

		expect(counts.selects).toBe(1);
		expect(counts.redirectStateSelects).toBe(1);
	});

	it.each([false, true])(
		"opts out before a lazy streamed settings read (object cache: %s)",
		async (objectCacheEnabled) => {
			config.objectCacheEnabled = objectCacheEnabled;
			if (objectCacheEnabled) {
				__setObjectCacheBackendForTests(createMemoryCache({}), {
					keyPrefix: `settings-route-${crypto.randomUUID()}`,
				});
			}

			const warmCache = {
				enabled: true,
				options: { tags: ["emdash:settings"], maxAge: 3600 },
				set: vi.fn(),
			};
			await (await renderPipeline(db, warmCache)).text();
			await waitForDeferredTasks();
			await new OptionsRepository(db).set("site:seo", { googleVerification: "new" });

			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const cache = {
				enabled: true,
				options: { tags: ["emdash:settings"], maxAge: 3600 },
				set: vi.fn(),
			};
			try {
				const response = await renderLazyPipeline(db, cache, gate);
				if (objectCacheEnabled) {
					expect(cache.set).not.toHaveBeenCalled();
				} else {
					expect(cache.set).toHaveBeenCalledWith(false);
				}
				release();
				expect(await response.text()).toBe("new");
			} finally {
				release();
			}
		},
	);

	it("pins the verified settings snapshot for a lazy streamed read", async () => {
		const warmCache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		await (await renderPipeline(db, warmCache)).text();
		await waitForDeferredTasks();

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		try {
			const response = await renderLazyPipeline(db, cache, gate);
			expect(cache.set).not.toHaveBeenCalled();
			await setSiteSettings({ seo: { googleVerification: "new" } }, db);
			await runWithContext({ editMode: false, db }, () => getSiteSettings());
			release();
			expect(await response.text()).toBe("old");
		} finally {
			release();
		}
	});

	it("reuses prefetched layout data without duplicate queries", async () => {
		config.objectCacheEnabled = false;
		await renderPipeline(db, {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		});
		resetCounts(counts);
		const cache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};

		await runWithContext({ editMode: false, db }, async () => {
			await prefetchLayoutData();
			resetCounts(counts);
			const context = buildContext(cache, db) as unknown as MiddlewareContext;
			await redirectMiddleware(context, () =>
				requestContextMiddleware(context, async () => {
					await getSiteSettings();
					await getMenu("primary");
					return new Response("ok");
				}),
			);
		});

		expect(counts.selects).toBe(1);
		expect(counts.redirectStateSelects).toBe(1);
		expect(cache.set).not.toHaveBeenCalled();
	});

	it("opts out when a prefetched request snapshot is stale despite a fresh global snapshot", async () => {
		const cache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		await renderPipeline(db, cache);
		await waitForDeferredTasks();

		await runWithContext({ editMode: false, db }, async () => {
			await prefetchLayoutData();
			await new OptionsRepository(db).set("site:seo", { googleVerification: "new" });
			invalidateSiteSettingsSnapshot();
			const freshSettings = await runWithContext({ editMode: false, db }, () => getSiteSettings());
			expect(freshSettings.seo?.googleVerification).toBe("new");
			const context = buildContext(cache, db) as unknown as MiddlewareContext;
			const response = await redirectMiddleware(context, () =>
				requestContextMiddleware(context, async () => {
					const settings = await getSiteSettings();
					await getMenu("primary");
					return new Response(settings.seo?.googleVerification ?? "missing");
				}),
			);
			expect(await response.text()).toBe("old");
		});

		expect(cache.set).toHaveBeenCalledWith(false);
	});

	it("bypasses a stale object-cache snapshot in a cold isolate", async () => {
		config.objectCacheEnabled = true;
		__setObjectCacheBackendForTests(createMemoryCache({}), {
			keyPrefix: `settings-route-${crypto.randomUUID()}`,
		});
		const warmCache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		await runWithContext({ editMode: false, db }, () => getSiteSettings());
		await (await renderPipeline(db, warmCache)).text();
		await waitForDeferredTasks();
		await new OptionsRepository(db).set("site:seo", { googleVerification: "new" });
		invalidateSiteSettingsSnapshot();

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		try {
			const response = await renderLazyPipeline(db, cache, gate);
			release();
			expect(await response.text()).toBe("new");
		} finally {
			release();
		}
	});

	it("uses live settings and menus when an object-cache fill has stale parent data", async () => {
		config.objectCacheEnabled = true;
		__setObjectCacheBackendForTests(createMemoryCache({}), {
			keyPrefix: `settings-route-${crypto.randomUUID()}`,
		});
		await runWithContext({ editMode: false, db }, async () => {
			await prefetchLayoutData();
			await new OptionsRepository(db).set("site:seo", { googleVerification: "new" });
			await db
				.updateTable("_emdash_menus")
				.set({ label: "New menu" })
				.where("id", "=", "primary")
				.execute();

			const cache = {
				enabled: true,
				options: { tags: ["emdash:settings"], maxAge: 3600 },
				set: vi.fn(),
			};
			const response = await runWithContext({ editMode: false, db }, () => {
				const context = buildContext(cache, db) as unknown as MiddlewareContext;
				return redirectMiddleware(context, () =>
					requestContextMiddleware(context, async () => {
						const settings = await getSiteSettings();
						const menu = await getMenu("primary");
						return new Response(`${settings.seo?.googleVerification}:${menu?.label}`);
					}),
				);
			});
			expect(await response.text()).toBe("new:New menu");
			expect(counts.selects).toBeGreaterThan(1);
		});
	});

	it("does not cache when a pending settings prefetch rejects", async () => {
		const cache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		let rejectGate!: (error: Error) => void;
		const pending = new Promise<never>((_, reject) => {
			rejectGate = reject;
		});
		let nextCalls = 0;
		let nextReached!: () => void;
		const nextStarted = new Promise<void>((resolve) => {
			nextReached = resolve;
		});
		await runWithContext({ editMode: false, db }, async () => {
			const context = buildContext(cache, db) as unknown as MiddlewareContext;
			const responsePromise = redirectMiddleware(context, () =>
				requestContextMiddleware(context, async () => {
					nextCalls++;
					void requestCached("siteSettingsSnapshot", () => pending).catch(() => undefined);
					nextReached();
					return new Response("no settings");
				}),
			);
			await nextStarted;
			await new Promise((resolve) => setTimeout(resolve, 0));
			rejectGate(new Error("prefetch failed"));
			const response = await responsePromise;
			expect(await response.text()).toBe("no settings");
		});
		expect(nextCalls).toBe(1);
		expect(cache.set).toHaveBeenCalledWith(false);
	});

	it("fences an unsafe legacy redirect destination after rendering", async () => {
		await db
			.insertInto("_emdash_redirects")
			.values({
				id: "unsafe-legacy",
				source: "/",
				destination: "https://evil.example/",
				type: 301,
				is_pattern: 0,
				enabled: 1,
				hits: 0,
				auto: 0,
			})
			.execute();
		await publishRedirectArtifacts(db);
		invalidateRedirectCache();
		await renderPipeline(db, {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		});
		await new OptionsRepository(db).set("site:seo", { googleVerification: "new" });
		resetCounts(counts);
		const cache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const response = await renderLazyPipeline(db, cache, gate);
			expect(cache.set).toHaveBeenCalledWith(false);
			expect(counts.selects).toBe(1);
			release();
			expect(await response.text()).toBe("new");
		} finally {
			release();
		}
	});

	it("does not cache a render when freshness verification fails", async () => {
		const warmCache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};
		expect(await (await renderPipeline(db, warmCache)).text()).toBe("old");
		await waitForDeferredTasks();

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await db.schema.dropTable("_emdash_redirect_state").execute();
		const failedCache = {
			enabled: true,
			options: { tags: ["emdash:settings"], maxAge: 3600 },
			set: vi.fn(),
		};

		expect(await (await renderPipeline(db, failedCache)).text()).toBe("old");
		expect(failedCache.set).toHaveBeenCalledWith(false);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
