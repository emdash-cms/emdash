import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { R2Storage } from "../../src/storage/r2.js";

describe("R2Storage same-key upload", () => {
	it("replaces the object bytes without changing the key", async () => {
		const objects = new Map<string, Uint8Array>();
		const cacheControls: string[] = [];
		const bucket = {
			async put(key: string, body: Uint8Array, options: R2PutOptions) {
				objects.set(key, body);
				const metadata = options.httpMetadata;
				cacheControls.push(
					metadata instanceof Headers
						? (metadata.get("Cache-Control") ?? "")
						: (metadata?.cacheControl ?? ""),
				);
				return { size: body.byteLength };
			},
		} as unknown as R2Bucket;
		const storage = new R2Storage(bucket);

		await storage.upload({
			key: "hero.png",
			body: new Uint8Array([1, 2, 3]),
			contentType: "image/png",
			cacheControl: "public, max-age=0, must-revalidate",
		});
		await storage.upload({
			key: "hero.png",
			body: new Uint8Array([9, 8]),
			contentType: "image/png",
			cacheControl: "public, max-age=0, must-revalidate",
		});

		expect(objects.get("hero.png")).toEqual(new Uint8Array([9, 8]));
		expect(cacheControls).toEqual([
			"public, max-age=0, must-revalidate",
			"public, max-age=0, must-revalidate",
		]);
	});
});
