import { expect, test } from "../fixtures";

test.describe("Injected API routes", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("serves OpenAPI, relation, and reference endpoints from generated sites", async ({
		page,
	}) => {
		const openApiResponse = await page.request.get("/_emdash/api/openapi.json");
		expect(openApiResponse.status()).toBe(200);
		await expect(openApiResponse.json()).resolves.toMatchObject({ openapi: "3.1.0" });

		const relationsResponse = await page.request.get("/_emdash/api/relations");
		expect(relationsResponse.status()).toBe(200);
		await expect(relationsResponse.json()).resolves.toMatchObject({ success: true });

		for (const path of [
			"/_emdash/api/relations/missing",
			"/_emdash/api/relations/missing/translations",
			"/_emdash/api/content/posts/missing/references/missing/children",
			"/_emdash/api/content/posts/missing/references/missing/parents",
		]) {
			const response = await page.request.get(path);
			expect(response.status(), path).toBe(404);
			await expect(response.json(), path).resolves.toMatchObject({
				success: false,
				error: { code: "NOT_FOUND" },
			});
		}
	});
});
