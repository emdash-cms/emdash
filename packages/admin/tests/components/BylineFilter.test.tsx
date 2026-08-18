import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BylineFilter, EMPTY_BYLINE_FILTER } from "../../src/components/BylineFilter.js";
import { fetchBylines, type BylineSummary } from "../../src/lib/api/index.js";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api/index.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/index.js")>(
		"../../src/lib/api/index.js",
	);
	return { ...actual, fetchBylines: vi.fn() };
});

const bylines: BylineSummary[] = [
	{
		id: "guest",
		slug: "guest-contributor",
		displayName: "Guest Contributor",
		bio: null,
		avatarMediaId: null,
		websiteUrl: null,
		userId: null,
		isGuest: true,
		createdAt: "2026-08-18T00:00:00Z",
		updatedAt: "2026-08-18T00:00:00Z",
		locale: "en",
		translationGroup: "guest-group",
	},
	{
		id: "editorial",
		slug: "emdash-editorial",
		displayName: "EmDash Editorial",
		bio: null,
		avatarMediaId: null,
		websiteUrl: null,
		userId: null,
		isGuest: false,
		createdAt: "2026-08-18T00:00:00Z",
		updatedAt: "2026-08-18T00:00:00Z",
		locale: "en",
		translationGroup: "editorial-group",
	},
];

describe("BylineFilter", () => {
	beforeEach(() => {
		vi.mocked(fetchBylines).mockResolvedValue({ items: bylines });
	});

	it("aligns controls and uses one content type treatment", async () => {
		const screen = await render(
			<BylineFilter value={EMPTY_BYLINE_FILTER} onChange={vi.fn()} locale="en" />,
		);

		await screen.getByRole("button", { name: "Filter by byline" }).click();
		const search = screen.getByRole("searchbox", { name: "Search bylines" });
		const noneLabel = screen.getByText("No byline assigned");
		const guestLabel = screen.getByText("Guest Contributor");
		const inferredLabel = screen.getByText("Include inferred bylines");
		const description = screen.getByText(/Also match the byline linked/);
		await expect.element(guestLabel).toBeVisible();

		const textElements = [search, noneLabel, guestLabel, inferredLabel, description].map(
			(locator) => locator.element(),
		);
		const styles = textElements.map((element) => getComputedStyle(element));
		expect(new Set(styles.map((style) => style.fontFamily)).size).toBe(1);
		expect(new Set(styles.map((style) => style.fontSize))).toEqual(new Set(["14px"]));
		expect(getComputedStyle(inferredLabel.element()).fontWeight).toBe("400");

		const controls = [
			screen.getByRole("checkbox", { name: "No byline assigned" }),
			screen.getByRole("checkbox", { name: "Guest Contributor" }),
			screen.getByRole("switch", { name: "Include inferred bylines" }),
		].map((locator) => locator.element().getBoundingClientRect().left);
		expect(Math.max(...controls) - Math.min(...controls)).toBeLessThanOrEqual(1);
		const descriptionRange = document.createRange();
		descriptionRange.selectNodeContents(description.element());
		expect(
			Math.abs(
				descriptionRange.getBoundingClientRect().left -
					search.element().getBoundingClientRect().left,
			),
		).toBeLessThanOrEqual(1);
	});
});
