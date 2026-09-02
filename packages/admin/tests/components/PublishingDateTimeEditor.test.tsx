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
