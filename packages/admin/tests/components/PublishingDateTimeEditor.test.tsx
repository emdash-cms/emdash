import { i18n } from "@lingui/core";
import { fireEvent } from "@testing-library/react";
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

function dayPeriodLabel(hour: number): string {
	return (
		new Intl.DateTimeFormat(i18n.locale, { hour: "numeric", hour12: true })
			.formatToParts(new Date(2020, 0, 1, hour))
			.find(({ type }) => type === "dayPeriod")?.value ?? ""
	);
}

it("uses Kumo segmented time fields without a browser picker", async () => {
	const date = new Date(2035, 5, 15, 12);
	const screen = await render(
		<PublishingDateTimeFields
			date={date}
			time="21:05"
			dateAriaLabel="Publication date"
			onDateChange={vi.fn()}
			onTimeChange={vi.fn()}
		/>,
	);

	await expect.element(screen.getByRole("textbox", { name: "Hour" })).toHaveValue("09");
	await expect.element(screen.getByRole("textbox", { name: "Minute" })).toHaveValue("05");
	await expect
		.element(screen.getByRole("combobox", { name: "Period" }))
		.toHaveTextContent(dayPeriodLabel(13));
	const { timeZone, shortName } = getPublishingTimeZone(date, i18n.locale);
	const zoneDetails = timeZone ? (shortName ? `${timeZone} (${shortName})` : timeZone) : null;
	expect(zoneDetails).not.toBeNull();
	await expect.element(screen.getByText(zoneDetails!, { exact: true })).toBeVisible();
	expect(screen.container.querySelector('input[type="time"]')).toBeNull();
});

it("accepts localized numerals in the time fields", async () => {
	function ControlledFields() {
		const [time, setTime] = React.useState("");
		return (
			<>
				<PublishingDateTimeFields
					date={new Date(2035, 5, 15, 12)}
					time={time}
					dateAriaLabel="Publication date"
					onDateChange={vi.fn()}
					onTimeChange={setTime}
				/>
				<output>{time}</output>
			</>
		);
	}

	const screen = await render(<ControlledFields />);
	const hour = screen.getByRole("textbox", { name: "Hour" });
	const minute = screen.getByRole("textbox", { name: "Minute" });
	await hour.fill("١٠");
	await expect.element(minute).toHaveFocus();
	await minute.fill("۳۰");

	await expect.element(screen.getByText("10:30", { exact: true })).toBeVisible();

	await hour.fill("११");
	await expect.element(minute).toHaveFocus();
	await minute.fill("४५");
	await expect.element(screen.getByText("11:45", { exact: true })).toBeVisible();

	await hour.fill("๑๒");
	await expect.element(minute).toHaveFocus();
	await minute.fill("๕๙");
	await expect.element(screen.getByText("00:59", { exact: true })).toBeVisible();
});

it("moves focus to minutes and converts the selected day period", async () => {
	function ControlledFields() {
		const [time, setTime] = React.useState("09:05");
		return (
			<>
				<PublishingDateTimeFields
					date={new Date(2035, 5, 15, 12)}
					time={time}
					dateAriaLabel="Publication date"
					onDateChange={vi.fn()}
					onTimeChange={setTime}
				/>
				<output>{time}</output>
			</>
		);
	}

	const screen = await render(<ControlledFields />);
	const hour = screen.getByRole("textbox", { name: "Hour" });
	const minute = screen.getByRole("textbox", { name: "Minute" });
	await hour.click();
	await userEvent.keyboard("10");
	await expect.element(minute).toHaveFocus();
	await minute.fill("30");
	fireEvent.click(screen.getByRole("combobox", { name: "Period" }).element());
	const periodOption = screen.getByRole("option", { name: dayPeriodLabel(13), exact: true });
	await expect.element(periodOption).toBeInTheDocument();
	await periodOption.click({ force: true });

	await expect.element(screen.getByText("22:30", { exact: true })).toBeVisible();
	await screen.unmount();
});
