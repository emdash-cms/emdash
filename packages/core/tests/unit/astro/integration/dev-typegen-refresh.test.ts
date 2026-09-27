import { fileURLToPath } from "node:url";

import { createServer, isRunnableDevEnvironment, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DevTypegen from "../../../../src/astro/dev-typegen.js";
import { listenForDevTypegenRefresh } from "../../../../src/astro/integration/dev-typegen.js";

const DEV_TYPEGEN_MODULE = fileURLToPath(
	new URL("../../../../src/astro/dev-typegen.ts", import.meta.url),
);

describe("dev typegen refresh signal", () => {
	let server: ViteDevServer | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	it("reaches the integration from code evaluated by the SSR module runner", async () => {
		server = await createServer({
			configFile: false,
			logLevel: "silent",
			appType: "custom",
			server: { middlewareMode: true, ws: false },
		});
		const refresh = vi.fn();
		listenForDevTypegenRefresh(server, refresh);

		const ssr = server.environments.ssr;
		if (!isRunnableDevEnvironment(ssr)) throw new Error("Expected a runnable SSR environment");
		const { refreshDevTypes } = await ssr.runner.import<typeof DevTypegen>(DEV_TYPEGEN_MODULE);

		refreshDevTypes();

		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
	});
});
