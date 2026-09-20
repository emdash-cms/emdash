import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBackingServiceHandler } from "../src/sandbox/backing-service.js";
import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

describe("backing service handler cache", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (!server) return;
		const closed = once(server, "close");
		server.close();
		await closed;
	});

	it("drops versioned bridge handlers when a plugin is removed", async () => {
		const runner = {
			validateToken: () => ({
				pluginId: "example-plugin",
				version: "1.0.0",
				capabilities: ["network:request"],
				allowedHosts: ["example.com"],
				storageCollections: [],
			}),
			getPluginStorageConfig: () => ({}),
			getPluginSettingsSchema: () => ({}),
			getSiteInfo: () => undefined,
			db: {},
			emailSend: null,
			httpFetch: async () => new Response("first"),
			mediaStorage: null,
		};
		const backing = createBackingServiceHandler(runner as unknown as WorkerdSandboxRunner);
		server = createServer(backing.handler);
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");

		const invoke = async () => {
			const response = await fetch(`http://127.0.0.1:${address.port}/http/fetch`, {
				method: "POST",
				headers: {
					Authorization: "Bearer test-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ url: "https://example.com/data" }),
			});
			const payload = (await response.json()) as {
				result: { body: { __emdashBytes: string } };
				error?: string;
			};
			expect(response.status, payload.error).toBe(200);
			return Buffer.from(payload.result.body.__emdashBytes, "base64").toString();
		};

		await expect(invoke()).resolves.toBe("first");
		backing.removePlugin("example-plugin", "1.0.0");
		runner.httpFetch = async () => new Response("second");
		await expect(invoke()).resolves.toBe("second");
	});

	it("evicts the manifest version when production unloads a plugin", async () => {
		const runner = new WorkerdSandboxRunner({ db: {} as never });
		const removePlugin = vi.fn();
		Reflect.set(runner, "backingService", { removePlugin });
		try {
			const plugin = await runner.load(
				{
					id: "example-plugin",
					version: "1.0.0",
					capabilities: [],
					allowedHosts: [],
					storage: {},
				},
				"export default {};",
			);

			await plugin.terminate();
			expect(removePlugin).toHaveBeenCalledWith("example-plugin", "1.0.0");
		} finally {
			await runner.terminateAll();
		}
	});
});
