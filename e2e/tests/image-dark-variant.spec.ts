import { test, expect } from "../fixtures";

const PAGE_PATH = "/image-variants";

const lightImage = (scope: string) => `${scope} img[src$="light.png"]`;
const darkImage = (scope: string) => `${scope} img[src$="dark.png"]`;

const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

test.describe("Image dark variant", () => {
	test("shows the light image when the system prefers light and no class is set", async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "light" });
		await page.goto(PAGE_PATH);

		await expect(page.locator(lightImage("#with-variant"))).toBeVisible();
		await expect(page.locator(darkImage("#with-variant"))).toHaveCSS("display", "none");
	});

	test("shows the dark image when the system prefers dark and no class is set", async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto(PAGE_PATH);

		await expect(page.locator(darkImage("#with-variant"))).toBeVisible();
		await expect(page.locator(lightImage("#with-variant"))).toHaveCSS("display", "none");
	});

	test("a dark class on <html> shows the dark image even when the system prefers light", async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "light" });
		await page.goto(`${PAGE_PATH}?theme=dark`);

		await expect(page.locator(darkImage("#with-variant"))).toBeVisible();
		await expect(page.locator(lightImage("#with-variant"))).toHaveCSS("display", "none");
	});

	test("a light class on <html> shows the light image even when the system prefers dark", async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto(`${PAGE_PATH}?theme=light`);

		await expect(page.locator(lightImage("#with-variant"))).toBeVisible();
		await expect(page.locator(darkImage("#with-variant"))).toHaveCSS("display", "none");
	});

	test("an explicit darkVariant prop behaves like a stored variant", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto(PAGE_PATH);

		await expect(page.locator(darkImage("#explicit-variant"))).toBeVisible();
		await expect(page.locator(lightImage("#explicit-variant"))).toHaveCSS("display", "none");
	});

	test("the hidden variant is not downloaded while the visible one is", async ({ page }) => {
		const requested: string[] = [];
		await page.route("https://example.com/**", (route) => {
			requested.push(route.request().url());
			return route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG });
		});
		await page.emulateMedia({ colorScheme: "light" });
		await page.goto(PAGE_PATH);
		await page.waitForLoadState("networkidle");

		expect(requested.some((url) => url.endsWith("/light.png"))).toBe(true);
		expect(requested.some((url) => url.endsWith("/dark.png"))).toBe(false);
	});

	test("an image without a variant renders a single visible image in both schemes", async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto(PAGE_PATH);

		await expect(page.locator("#without-variant img")).toHaveCount(1);
		await expect(page.locator(lightImage("#without-variant"))).toBeVisible();
	});
});
