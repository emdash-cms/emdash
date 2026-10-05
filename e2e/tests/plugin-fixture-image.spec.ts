import { expect, test } from "../fixtures/index.js";

test("serves a decodable marketplace fixture PNG @table-cross-engine", async ({
	page,
	request,
}) => {
	const response = await request.get("/_emdash/api/plugins/marketplace-test/fixture-image");
	expect(response.ok()).toBe(true);
	expect(response.headers()["content-type"]).toContain("image/png");

	const dimensions = await page.evaluate(
		async (bytes) => {
			const image = new Image();
			const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
			try {
				image.src = url;
				await image.decode();
				return { width: image.naturalWidth, height: image.naturalHeight };
			} finally {
				URL.revokeObjectURL(url);
			}
		},
		[...(await response.body())],
	);

	expect(dimensions.width).toBeGreaterThan(0);
	expect(dimensions.height).toBeGreaterThan(0);
});
