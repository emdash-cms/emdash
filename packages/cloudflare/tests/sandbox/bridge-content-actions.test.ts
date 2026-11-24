import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function sqliteD1(db: DatabaseSync) {
	return {
		prepare(sql: string) {
			return {
				bind(...params: Array<string | number | null>) {
					const statement = db.prepare(sql);
					return {
						first: async () => statement.get(...params) ?? null,
						run: async () => ({ meta: { changes: Number(statement.run(...params).changes) } }),
					};
				},
			};
		},
	};
}

function mediaBridge(db: DatabaseSync, bucket?: { delete: (key: string) => Promise<void> }) {
	return new PluginBridge(
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
		{ DB: sqliteD1(db), MEDIA: bucket } as never,
	);
}

describe("Cloudflare bridge media delete", () => {
	let db: DatabaseSync;

	beforeEach(() => {
		db = new DatabaseSync(":memory:");
		db.exec(
			"CREATE TABLE media (id TEXT PRIMARY KEY, storage_key TEXT NOT NULL, mime_type TEXT NOT NULL)",
		);
		db.prepare("INSERT INTO media (id, storage_key, mime_type) VALUES (?, ?, ?)").run(
			"m-1",
			"photo.png",
			"image/png",
		);
	});

	afterEach(() => {
		setContentActionsCallback("runtime-a", null);
		db.close();
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
			const bucket = {
				delete: deleted
					? vi.fn().mockResolvedValue(undefined)
					: vi.fn().mockRejectedValue(new Error("bucket unavailable")),
			};

			await expect(mediaBridge(db, bucket).mediaDelete("m-1", "invoke-a")).resolves.toBe(true);

			expect(db.prepare("SELECT id FROM media WHERE id = ?").get("m-1")).toBeUndefined();
			expect(bucket.delete).toHaveBeenCalledWith("photo.png");
			if (purges) {
				expect(invalidateMedia).toHaveBeenCalledWith("publisher", "photo.png", "invoke-a");
			} else {
				expect(invalidateMedia).not.toHaveBeenCalled();
			}
		},
	);

	it("deletes the row without purging when storage is unavailable", async () => {
		const invalidateMedia = vi.fn();
		setContentActionsCallback("runtime-a", {
			invalidateMedia,
		} as unknown as ContentActionCallbacks);
		await expect(mediaBridge(db).mediaDelete("m-1", "invoke-a")).resolves.toBe(true);
		expect(db.prepare("SELECT id FROM media").all()).toEqual([]);
		expect(invalidateMedia).not.toHaveBeenCalled();
	});

	it("deletes a document from R2 without purging the route cache", async () => {
		db.prepare("INSERT INTO media (id, storage_key, mime_type) VALUES (?, ?, ?)").run(
			"m-2",
			"report.pdf",
			"application/pdf",
		);
		const invalidateMedia = vi.fn().mockResolvedValue(undefined);
		setContentActionsCallback("runtime-a", {
			invalidateMedia,
		} as unknown as ContentActionCallbacks);
		const bucket = { delete: vi.fn().mockResolvedValue(undefined) };

		await expect(mediaBridge(db, bucket).mediaDelete("m-2", "invoke-a")).resolves.toBe(true);

		expect(bucket.delete).toHaveBeenCalledWith("report.pdf");
		expect(invalidateMedia).not.toHaveBeenCalled();
	});

	it("does not touch storage or the route cache for an unknown id", async () => {
		const invalidateMedia = vi.fn().mockResolvedValue(undefined);
		setContentActionsCallback("runtime-a", {
			invalidateMedia,
		} as unknown as ContentActionCallbacks);
		const bucket = { delete: vi.fn().mockResolvedValue(undefined) };

		await expect(mediaBridge(db, bucket).mediaDelete("missing", "invoke-a")).resolves.toBe(false);

		expect(bucket.delete).not.toHaveBeenCalled();
		expect(invalidateMedia).not.toHaveBeenCalled();
		expect(db.prepare("SELECT id FROM media WHERE id = ?").get("m-1")).toEqual({ id: "m-1" });
	});
});
