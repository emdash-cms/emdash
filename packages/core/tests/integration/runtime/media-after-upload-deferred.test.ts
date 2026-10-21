/**
 * media:afterUpload hooks for multipart registration and MCP creation must be
 * deferred through `after()`.
 *
 * `handleMediaRegisterUpload` (REST multipart upload confirm/register) and
 * `handleMediaCreate` (MCP media_create) historically ran the hook as a bare
 * fire-and-forget promise. On Cloudflare Workers that promise is canceled once
 * the HTTP response is returned, so real I/O in the hook never completes.
 *
 * These tests pin the contract: both handlers schedule the hook work via
 * `after()` so the host's `waitUntil` can keep the invocation alive.
 */

import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

// Capture-only stub for `after()`: record the deferred task without running
// it, so a test can assert the work was scheduled (not abandoned) and then
// flush it deliberately. Mirrors how Workers holds the promise via waitUntil.
const { deferred } = vi.hoisted(() => ({ deferred: [] as Array<() => void | Promise<void>> }));
vi.mock("../../../src/after.js", () => ({
	after: (fn: () => void | Promise<void>) => {
		deferred.push(fn);
	},
}));

import { MediaRepository } from "../../../src/database/repositories/media.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { MediaAfterUploadHandler } from "../../../src/plugins/types.js";
import type { Storage } from "../../../src/storage/types.js";

const afterUploadHandler = vi.fn<MediaAfterUploadHandler>(async () => {});

/** Minimal in-memory Storage backend that records uploaded keys. */
function createFakeStorage(): Storage {
	const uploads = new Map<string, Uint8Array>();
	return {
		async upload(options) {
			const body =
				options.body instanceof Uint8Array
					? options.body
					: new Uint8Array(options.body as ArrayBuffer);
			uploads.set(options.key, body);
			return { key: options.key, url: `/media/${options.key}`, size: body.byteLength };
		},
		async download(key) {
			const bytes = uploads.get(key);
			if (!bytes) throw new Error("not implemented");
			return {
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
				contentType: "image/png",
				size: bytes.byteLength,
			};
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
}

function createDeps(storage: Storage): RuntimeDependencies {
	const entrypoint = `test-media-after-upload-${randomUUID()}`;
	return {
		config: {
			database: { entrypoint, config: {}, type: "sqlite" },
			storage: { entrypoint, config: {} },
		},
		plugins: [
			definePlugin({
				id: "media-watcher",
				version: "1.0.0",
				// media:afterUpload is a read-only notification, so media:read
				// is the required capability.
				capabilities: ["media:read"],
				hooks: {
					"media:afterUpload": { handler: afterUploadHandler },
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

/** Let any synchronous fire-and-forget microtasks settle. */
const drainMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Run everything the runtime handed to `after()`, like waitUntil would. */
async function flushDeferred(): Promise<void> {
	const tasks = deferred.splice(0);
	for (const task of tasks) await task();
}

describe("runtime defers media:afterUpload hooks through after()", () => {
	let runtime: EmDashRuntime;
	let mediaRepo: MediaRepository;

	beforeEach(async () => {
		deferred.length = 0;
		afterUploadHandler.mockClear();

		const storage = createFakeStorage();
		runtime = await EmDashRuntime.create(createDeps(storage));
		mediaRepo = new MediaRepository(runtime.db);

		// Drop any boot-time deferred work so each test observes only its own.
		deferred.length = 0;
	});

	afterEach(async () => {
		await runtime.stopCron();
	});

	it("schedules the media:afterUpload hook via after() on handleMediaCreate", async () => {
		const result = await runtime.handleMediaCreate({
			filename: "created.png",
			mimeType: "image/png",
			size: 4,
			storageKey: "created-key",
		});
		expect(result.success).toBe(true);

		// If the dispatch were fire-and-forget, the handler would have run by
		// now. Correct behavior defers it, so it has NOT run yet...
		await drainMicrotasks();
		expect(afterUploadHandler).not.toHaveBeenCalled();
		expect(deferred.length).toBeGreaterThan(0);

		// ...and running what was handed to after() (as waitUntil would) fires it.
		await flushDeferred();
		expect(afterUploadHandler).toHaveBeenCalledTimes(1);
	});

	it("schedules the media:afterUpload hook via after() on handleMediaRegisterUpload", async () => {
		const storageKey = "registered-key";
		const bytes = new Uint8Array([1, 2, 3, 4]);
		// Seed storage with the supposedly-uploaded bytes.
		await runtime.storage!.upload({ key: storageKey, body: bytes, contentType: "image/png" });

		const pending = await mediaRepo.createPending({
			filename: "registered.png",
			mimeType: "image/png",
			size: bytes.byteLength,
			storageKey,
		});
		await mediaRepo.createUploadAttempt(pending.id, storageKey);

		// Reset after boot-time deferred work; the handler call we observe must
		// come from handleMediaRegisterUpload.
		deferred.length = 0;
		afterUploadHandler.mockClear();

		const result = await runtime.handleMediaRegisterUpload({ storageKey });
		expect(result.success).toBe(true);

		await drainMicrotasks();
		expect(afterUploadHandler).not.toHaveBeenCalled();
		expect(deferred.length).toBeGreaterThan(0);

		await flushDeferred();
		expect(afterUploadHandler).toHaveBeenCalledTimes(1);
	});
});
