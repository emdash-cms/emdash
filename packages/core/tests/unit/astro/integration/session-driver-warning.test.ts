import type { AstroIntegration } from "astro";
import { describe, expect, it, vi } from "vitest";

import type { EmDashConfig } from "../../../../src/astro/integration/index.js";
import { emdash } from "../../../../src/astro/integration/index.js";

function hook(integration: AstroIntegration, name: "astro:config:setup" | "astro:config:done") {
	const handler = integration.hooks[name];
	if (typeof handler !== "function") throw new Error(`Missing ${name} hook`);
	return handler;
}

async function warningsFor(session: unknown, config: EmDashConfig = {}) {
	const integration = emdash(config);
	const root = new URL("file:///tmp/emdash-session-warning/");
	const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const astroConfig = {
		root,
		srcDir: new URL("src/", root),
		security: {},
		trailingSlash: "ignore",
		integrations: [{ name: "@astrojs/react", hooks: {} }],
		session,
	};
	await hook(
		integration,
		"astro:config:setup",
	)({
		command: "dev",
		config: astroConfig,
		logger,
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig: vi.fn(),
	} as never);
	await hook(integration, "astro:config:done")({ config: astroConfig, logger } as never);
	return logger.warn.mock.calls.map(([message]) => String(message));
}

describe("session driver warning", () => {
	it("stays quiet when a session driver is configured", async () => {
		const warnings = await warningsFor({ driver: { entrypoint: "unstorage/drivers/redis" } });
		expect(warnings.filter((w) => w.includes("session"))).toEqual([]);
	});

	it("warns with a fix when no session driver is configured", async () => {
		const warnings = await warningsFor(undefined);
		expect(warnings).toContainEqual(expect.stringContaining("No Astro session driver"));
		expect(warnings).toContainEqual(expect.stringContaining("sessionDrivers.redis"));
	});

	it("names disabled sessions when session is false", async () => {
		const warnings = await warningsFor(false);
		expect(warnings).toContainEqual(expect.stringContaining("session: false"));
	});

	it("stays quiet with external auth, which does not use the session", async () => {
		const warnings = await warningsFor(undefined, {
			auth: { entrypoint: "@emdash-cms/cloudflare/auth", config: {} },
		} as EmDashConfig);
		expect(warnings.filter((w) => w.includes("session"))).toEqual([]);
	});
});
