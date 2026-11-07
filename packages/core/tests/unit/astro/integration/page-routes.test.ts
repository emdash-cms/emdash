import type { AstroIntegration } from "astro";
import { describe, expect, it, vi } from "vitest";

const { runtimeRoutes } = vi.hoisted(() => ({
	runtimeRoutes: [] as Array<{ source: string; flags: string }>,
}));
vi.mock("virtual:emdash/page-routes", () => ({ pageRoutes: runtimeRoutes }));

import { emdash } from "../../../../src/astro/integration/index.js";
import { RESOLVED_VIRTUAL_PAGE_ROUTES_ID } from "../../../../src/astro/integration/virtual-modules.js";
import { findPageRouteSources } from "../../../../src/import/wxr-permalink-routes.js";
import { importWxrPermalinks } from "../../../../src/import/wxr-permalinks.js";
import { setupTestDatabase } from "../../../utils/test-db.js";

async function setupIntegration() {
	const integration = emdash();
	const setup = integration.hooks["astro:config:setup"] as NonNullable<
		AstroIntegration["hooks"]["astro:config:setup"]
	>;
	const updateConfig = vi.fn();
	const root = new URL("file:///tmp/emdash-page-routes/");

	await setup({
		command: "build",
		config: {
			root,
			srcDir: new URL("src/", root),
			security: {},
			trailingSlash: "ignore",
			integrations: [{ name: "@astrojs/react", hooks: {} }],
		},
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);

	const plugin = updateConfig.mock.calls
		.flatMap(([update]) => update?.vite?.plugins ?? [])
		.find((candidate: { name?: string }) => candidate.name === "emdash-virtual-modules") as {
		resolveId: (id: string) => string | undefined;
		load: (id: string) => string | undefined;
		configureServer: (server: {
			moduleGraph: ModuleGraph;
			environments?: Record<string, { moduleGraph: ModuleGraph }>;
		}) => void;
	};

	return {
		integration,
		plugin,
		routesHook: integration.hooks["astro:routes:resolved"] as NonNullable<
			AstroIntegration["hooks"]["astro:routes:resolved"]
		>,
	};
}

type ModuleGraph = {
	getModuleById: (id: string) => object | undefined;
	invalidateModule: (module: object) => void;
};

function emittedRoutes(source: string) {
	const prefix = "export const pageRoutes = ";
	return JSON.parse(source.slice(prefix.length, -1)) as Array<{
		source: string;
		flags: string;
	}>;
}

describe("page route metadata virtual module", () => {
	it("publishes resolved public route regexes after Astro's route hook", async () => {
		const { plugin, routesHook } = await setupIntegration();
		expect(plugin.resolveId("virtual:emdash/page-routes")).toBe(RESOLVED_VIRTUAL_PAGE_ROUTES_ID);

		const graphs = Object.fromEntries(
			["client", "ssr", "worker"].map((name) => {
				const routeModule = {};
				return [
					name,
					{
						getModuleById: vi.fn(() => routeModule),
						invalidateModule: vi.fn(),
					},
				];
			}),
		) as Record<string, ModuleGraph>;
		plugin.configureServer({
			moduleGraph: graphs.client,
			environments: Object.fromEntries(
				Object.entries(graphs).map(([name, moduleGraph]) => [name, { moduleGraph }]),
			),
		});

		await routesHook({
			routes: [
				{
					type: "page",
					origin: "project",
					patternRegex: /^\/contact$/,
					params: [],
				},
				{
					type: "page",
					origin: "external",
					patternRegex: /^\/docs\/(.*)$/i,
					params: ["...slug"],
				},
				{
					type: "page",
					origin: "project",
					patternRegex: /^\/(?<year>\d{4})\/(?<month>\d{2})\/(?<day>\d{2})\/(?<slug>[^/]+)$/,
					params: ["year", "month", "day", "slug"],
				},
				{
					type: "page",
					origin: "internal",
					patternRegex: /.*/,
					params: [],
				},
			] as never,
		} as never);

		for (const graph of Object.values(graphs)) {
			expect(graph.invalidateModule).toHaveBeenCalledWith(
				graph.getModuleById(RESOLVED_VIRTUAL_PAGE_ROUTES_ID),
			);
		}
		const source = plugin.load(RESOLVED_VIRTUAL_PAGE_ROUTES_ID)!;
		const pageRoutes = emittedRoutes(source);
		expect(pageRoutes).toEqual([{ source: "^\\/contact$", flags: "" }]);
		expect(
			findPageRouteSources(
				["/archive/contact/", "/archive/docs/intro", "/archive/unknown", "/contact"],
				pageRoutes,
				"/archive",
			),
		).toEqual(new Set(["/archive/contact"]));

		await routesHook({
			routes: [
				{
					type: "page",
					origin: "project",
					patternRegex: /^\/new-route$/,
					params: [],
				},
			] as never,
		} as never);
		for (const graph of Object.values(graphs)) {
			expect(graph.invalidateModule).toHaveBeenCalledTimes(2);
		}
		expect(emittedRoutes(plugin.load(RESOLVED_VIRTUAL_PAGE_ROUTES_ID)!)).toEqual([
			{ source: "^\\/new-route$", flags: "" },
		]);
	});

	it("does not report a dynamic route as served to permalink import", async () => {
		runtimeRoutes.length = 0;
		const { plugin, routesHook } = await setupIntegration();
		const routeModule = {};
		plugin.configureServer({
			moduleGraph: {
				getModuleById: vi.fn(() => routeModule),
				invalidateModule: vi.fn(),
			},
		});
		try {
			await routesHook({
				routes: [
					{
						type: "page",
						origin: "project",
						patternRegex: /^\/(?<year>\d{4})\/(?<month>\d{2})\/(?<day>\d{2})\/(?<slug>[^/]+)$/,
						params: ["year", "month", "day", "slug"],
					},
					{
						type: "page",
						origin: "project",
						patternRegex: /^\/about$/,
						params: [],
					},
				] as never,
			} as never);
			runtimeRoutes.push(...emittedRoutes(plugin.load(RESOLVED_VIRTUAL_PAGE_ROUTES_ID)!));

			const db = await setupTestDatabase();
			try {
				expect(
					await importWxrPermalinks(db, [
						{
							title: "Example post",
							link: "https://wp.test/2004/05/01/example-post/",
							collection: "posts",
							pattern: "/{year}/{month}/{day}/{slug}",
							item: {
								id: "example-post",
								slug: "example-post",
								status: "published",
								publishedAt: "2004-05-02T00:00:00.000Z",
								locale: "en",
							},
						},
					]),
				).toEqual([]);
				expect(
					await db.selectFrom("_emdash_redirects").select(["source", "destination"]).execute(),
				).toEqual([
					{ source: "/2004/05/01/example-post", destination: "/2004/05/02/example-post" },
				]);
			} finally {
				await db.destroy();
			}
		} finally {
			runtimeRoutes.length = 0;
		}
	});
});
