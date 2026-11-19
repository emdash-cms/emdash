import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";

import { test, expect } from "../fixtures";

function luminance(color: string) {
	const channels = color
		.match(/[\d.]+/g)!
		.slice(0, 3)
		.map((value) => {
			const channel = Number(value) / 255;
			return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
	return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

test("public code blocks have named keyboard-accessible scroll regions", async ({
	page,
	serverInfo,
}) => {
	const slug = `scrollable-code-${randomUUID()}`;
	const headers = {
		Authorization: `Bearer ${serverInfo.token}`,
		"X-EmDash-Request": "1",
		Origin: serverInfo.baseUrl,
	};
	const code =
		"curl https://example.com/install.sh --output install.sh && sh install.sh --configuration production";
	const response = await page.request.post("/_emdash/api/content/posts", {
		headers,
		data: {
			slug,
			data: {
				title: "Scrollable code",
				body: [
					{ _type: "code", _key: "filename", code, filename: "install.sh", language: "bash" },
					{ _type: "code", _key: "language", code, language: "bash" },
					{ _type: "code", _key: "plain", code },
				],
			},
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	const { data } = await response.json();
	const id = data.item?.id ?? data.id;
	try {
		const published = await page.request.post(`/_emdash/api/content/posts/${id}/publish`, {
			headers,
			data: {},
		});
		expect(published.ok()).toBe(true);

		await page.setViewportSize({ width: 320, height: 568 });
		await page.goto(`/posts/${slug}`);
		const blocks = page.locator(".emdash-code pre");
		await expect(blocks).toHaveCount(3);

		for (const [index, name] of ["install.sh", "Code: bash", "Code"].entries()) {
			const block = blocks.nth(index);
			expect(await block.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
				true,
			);
			await expect(block).toHaveRole("region");
			await expect(block).toHaveAccessibleName(name);
			await expect(block).toHaveAttribute("tabindex", "0");
		}

		await page.locator("body").click({ position: { x: 1, y: 1 } });
		await page.keyboard.press("Tab");
		await expect(blocks.nth(0)).toBeFocused();
		await expect(blocks.nth(0)).toHaveCSS("outline-style", "solid");
		await expect(blocks.nth(0)).toHaveCSS("outline-width", "2px");
		for (const background of ["#181818", "#f2f2f2"]) {
			await page.addStyleTag({
				content: `#body .emdash-code pre { background: ${background} !important; }`,
			});
			const colors = await blocks.nth(0).evaluate((element) => {
				const style = getComputedStyle(element);
				return { outline: style.outlineColor, background: style.backgroundColor };
			});
			const values = [luminance(colors.outline), luminance(colors.background)].toSorted(
				(a, b) => b - a,
			);
			expect((values[0]! + 0.05) / (values[1]! + 0.05)).toBeGreaterThanOrEqual(3);
		}
		await page.keyboard.press("ArrowRight");
		await expect
			.poll(() => blocks.nth(0).evaluate((element) => element.scrollLeft))
			.toBeGreaterThan(0);
		await page.keyboard.press("Tab");
		await expect(blocks.nth(1)).toBeFocused();

		const results = await new AxeBuilder({ page })
			.include(".emdash-code")
			.withRules(["scrollable-region-focusable", "aria-allowed-attr", "aria-prohibited-attr"])
			.analyze();
		expect(results.violations).toEqual([]);
	} finally {
		await page.request.delete(`/_emdash/api/content/posts/${id}`, { headers });
		await page.request.delete(`/_emdash/api/content/posts/${id}/permanent`, { headers });
	}
});
