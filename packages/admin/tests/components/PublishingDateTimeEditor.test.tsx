import { i18n } from "@lingui/core";
import * as React from "react";
import { expect, it, vi } from "vitest";

import { PublishingDateTimeFields } from "../../src/components/PublishingDateTimeEditor.js";
import { getPublishingTimeZone } from "../../src/lib/publishing-datetime.js";
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

it("uses a Kumo native time input", async () => {
	const date = new Date(2035, 5, 15, 12);
	const screen = await render(
		<PublishingDateTimeFields
			date={date}
			time="09:05"
			dateAriaLabel="Publication date"
			onDateChange={vi.fn()}
			onTimeChange={vi.fn()}
		/>,
	);

	const timeInput = screen.getByLabelText("Time");
	await expect.element(timeInput).toHaveValue("09:05");
	await expect.element(timeInput).toHaveAttribute("type", "time");
	const { timeZone, shortName } = getPublishingTimeZone(date, i18n.locale);
	const zoneDetails = timeZone ? (shortName ? `${timeZone} (${shortName})` : timeZone) : null;
	expect(zoneDetails).not.toBeNull();
	await expect.element(screen.getByText(zoneDetails!, { exact: true })).toBeVisible();
	expect(screen.container.querySelectorAll('input[type="time"]')).toHaveLength(1);
});

it("accepts browser-native time values", async () => {
	function ControlledFields() {
		const [time, setTime] = React.useState("09:05");
		return (
			<PublishingDateTimeFields
				date={new Date(2035, 5, 15, 12)}
				time={time}
				dateAriaLabel="Publication date"
				onDateChange={vi.fn()}
				onTimeChange={setTime}
			/>
		);
	}

	const screen = await render(<ControlledFields />);
	const timeInput = screen.getByLabelText("Time");
	await timeInput.fill("14:43");

	await expect.element(timeInput).toHaveValue("14:43");
});
