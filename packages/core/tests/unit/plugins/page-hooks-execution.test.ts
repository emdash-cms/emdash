/**
 * Page Hooks Execution Tests
 *
 * Tests that page:metadata and page:fragments hooks fire correctly through
 * the HookPipeline, returning plugin contributions that EmDashHead,
 * EmDashBodyStart, and EmDashBodyEnd render into HTML.
 *
 * Bug context: The middleware's anonymous fast-path skipped runtime init,
 * so collectPageMetadata/collectPageFragments were never available to
 * anonymous visitors. These tests verify the hook pipeline actually runs
 * plugin handlers and collects their contributions — the path that was
 * broken before the fix.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { HookPipeline } from "../../../src/plugins/hooks.js";
import type {
	ResolvedPlugin,
	ResolvedHook,
	PageMetadataHandler,
	PageFragmentHandler,
	PublicPageContext,
} from "../../../src/plugins/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [] },
		hooks: {},
		routes: {},
		...overrides,
	};
}

function createTestHook<T>(
	pluginId: string,
	handler: T,
	overrides: Partial<ResolvedHook<T>> = {},
): ResolvedHook<T> {
	return {
		pluginId,
		handler,
		priority: 100,
		timeout: 5000,
		dependencies: [],
		errorPolicy: "continue",
		exclusive: false,
		...overrides,
	};
}

function createPageContext(overrides: Partial<PublicPageContext> = {}): PublicPageContext {
	return {
		url: "https://example.com/blog/hello",
		path: "/blog/hello",
		locale: null,
		kind: "content",
		pageType: "post",
		title: "Hello World",
		description: null,
		canonical: null,
		image: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// DB setup (required for PluginContextFactory)
// ---------------------------------------------------------------------------

let db: Kysely<any>;
let sqlite: InstanceType<typeof Database>;

beforeEach(() => {
	sqlite = new Database(":memory:");
	db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
});

afterEach(async () => {
	await db.destroy();
	sqlite.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("page:metadata hook execution", () => {
	it("runs page:metadata handler and collects contributions", async () => {
		const metaHandler: PageMetadataHandler = vi.fn(async () => ({
			kind: "meta" as const,
			name: "x-page-hook-test",
			content: "present",
		}));

		const plugin = createTestPlugin({
			id: "test-meta",
			hooks: {
				"page:metadata": createTestHook("test-meta", metaHandler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		const page = createPageContext();

		const results = await pipeline.runPageMetadata({ page });

		expect(results).toHaveLength(1);
		expect(results[0]!.pluginId).toBe("test-meta");
		expect(results[0]!.contributions).toEqual([
			{ kind: "meta", name: "x-page-hook-test", content: "present" },
		]);
		expect(metaHandler).toHaveBeenCalledOnce();
	});

	it("collects contributions from multiple plugins", async () => {
		const handler1: PageMetadataHandler = vi.fn(async () => ({
			kind: "meta" as const,
			name: "plugin-1",
			content: "first",
		}));

		const handler2: PageMetadataHandler = vi.fn(async () => [
			{ kind: "meta" as const, name: "plugin-2a", content: "second-a" },
			{ kind: "link" as const, rel: "alternate" as const, href: "/fr/blog/hello", hreflang: "fr" },
		]);

		const plugin1 = createTestPlugin({
			id: "plugin-1",
			hooks: {
				"page:metadata": createTestHook("plugin-1", handler1, { priority: 1 }),
			},
		});

		const plugin2 = createTestPlugin({
			id: "plugin-2",
			hooks: {
				"page:metadata": createTestHook("plugin-2", handler2, { priority: 2 }),
			},
		});

		const pipeline = new HookPipeline([plugin1, plugin2], { db });
		const page = createPageContext();

		const results = await pipeline.runPageMetadata({ page });

		expect(results).toHaveLength(2);
		expect(results[0]!.pluginId).toBe("plugin-1");
		expect(results[1]!.pluginId).toBe("plugin-2");
		expect(results[1]!.contributions).toHaveLength(2);
	});

	it("passes page context to the handler", async () => {
		const metaHandler: PageMetadataHandler = vi.fn(async () => null);

		const plugin = createTestPlugin({
			id: "ctx-test",
			hooks: {
				"page:metadata": createTestHook("ctx-test", metaHandler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		const page = createPageContext({ title: "Test Page", path: "/test" });

		await pipeline.runPageMetadata({ page });

		expect(metaHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				page: expect.objectContaining({ title: "Test Page", path: "/test" }),
			}),
			expect.anything(),
		);
	});

	it("handles null return from handler (no contributions)", async () => {
		const metaHandler: PageMetadataHandler = vi.fn(async () => null);

		const plugin = createTestPlugin({
			id: "null-return",
			hooks: {
				"page:metadata": createTestHook("null-return", metaHandler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		const page = createPageContext();

		const results = await pipeline.runPageMetadata({ page });

		expect(results).toHaveLength(0);
	});

	it("isolates errors from individual plugin handlers", async () => {
		const badHandler: PageMetadataHandler = vi.fn(async () => {
			throw new Error("Plugin crashed");
		});

		const goodHandler: PageMetadataHandler = vi.fn(async () => ({
			kind: "meta" as const,
			name: "still-works",
			content: "yes",
		}));

		const badPlugin = createTestPlugin({
			id: "bad-plugin",
			hooks: {
				"page:metadata": createTestHook("bad-plugin", badHandler, { priority: 1 }),
			},
		});

		const goodPlugin = createTestPlugin({
			id: "good-plugin",
			hooks: {
				"page:metadata": createTestHook("good-plugin", goodHandler, { priority: 2 }),
			},
		});

		const pipeline = new HookPipeline([badPlugin, goodPlugin], { db });
		const page = createPageContext();

		// Should not throw — errors are logged, not propagated
		const results = await pipeline.runPageMetadata({ page });

		expect(results).toHaveLength(1);
		expect(results[0]!.pluginId).toBe("good-plugin");
	});
});

describe("page:fragments hook execution", () => {
	it("runs page:fragments handler and collects contributions", async () => {
		const fragmentHandler: PageFragmentHandler = vi.fn(async () => ({
			kind: "html" as const,
			placement: "head" as const,
			html: '<link rel="webmention" href="https://example.com/webmention">',
		}));

		const plugin = createTestPlugin({
			id: "test-fragment",
			capabilities: ["hooks.page-fragments:register"],
			hooks: {
				"page:fragments": createTestHook("test-fragment", fragmentHandler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		const page = createPageContext();

		const results = await pipeline.runPageFragments({ page });

		expect(results).toHaveLength(1);
		expect(results[0]!.pluginId).toBe("test-fragment");
		expect(results[0]!.contributions).toEqual([
			{
				kind: "html",
				placement: "head",
				html: '<link rel="webmention" href="https://example.com/webmention">',
			},
		]);
	});

	it("requires hooks.page-fragments:register capability for page:fragments", () => {
		const handler: PageFragmentHandler = vi.fn(async () => null);

		const pluginWithoutCap = createTestPlugin({
			id: "no-cap",
			capabilities: [],
			hooks: {
				"page:fragments": createTestHook("no-cap", handler),
			},
		});

		const pipeline = new HookPipeline([pluginWithoutCap], { db });

		expect(pipeline.hasHooks("page:fragments")).toBe(false);
	});

	it("collects external script contributions", async () => {
		const fragmentHandler: PageFragmentHandler = vi.fn(async () => ({
			kind: "external-script" as const,
			placement: "body:end" as const,
			src: "https://cdn.example.com/analytics.js",
			async: true,
		}));

		const plugin = createTestPlugin({
			id: "analytics",
			capabilities: ["hooks.page-fragments:register"],
			hooks: {
				"page:fragments": createTestHook("analytics", fragmentHandler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		const page = createPageContext();

		const results = await pipeline.runPageFragments({ page });

		expect(results).toHaveLength(1);
		expect(results[0]!.contributions[0]).toEqual({
			kind: "external-script",
			placement: "body:end",
			src: "https://cdn.example.com/analytics.js",
			async: true,
		});
	});
});
