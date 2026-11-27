import "../../dist/styles.css";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ContentList } from "../../src/components/ContentList";
import { fetchBylines } from "../../src/lib/api/index.js";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api/index.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/index.js")>(
		"../../src/lib/api/index.js",
	);
	return { ...actual, fetchBylines: vi.fn() };
});

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, params: _params, ...props }: Record<string, unknown>) => (
			<a href={typeof to === "string" ? to : "#"} {...props}>
				{children as React.ReactNode}
			</a>
		),
	};
});

describe("content list filter bar", () => {
	it("opens the byline filter at least as wide as its trigger, in the status options' type size", async () => {
		vi.mocked(fetchBylines).mockResolvedValue({
			items: [
				{
					id: "guest",
					slug: "guest",
					displayName: "Guest Contributor",
					bio: null,
					avatarMediaId: null,
					websiteUrl: null,
					userId: null,
					isGuest: true,
					createdAt: "2026-08-18T00:00:00Z",
					updatedAt: "2026-08-18T00:00:00Z",
				},
			],
		});
		const screen = await render(
			<ContentList
				collection="posts"
				collectionLabel="Posts"
				items={[]}
				onSearchChange={vi.fn()}
				onStatusFilterChange={vi.fn()}
				onBylineFilterChange={vi.fn()}
			/>,
		);

		await screen.getByRole("combobox", { name: "Filter by status" }).click();
		const statusOption = page.getByRole("option", { name: "Published" });
		await expect.element(statusOption).toBeVisible();
		const statusOptionSize = getComputedStyle(statusOption.element()).fontSize;
		await userEvent.keyboard("{Escape}");
		await expect.element(statusOption).not.toBeInTheDocument();

		const trigger = screen.getByRole("button", { name: "Filter by byline" });
		await trigger.click();
		const option = page.getByText("Guest Contributor", { exact: true });
		await expect.element(option).toBeVisible();

		const popup = option.element().closest(".kumo-popover-popup")!;
		expect(popup.getBoundingClientRect().width).toBeGreaterThanOrEqual(
			trigger.element().getBoundingClientRect().width,
		);
		expect(getComputedStyle(option.element()).fontSize).toBe(statusOptionSize);
	});
});
