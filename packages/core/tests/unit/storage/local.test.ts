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
