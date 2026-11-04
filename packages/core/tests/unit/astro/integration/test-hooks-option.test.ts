import type { AstroIntegration } from "astro";
import { describe, expect, it, vi } from "vitest";

import type { EmDashConfig } from "../../../../src/astro/integration/index.js";
import { emdash } from "../../../../src/astro/integration/index.js";

function configSetup(integration: AstroIntegration) {
	const handler = integration.hooks["astro:config:setup"];
	if (typeof handler !== "function") throw new Error("Missing astro:config:setup hook");
	return handler;
}

async function build(config: EmDashConfig) {
	const root = new URL("file:///tmp/emdash-test-hooks/");
	const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
	await configSetup(emdash(config))({
		command: "build",
		config: {
			root,
			srcDir: new URL("src/", root),
			security: {},
			trailingSlash: "ignore",
			integrations: [{ name: "@astrojs/react", hooks: {} }],
		},
		logger,
		injectRoute: vi.fn(),
		addMiddleware: vi.fn(),
		updateConfig: vi.fn(),
	} as never);
	return logger.warn.mock.calls.map(([message]) => String(message));
}

describe("dangerouslyEnableTestHooks", () => {
	it("rejects a localhost registry in a production build without it", async () => {
		await expect(build({ registry: "http://127.0.0.1:4445" })).rejects.toThrow(
			"must use HTTPS outside development",
		);
	});

	it("accepts a localhost registry in a production build and warns", async () => {
		const warnings = await build({
			registry: "http://127.0.0.1:4445",
			dangerouslyEnableTestHooks: true,
		});
		expect(warnings).toContainEqual(expect.stringContaining("never deploy it"));
	});
});
