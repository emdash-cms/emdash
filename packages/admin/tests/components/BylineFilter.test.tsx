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

		const trigger = screen.getByRole("button", { name: "Filter by byline" });
		const triggerRect = trigger.element().getBoundingClientRect();
		const triggerLabel = screen.getByText("All bylines").element().getBoundingClientRect();
		const triggerIcon = trigger.element().querySelector("svg")?.getBoundingClientRect();
		if (!triggerIcon) throw new Error("Byline filter icon did not render");
		expect(triggerRect.height).toBe(26);
		expect(getComputedStyle(trigger.element()).fontSize).toBe("12px");
		expect(getComputedStyle(trigger.element()).fontWeight).toBe("400");
		expect(getComputedStyle(trigger.element()).paddingInlineStart).toBe("14px");
		expect(getComputedStyle(trigger.element()).paddingInlineEnd).toBe("14px");
		expect(
			Math.abs(
				triggerLabel.top + triggerLabel.height / 2 - (triggerIcon.top + triggerIcon.height / 2),
			),
		).toBeLessThanOrEqual(1);
		const triggerContentStart = Math.min(triggerLabel.left, triggerIcon.left);
		const triggerContentEnd = Math.max(triggerLabel.right, triggerIcon.right);
		expect(
			Math.abs(
				(triggerContentStart + triggerContentEnd) / 2 - (triggerRect.left + triggerRect.right) / 2,
			),
		).toBeLessThanOrEqual(1);

		await trigger.click();
		const search = screen.getByRole("searchbox", { name: "Search bylines" });
		const noneLabel = screen.getByText("No byline assigned");
		const guestLabel = screen.getByText("Guest Contributor");
		const inferredLabel = screen.getByText("Include inferred bylines");
		const inferredHelp = screen.getByRole("button", { name: "About inferred bylines" });
		await expect.element(guestLabel).toBeVisible();

		const textElements = [search, noneLabel, guestLabel, inferredLabel].map((locator) =>
			locator.element(),
		);
		const styles = textElements.map((element) => getComputedStyle(element));
		expect(new Set(styles.map((style) => style.fontFamily)).size).toBe(1);
		expect(new Set(styles.map((style) => style.fontSize))).toEqual(new Set(["14px"]));
		expect(getComputedStyle(inferredLabel.element()).fontWeight).toBe("400");

		const noneControl = screen.getByRole("checkbox", { name: "No byline assigned" });
		const guestControl = screen.getByRole("checkbox", { name: "Guest Contributor" });
		const switchControl = screen.getByRole("switch", { name: "Include inferred bylines" });
		expect(noneControl.element().getBoundingClientRect().left).toBe(
			guestControl.element().getBoundingClientRect().left,
		);
		const switchRow = switchControl.element().parentElement;
		if (!switchRow) throw new Error("Inferred byline switch row did not render");
		expect(
			switchRow.getBoundingClientRect().right -
				switchControl.element().getBoundingClientRect().right,
		).toBeLessThanOrEqual(1);
		const optionGroup = screen.getByRole("group", { name: "Bylines" }).element();
		expect(
			guestControl.element().getBoundingClientRect().left -
				optionGroup.getBoundingClientRect().left,
		).toBeGreaterThanOrEqual(2);
		const optionRow = guestLabel.element().closest("label")?.parentElement?.parentElement;
		if (!optionRow) throw new Error("Byline option row did not render");
		expect(
			optionRow.getBoundingClientRect().height -
				guestLabel.element().getBoundingClientRect().height,
		).toBeGreaterThanOrEqual(16);
		await inferredHelp.hover();
		await expect
			.element(
				screen.getByText(
					"Also match the byline linked to an entry's author when it has none assigned.",
				),
			)
			.toBeVisible();
	});
});
