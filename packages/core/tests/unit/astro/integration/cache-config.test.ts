import { describe, expect, it, vi } from "vitest";

// `createViteConfig` resolves `@emdash-cms/admin/dist` via require.resolve, which
// fails in a fresh checkout where the admin package hasn't been built yet. Stub
// it: this test only cares about the experimental.cache injection in
// `updateConfig({...})`, not the vite config payload.
vi.mock("../../../../src/astro/integration/vite-config.js", () => ({
	createViteConfig: () => ({}),
}));

const { emdash } = await import("../../../../src/astro/integration/index.js");

/**
 * Regression tests for the experimental.cache provider auto-injection.
 *
 * Without this, hosts that haven't opted into `experimental.cache` get an
 * undefined `cache` parameter in the API route context, and any call to
 * `cache.enabled` / `cache.invalidate()` (publish, unpublish, schedule, etc.)
 * or `Astro.cache.set(cacheHint)` (templates) crashes with
 * `TypeError: Cannot read properties of undefined`.
 *
 * Tracked in:
 *   - https://github.com/emdash-cms/emdash/issues/962 (DX umbrella)
 *   - https://github.com/emdash-cms/emdash/issues/959 (Deploy-to-Cloudflare 500)
 *   - https://github.com/emdash-cms/emdash/issues/945 (Astro.cache.set undefined)
 */
describe("emdash integration: experimental.cache injection", () => {
	function runConfigSetup(hostConfig: Record<string, unknown>) {
		const integration = emdash({});
		const setup = integration.hooks["astro:config:setup"];
		if (!setup) throw new Error("astro:config:setup hook missing");

		const updates: Array<Record<string, unknown>> = [];
		void setup({
			injectRoute: vi.fn(),
			injectScript: vi.fn(),
			addMiddleware: vi.fn(),
			addClientDirective: vi.fn(),
			addDevToolbarApp: vi.fn(),
			addRenderer: vi.fn(),
			addWatchFile: vi.fn(),
			updateConfig: (cfg: Record<string, unknown>) => {
				updates.push(cfg);
				return cfg;
			},
			isRestart: false,
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				fork: vi.fn(),
			} as never,
			config: hostConfig as never,
			command: "build",
		} as never);

		return updates;
	}

	it("auto-injects a default cache provider when the host has not opted in", () => {
		const updates = runConfigSetup({});
		const cacheUpdate = updates.find((u) => "experimental" in u);
		expect(cacheUpdate, "expected an updateConfig call with experimental.cache").toBeDefined();
		const experimental = (cacheUpdate as { experimental: { cache: { provider: unknown } } })
			.experimental;
		expect(experimental.cache.provider).toBeDefined();
		expect(experimental.cache.provider).not.toBeNull();
	});

	it("preserves the host's existing cache provider when one is configured", () => {
		const hostProvider = { kind: "host-supplied" };
		const updates = runConfigSetup({ experimental: { cache: { provider: hostProvider } } });
		const cacheUpdate = updates.find((u) => "experimental" in u);
		const experimental = (cacheUpdate as { experimental: { cache: { provider: unknown } } })
			.experimental;
		expect(experimental.cache.provider).toBe(hostProvider);
	});
});
