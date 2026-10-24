import { expect, test } from "@playwright/test";

for (const style of ["line", "bar"] as const) {
	test(`timeseries ${style} renders without console errors`, async ({ page }) => {
		const errors: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
		page.on("pageerror", (error) => errors.push(error.message));

		const blocks = [
			{
				type: "chart",
				config: {
					chart_type: "timeseries",
					style,
					series: [
						{
							name: "Views",
							data: [
								[1700000000000, 3],
								[1700003600000, 4],
							],
						},
					],
				},
			},
		];
		const hash = Buffer.from(encodeURIComponent(JSON.stringify(blocks))).toString("base64");
		await page.goto(`/#${hash}`);

		const canvas = page.locator("canvas");
		await expect(canvas).toBeVisible();
		// Wait for ECharts' lazy option update to paint, not just create the canvas.
		await expect
			.poll(() =>
				canvas.evaluate((element) => {
					const context = element.getContext("2d");
					const pixels = context?.getImageData(0, 0, element.width, element.height).data;
					return pixels?.some((value, index) => index % 4 === 3 && value > 0) ?? false;
				}),
			)
			.toBe(true);
		expect(errors).toEqual([]);
	});
}
