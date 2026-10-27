import type { AstroIntegration } from "astro";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emdash } from "../../../../src/astro/integration/index.js";

function configSetup(integration: AstroIntegration) {
	const handler = integration.hooks["astro:config:setup"];
	if (typeof handler !== "function") throw new Error("Missing astro:config:setup hook");
	return handler;
}

async function build() {
	const root = new URL("file:///tmp/emdash-registry-localhost/");
	await configSetup(emdash({ registry: "http://127.0.0.1:4445" }))({
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
		updateConfig: vi.fn(),
	} as never);
}

describe("localhost registry during astro build", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("accepts a localhost aggregator in a --devOutput build", async () => {
		vi.stubEnv("NODE_ENV", "development");
		await expect(build()).resolves.toBeUndefined();
	});

	it("rejects a localhost aggregator in a production build", async () => {
		vi.stubEnv("NODE_ENV", "production");
		await expect(build()).rejects.toThrow("must use HTTPS outside development");
	});
});
