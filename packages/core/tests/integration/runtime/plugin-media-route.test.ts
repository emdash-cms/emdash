/**
 * Trusted plugin API routes must receive a writable `ctx.media`.
 *
 * Regression: `EmDashRuntime.handlePluginApiRoute` built a `PluginRouteRegistry`
 * without threading `storage`, so a `media:write` plugin invoked via
 * `/_emdash/api/plugin/{id}/{route}` got a read-only (or undefined) `ctx.media`
 * and `ctx.media.upload()` was unusable — the exact trigger in the bug report.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { Storage } from "../../../src/storage/types.js";

/** Minimal in-memory Storage backend that records uploaded keys. */
function createFakeStorage() {
	const uploads = new Map<string, Uint8Array>();
	const storage: Storage = {
		async upload(options) {
			const body =
				options.body instanceof Uint8Array
					? options.body
					: new Uint8Array(options.body as ArrayBuffer);
			uploads.set(options.key, body);
			return { key: options.key, size: body.byteLength };
		},
		async download() {
			throw new Error("not implemented");
		},
		async delete(key) {
			uploads.delete(key);
		},
		async exists(key) {
			return uploads.has(key);
		},
		async list() {
			return { items: [] };
		},
		async getSignedUploadUrl(options) {
			return {
				url: `https://signed.example.com/${options.key}`,
				method: "PUT",
				headers: {},
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			};
		},
		getPublicUrl(key) {
			return `/media/${key}`;
		},
	};
	return { storage, uploads };
}

function createDeps(storage: Storage): RuntimeDependencies {
	const entrypoint = `test-plugin-media-route-${randomUUID()}`;
	return {
		config: {
			database: { entrypoint, config: {}, type: "sqlite" },
			storage: { entrypoint, config: {} },
		},
		plugins: [
			definePlugin({
				id: "media-uploader",
				version: "1.0.0",
				capabilities: ["media:write"],
				routes: {
					upload: {
						handler: async (ctx) => {
							const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
							return ctx.media!.upload!("from-route.png", "image/png", bytes);
						},
					},
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: () => storage,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

describe("EmDashRuntime.handlePluginApiRoute — media:write", () => {
	it("provides a writable ctx.media so a trusted plugin route can upload", async () => {
		const { storage, uploads } = createFakeStorage();
		const runtime = await EmDashRuntime.create(createDeps(storage));

		try {
			const result = await runtime.handlePluginApiRoute(
				"media-uploader",
				"POST",
				"/upload",
				new Request("http://test.local/_emdash/api/plugin/media-uploader/upload", {
					method: "POST",
				}),
			);

			expect(result.success).toBe(true);
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrowing the route result for the assertion
			const data = result.data as { mediaId: string; storageKey: string };
			expect(data.mediaId).toBeTruthy();
			expect(data.storageKey).toMatch(/\.png$/);
			expect(uploads.has(data.storageKey)).toBe(true);
		} finally {
			await runtime.stopCron();
		}
	});
});
