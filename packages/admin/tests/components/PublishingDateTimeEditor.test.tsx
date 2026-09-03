import { expect, it, vi } from "vitest";

import { PublishingDateTimeFields } from "../../src/components/PublishingDateTimeEditor.js";
import { render } from "../utils/render.tsx";

it("returns the calendar to the current month when a new entry has no saved date", async () => {
	const previousDate = new Date(2035, 5, 15, 12);
	const currentMonth = new Intl.DateTimeFormat("en-US", {
		month: "long",
		year: "numeric",
	}).format(new Date());
	const screen = await render(
		<PublishingDateTimeFields
			date={previousDate}
			time="09:00"
			dateAriaLabel="Publication date"
			onDateChange={vi.fn()}
			onTimeChange={vi.fn()}
		/>,
	);

	await expect.element(screen.getByText("June 2035", { exact: true })).toBeVisible();
	await screen.rerender(
		<PublishingDateTimeFields
			date={undefined}
			time=""
			dateAriaLabel="Publication date"
			onDateChange={vi.fn()}
			onTimeChange={vi.fn()}
		/>,
	);

	await expect.element(screen.getByText(currentMonth, { exact: true })).toBeVisible();
});

it("uses Kumo hour and minute selects instead of the browser time picker", async () => {
	const screen = await render(
		<PublishingDateTimeFields
			date={new Date(2035, 5, 15, 12)}
			time="09:05"
			dateAriaLabel="Publication date"
			onDateChange={vi.fn()}
			onTimeChange={vi.fn()}
		/>,
	);

	await expect.element(screen.getByRole("combobox", { name: "Hour" })).toHaveTextContent("09");
	await expect.element(screen.getByRole("combobox", { name: "Minute" })).toHaveTextContent("05");
	expect(screen.container.querySelector('input[type="time"]')).toBeNull();
});
