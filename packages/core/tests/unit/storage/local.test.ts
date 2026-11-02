import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalStorage } from "../../../src/storage/local.js";

describe("LocalStorage same-key upload", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("replaces the stored bytes without changing the key", async () => {
		directory = await mkdtemp(join(tmpdir(), "emdash-local-storage-"));
		const storage = new LocalStorage({ directory, baseUrl: "/media" });
		const key = "images/hero.png";

		await storage.upload({
			key,
			body: new Uint8Array([1, 2, 3]),
			contentType: "image/png",
		});
		await storage.upload({
			key,
			body: new Uint8Array([9, 8]),
			contentType: "image/png",
		});

		const stored = await storage.download(key);
		expect(new Uint8Array(await new Response(stored.body).arrayBuffer())).toEqual(
			new Uint8Array([9, 8]),
		);
	});
});

describe("LocalStorage ranged download", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	async function storeClip(): Promise<LocalStorage> {
		directory = await mkdtemp(join(tmpdir(), "emdash-local-storage-"));
		const storage = new LocalStorage({ directory, baseUrl: "/media" });
		await storage.upload({
			key: "clip.mp4",
			body: new TextEncoder().encode("0123456789"),
			contentType: "video/mp4",
		});
		return storage;
	}

	it("reads only the requested bytes and reports the whole file's size", async () => {
		const storage = await storeClip();

		const result = await storage.download("clip.mp4", { range: { offset: 2, length: 3 } });

		expect(result).toMatchObject({ size: 10, range: { offset: 2, length: 3 } });
		expect(await new Response(result.body).text()).toBe("234");
	});

	it("returns the whole file for a range past its end", async () => {
		const storage = await storeClip();

		const result = await storage.download("clip.mp4", { range: { offset: 10 } });

		expect(result.range).toBeUndefined();
		expect(result.size).toBe(10);
		expect(await new Response(result.body).text()).toBe("0123456789");
	});
});
