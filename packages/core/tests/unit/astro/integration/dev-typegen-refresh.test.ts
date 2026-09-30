import { fileURLToPath } from "node:url";

import { createServer, isRunnableDevEnvironment, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as DevTypegen from "../../../../src/astro/dev-typegen.js";
import { DEV_TYPEGEN_REFRESH_GLOBAL } from "../../../../src/astro/dev-typegen.js";
import { listenForDevTypegenRefresh } from "../../../../src/astro/integration/dev-typegen.js";

const DEV_TYPEGEN_MODULE = fileURLToPath(
	new URL("../../../../src/astro/dev-typegen.ts", import.meta.url),
);

describe("dev typegen refresh signal", () => {
	let server: ViteDevServer | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
		Reflect.deleteProperty(globalThis, DEV_TYPEGEN_REFRESH_GLOBAL);
	});

	async function refreshFromSsrRunner(hmr: boolean): Promise<ReturnType<typeof vi.fn>> {
		server = await createServer({
			configFile: false,
			logLevel: "silent",
			appType: "custom",
			server: { middlewareMode: true, ws: false, hmr },
		});
		const refresh = vi.fn();
		listenForDevTypegenRefresh(server, refresh);

		const ssr = server.environments.ssr;
		if (!isRunnableDevEnvironment(ssr)) throw new Error("Expected a runnable SSR environment");
		const { refreshDevTypes } = await ssr.runner.import<typeof DevTypegen>(DEV_TYPEGEN_MODULE);

		refreshDevTypes();
		return refresh;
	}

	it("reaches the integration once from code evaluated by the SSR module runner", async () => {
		const refresh = await refreshFromSsrRunner(true);

		await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("reaches the integration when HMR is disabled", async () => {
		const refresh = await refreshFromSsrRunner(false);

		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
	});
});
