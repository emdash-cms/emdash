import type { AstroIntegration } from "astro";
import { memoryCache } from "astro/config";
import { describe, expect, it, vi } from "vitest";

import { emdash } from "../../../../src/astro/integration/index.js";
import { RESOLVED_VIRTUAL_CONFIG_ID } from "../../../../src/astro/integration/virtual-modules.js";

function hook(integration: AstroIntegration, name: "astro:config:setup" | "astro:config:done") {
	const handler = integration.hooks[name];
	if (typeof handler !== "function") throw new Error(`Missing ${name} hook`);
	return handler;
}

async function routeCacheProviderFor(cacheConfig: Record<string, unknown>) {
	const integration = emdash({});
	const root = new URL("file:///tmp/emdash-route-cache-provider/");
	const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const updateConfig = vi.fn();
	const setupConfig = {
		root,
		srcDir: new URL("src/", root),
		security: {},
		trailingSlash: "ignore",
		integrations: [{ name: "@astrojs/react", hooks: {} }],
	};

	await hook(
		integration,
		"astro:config:setup",
	)({
		command: "build",
		config: setupConfig,
		logger,
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);

	// A later integration can still set the provider before the config is final.
	const finalConfig = { ...setupConfig, ...cacheConfig };
	await hook(integration, "astro:config:done")({ config: finalConfig, logger } as never);

	const plugins = updateConfig.mock.calls.flatMap(([update]) => update?.vite?.plugins ?? []);
	const virtualModules = plugins.find(
		(plugin: { name?: string }) => plugin?.name === "emdash-virtual-modules",
	) as { load: (id: string) => string } | undefined;
	if (!virtualModules) throw new Error("Missing EmDash virtual modules plugin");

	const source = virtualModules.load(RESOLVED_VIRTUAL_CONFIG_ID);
	return JSON.parse(source.replace(/^export default /, "").replace(/;$/, "")).routeCacheProvider;
}

describe("route cache provider in the config virtual module", () => {
	it("names memoryCache() from the final Astro config", async () => {
		expect(await routeCacheProviderFor({ cache: { provider: memoryCache() } })).toBe("memory");
	});

	it("names memoryCache() from Astro 6 experimental.cache", async () => {
		expect(
			await routeCacheProviderFor({ experimental: { cache: { provider: memoryCache() } } }),
		).toBe("memory");
	});

	it("is absent without a cache provider", async () => {
		expect(await routeCacheProviderFor({})).toBeUndefined();
	});
});
