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

	it("selects a byline, toggles inferred matching, and shows help", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<BylineFilter value={EMPTY_BYLINE_FILTER} onChange={onChange} locale="en" />,
		);

		const trigger = screen.getByRole("button", { name: "Filter by byline" });
		await trigger.click();
		const guest = screen.getByRole("checkbox", { name: "Guest Contributor" });
		await expect.element(guest).toBeVisible();
		await guest.click();
		expect(onChange).toHaveBeenCalledWith({
			...EMPTY_BYLINE_FILTER,
			bylineIds: ["guest-group"],
		});

		onChange.mockClear();
		await screen.getByRole("switch", { name: "Include inferred bylines" }).click();
		expect(onChange).toHaveBeenCalledWith({
			...EMPTY_BYLINE_FILTER,
			includeInferred: true,
		});

		const inferredHelp = screen.getByRole("button", { name: "About inferred bylines" });
		await inferredHelp.hover();
		await expect
			.element(
				screen.getByText(
					"Also match the byline linked to an entry's author when it has none assigned.",
				),
			)
			.toBeVisible();
	});

	it("disables unselected bylines after reaching the selection limit", async () => {
		const value = {
			...EMPTY_BYLINE_FILTER,
			bylineIds: Array.from({ length: 25 }, (_, index) => `selected-${index}`),
		};
		const screen = await render(<BylineFilter value={value} onChange={vi.fn()} locale="en" />);

		await screen.getByRole("button", { name: "Filter by byline" }).click();
		await expect
			.element(screen.getByRole("checkbox", { name: "Guest Contributor" }))
			.toBeDisabled();
		await expect.element(screen.getByRole("checkbox", { name: "EmDash Editorial" })).toBeDisabled();
	});
});
