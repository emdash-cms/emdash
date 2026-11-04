import { test, expect } from "../fixtures";

const ALIGNMENT_PATH = "/text-alignment";

const ALIGNED = ["center", "right", "justify"] as const;

test.describe("Portable Text block alignment", () => {
	for (const align of ALIGNED) {
		test(`renders a ${align}-aligned block as text-align: ${align}`, async ({ page }) => {
			await page.goto(ALIGNMENT_PATH);

			await expect(page.getByText(`${align} paragraph`, { exact: true })).toHaveCSS(
				"text-align",
				align,
			);
		});
	}

	test("leaves an unaligned block at the inherited alignment", async ({ page }) => {
		await page.goto(ALIGNMENT_PATH);

		await expect(page.getByText("default paragraph", { exact: true })).toHaveCSS(
			"text-align",
			"start",
		);
	});
});
