import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { R2Storage } from "../../../cloudflare/src/storage/r2.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		MEDIA: R2Bucket;
	}
}

describe("R2Storage ranged download", () => {
	const storage = new R2Storage(env.MEDIA);

	beforeEach(async () => {
		await env.MEDIA.put("clip.mp4", "0123456789", { httpMetadata: { contentType: "video/mp4" } });
	});

	it.each([
		[{ offset: 2, length: 3 }, { offset: 2, length: 3 }, "234"],
		[{ offset: 7 }, { offset: 7, length: 3 }, "789"],
		[{ suffix: 3 }, { offset: 7, length: 3 }, "789"],
		[{ offset: 8, length: 100 }, { offset: 8, length: 2 }, "89"],
	])("reads %o and reports the whole object's size", async (range, served, body) => {
		const result = await storage.download("clip.mp4", { range });

		expect(result).toMatchObject({ contentType: "video/mp4", size: 10, range: served });
		expect(await new Response(result.body).text()).toBe(body);
	});

	it.each([{ offset: 10 }, { offset: 10, length: 5 }])(
		"returns the whole object when %o starts past its end",
		async (range) => {
			const result = await storage.download("clip.mp4", { range });

			expect(result.range).toBeUndefined();
			expect(result.size).toBe(10);
			expect(await new Response(result.body).text()).toBe("0123456789");
		},
	);

	it("reports no range for a plain download", async () => {
		const result = await storage.download("clip.mp4");

		expect(result.range).toBeUndefined();
		expect(await new Response(result.body).text()).toBe("0123456789");
	});

	it("reports a missing object as not found", async () => {
		await expect(storage.download("missing.mp4", { range: { offset: 0 } })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});
