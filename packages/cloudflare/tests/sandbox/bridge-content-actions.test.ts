import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import type { ContentActionCallbacks } from "emdash";

import {
	beginContentActionCallbacks,
	flushContentActionCallbacks,
	PluginBridge,
	setContentActionsCallback,
} from "../../src/sandbox/bridge.js";

function bridge(runtimeId: string): PluginBridge {
	return new PluginBridge(
		{
			props: {
				pluginId: "publisher",
				pluginVersion: "1.0.0",
				capabilities: ["content:publish"],
				allowedHosts: [],
				storageCollections: [],
				contentActionsRuntimeId: runtimeId,
			},
		} as never,
		{ DB: {} } as never,
	);
}

describe("Cloudflare content action callback isolation", () => {
	afterEach(() => {
		setContentActionsCallback("runtime-a", null);
		setContentActionsCallback("runtime-b", null);
	});

	it("keeps bridge actions and invocation settlement bound to their runtime", async () => {
		const callbacksA = {
			begin: vi.fn(),
			flush: vi.fn().mockResolvedValue(undefined),
			getVersioned: vi.fn().mockResolvedValue({ item: { id: "from-a" }, _rev: "rev-a" }),
		} as unknown as ContentActionCallbacks;
		const callbacksB = {
			begin: vi.fn(),
			flush: vi.fn().mockResolvedValue(undefined),
			getVersioned: vi.fn().mockResolvedValue({ item: { id: "from-b" }, _rev: "rev-b" }),
		} as unknown as ContentActionCallbacks;
		setContentActionsCallback("runtime-a", callbacksA);
		setContentActionsCallback("runtime-b", callbacksB);

		await expect(bridge("runtime-a").contentGetVersioned("posts", "post-1")).resolves.toEqual({
			item: { id: "from-a" },
			_rev: "rev-a",
		});
		beginContentActionCallbacks("runtime-a", "publisher", "invoke-a");
		await flushContentActionCallbacks("runtime-a", "publisher", "invoke-a", true);

		expect(callbacksA.getVersioned).toHaveBeenCalledOnce();
		expect(callbacksA.begin).toHaveBeenCalledWith("publisher", "invoke-a", undefined);
		expect(callbacksA.flush).toHaveBeenCalledWith("publisher", "invoke-a", true);
		expect(callbacksB.getVersioned).not.toHaveBeenCalled();
		expect(callbacksB.begin).not.toHaveBeenCalled();
		expect(callbacksB.flush).not.toHaveBeenCalled();
	});
});

describe("Cloudflare bridge media delete", () => {
	afterEach(() => {
		setContentActionsCallback("runtime-a", null);
	});

	it.each([
		{ deleted: true, purges: true },
		{ deleted: false, purges: false },
	])(
		"purges the route cache only when R2 delete succeeds ($deleted)",
		async ({ deleted, purges }) => {
			const invalidateMedia = vi.fn().mockResolvedValue(undefined);
			setContentActionsCallback("runtime-a", {
				invalidateMedia,
			} as unknown as ContentActionCallbacks);
			const statement = (sql: string) => ({
				bind: () => ({
					first: async () => (sql.startsWith("SELECT") ? { storage_key: "photo.png" } : null),
					run: async () => ({ meta: { changes: 1 } }),
				}),
			});
			const bucket = {
				delete: deleted
					? vi.fn().mockResolvedValue(undefined)
					: vi.fn().mockRejectedValue(new Error("bucket unavailable")),
			};
			const plugin = new PluginBridge(
				{
					props: {
						pluginId: "publisher",
						pluginVersion: "1.0.0",
						capabilities: ["media:write"],
						allowedHosts: [],
						storageCollections: [],
						contentActionsRuntimeId: "runtime-a",
					},
				} as never,
				{ DB: { prepare: statement }, MEDIA: bucket } as never,
			);

			await expect(plugin.mediaDelete("m-1", "invoke-a")).resolves.toBe(true);

			expect(bucket.delete).toHaveBeenCalledWith("photo.png");
			if (purges) {
				expect(invalidateMedia).toHaveBeenCalledWith("publisher", "photo.png", "invoke-a");
			} else {
				expect(invalidateMedia).not.toHaveBeenCalled();
			}
		},
	);
});
