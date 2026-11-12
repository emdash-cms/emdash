import type { AstroIntegration } from "astro";
import { describe, expect, it, vi } from "vitest";

import { emdash } from "../../../../src/astro/integration/index.js";
import { RESOLVED_VIRTUAL_CONFIG_ID } from "../../../../src/astro/integration/virtual-modules.js";

function hook(integration: AstroIntegration, name: "astro:config:setup" | "astro:config:done") {
	const handler = integration.hooks[name];
	if (typeof handler !== "function") throw new Error(`Missing ${name} hook`);
	return handler;
}

async function sessionCookieNameFor(finalSession: unknown) {
	const integration = emdash({});
	const root = new URL("file:///tmp/emdash-session-cookie/");
	const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const updateConfig = vi.fn();
	const setupConfig = {
		root,
		srcDir: new URL("src/", root),
		security: {},
		trailingSlash: "ignore",
		integrations: [{ name: "@astrojs/react", hooks: {} }],
		// Later integrations may change session.cookie before config is finalized.
		session: { cookie: "setup-cookie" },
	};

	await hook(
		integration,
		"astro:config:setup",
	)({
		command: "dev",
		config: setupConfig,
		logger,
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig,
	} as never);

	const finalConfig = { ...setupConfig, session: finalSession };
	await hook(integration, "astro:config:done")({ config: finalConfig, logger } as never);

	const plugins = updateConfig.mock.calls.flatMap(([update]) => update?.vite?.plugins ?? []);
	const virtualModules = plugins.find(
		(plugin: { name?: string }) => plugin?.name === "emdash-virtual-modules",
	) as { load: (id: string) => string } | undefined;
	if (!virtualModules) throw new Error("Missing EmDash virtual modules plugin");

	const source = virtualModules.load(RESOLVED_VIRTUAL_CONFIG_ID);
	return JSON.parse(source.replace(/^export default /, "").replace(/;$/, "")).sessionCookieName;
}

describe("session cookie in the config virtual module", () => {
	it.each([
		["a string cookie name", { cookie: "custom" }, "custom"],
		["an object cookie name", { cookie: { name: "custom" } }, "custom"],
		["the default cookie", undefined, "astro-session"],
		["an object without a name", { cookie: {} }, "astro-session"],
		["disabled sessions", false, "astro-session"],
	])("uses %s from the final Astro config", async (_description, session, expected) => {
		expect(await sessionCookieNameFor(session)).toBe(expected);
	});
});
