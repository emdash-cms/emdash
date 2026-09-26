import { describe, expect, it } from "vitest";

import {
	ContentStatusBadge,
	ContentStatusIcon,
	ContentStatusLabel,
	type ContentStatusState,
} from "../../src/components/ContentStatusBadge";
import { render } from "../utils/render";

const statuses: Array<{ state: ContentStatusState; label: string }> = [
	{ state: "published", label: "Published" },
	{ state: "draft", label: "Draft" },
	{ state: "scheduled", label: "Scheduled" },
	{ state: "archived", label: "Archived" },
	{ state: "pendingChanges", label: "Pending changes" },
	{ state: "private", label: "Private" },
];

describe("ContentStatusBadge", () => {
	for (const { state, label } of statuses) {
		it(`renders the ${state} state with its user-facing label`, async () => {
			const screen = await render(<ContentStatusBadge state={state} />);

			await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
			expect(screen.container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
		});
	}
});

describe("ContentStatusLabel", () => {
	it("renders the icon and label as one readable value", async () => {
		const screen = await render(<ContentStatusLabel state="pendingChanges" />);

		await expect.element(screen.getByText("Pending changes", { exact: true })).toBeVisible();
		const icon = screen.container.querySelector("svg[aria-hidden='true']");
		expect(icon).not.toBeNull();
	});
});

describe("ContentStatusIcon", () => {
	for (const { state, label } of statuses) {
		it(`gives the ${state} icon an accessible localized name`, async () => {
			const screen = await render(<ContentStatusIcon state={state} />);

			await expect.element(screen.getByRole("img", { name: label })).toBeVisible();
		});
	}

	it("can be hidden when adjacent text already names the state", async () => {
		const screen = await render(<ContentStatusIcon state="draft" decorative />);

		expect(screen.container.querySelector("svg[aria-hidden='true']")).not.toBeNull();
		expect(screen.container.querySelector("[role='img']")).toBeNull();
	});
});
