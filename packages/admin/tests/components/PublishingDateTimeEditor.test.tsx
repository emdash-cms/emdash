import { i18n } from "@lingui/core";
import * as React from "react";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

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

it("uses Kumo hour and minute text inputs instead of the browser time picker", async () => {
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

	await expect.element(screen.getByRole("textbox", { name: "Hour" })).toHaveValue("09");
	await expect.element(screen.getByRole("textbox", { name: "Minute" })).toHaveValue("05");
	const { timeZone, shortName } = getPublishingTimeZone(date, i18n.locale);
	const zoneDetails = timeZone ? (shortName ? `${timeZone} (${shortName})` : timeZone) : null;
	expect(zoneDetails).not.toBeNull();
	await expect.element(screen.getByText(zoneDetails!, { exact: true })).toBeVisible();
	expect(screen.container.querySelector('input[type="time"]')).toBeNull();
});

it("filters keyboard input and moves focus after a valid two-digit hour", async () => {
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
	const hour = screen.getByRole("textbox", { name: "Hour" });
	const minute = screen.getByRole("textbox", { name: "Minute" });

	await hour.click();
	await userEvent.keyboard("a1b4");

	await expect.element(hour).toHaveValue("14");
	await expect.element(minute).toHaveFocus();
});
