import { i18n } from "@lingui/core";
import { fireEvent } from "@testing-library/react";
import * as React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	PublishingDateTimeFields,
	PublishingScheduleDialog,
} from "../../src/components/PublishingDateTimeEditor.js";
import { getPublishingTimeZone } from "../../src/lib/publishing-datetime.js";
import { render } from "../utils/render.tsx";

afterEach(() => {
	vi.useRealTimers();
});

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

it("keeps the chosen day when it is clicked again", async () => {
	function ControlledFields() {
		const [date, setDate] = React.useState<Date | undefined>(new Date(2035, 5, 15, 12));
		return (
			<PublishingDateTimeFields
				date={date}
				time="09:00"
				dateAriaLabel="Publication date"
				onDateChange={setDate}
				onTimeChange={vi.fn()}
			/>
		);
	}

	const screen = await render(<ControlledFields />);
	const day = screen.getByRole("button", { name: /June 15/ });
	const cell = () => day.element().closest('[role="gridcell"]')!;
	expect(cell()).toHaveAttribute("aria-selected", "true");
	await day.click();

	expect(cell()).toHaveAttribute("aria-selected", "true");
});

const scheduleDialogProps = {
	entryKey: "post-1:en",
	isLive: false,
	onOpenChange: vi.fn(),
};

it("suggests the next whole hour from when the schedule dialog opens", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2035, 5, 15, 9, 20));
	const onSchedule = vi.fn();
	const screen = await render(
		<PublishingScheduleDialog {...scheduleDialogProps} open={false} onSchedule={onSchedule} />,
	);
	vi.setSystemTime(new Date(2035, 5, 15, 14, 57));
	await screen.rerender(
		<PublishingScheduleDialog {...scheduleDialogProps} open onSchedule={onSchedule} />,
	);
	const schedule = screen.getByRole("button", { name: "Schedule", exact: true });
	await expect.element(schedule).toBeVisible();
	schedule.element().click();

	expect(onSchedule).toHaveBeenCalledWith(new Date(2035, 5, 15, 16, 0).toISOString());
});

it("explains why the schedule cannot be saved", async () => {
	const onSchedule = vi.fn();
	const screen = await render(
		<PublishingScheduleDialog {...scheduleDialogProps} open onSchedule={onSchedule} />,
	);
	const minute = screen.getByRole("textbox", { name: "Minute" });
	await minute.fill("");
	await userEvent.keyboard("{Enter}");

	await expect.element(minute).toHaveAccessibleDescription("Enter a time");
	await expect.element(minute).toHaveAttribute("aria-invalid", "true");
	expect(onSchedule).not.toHaveBeenCalled();
});

it("moves focus to the start of a time that has already passed", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2035, 5, 15, 14, 57));
	const screen = await render(
		<PublishingScheduleDialog {...scheduleDialogProps} open onSchedule={vi.fn()} />,
	);
	const hour = screen.getByRole("textbox", { name: "Hour" });
	const minute = screen.getByRole("textbox", { name: "Minute" });
	await hour.fill("01");
	await minute.fill("30");
	await userEvent.keyboard("{Enter}");

	await expect.element(hour).toHaveAccessibleDescription("Choose a time in the future");
	await expect.element(hour).toHaveFocus();
});

it("shows why the server rejected the schedule", async () => {
	const onSchedule = vi.fn().mockRejectedValue(new Error("Scheduling is locked for this post"));
	const screen = await render(
		<PublishingScheduleDialog {...scheduleDialogProps} open onSchedule={onSchedule} />,
	);
	const schedule = screen.getByRole("button", { name: "Schedule", exact: true });
	await expect.element(schedule).toBeVisible();
	schedule.element().click();

	await expect
		.element(screen.getByRole("alert"))
		.toHaveTextContent("Scheduling is locked for this post");
});

it("replaces a server error with the reason a retry cannot be saved", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2035, 5, 15, 14, 57));
	const onSchedule = vi.fn().mockRejectedValue(new Error("Scheduling is locked for this post"));
	const screen = await render(
		<PublishingScheduleDialog {...scheduleDialogProps} open onSchedule={onSchedule} />,
	);
	const schedule = screen.getByRole("button", { name: "Schedule", exact: true });
	await expect.element(schedule).toBeVisible();
	schedule.element().click();
	await expect
		.element(screen.getByRole("alert"))
		.toHaveTextContent("Scheduling is locked for this post");

	vi.setSystemTime(new Date(2035, 5, 15, 16, 30));
	schedule.element().click();

	await expect.element(screen.getByRole("alert")).toHaveTextContent("Choose a time in the future");
});

it("accepts a single-digit minute", async () => {
	function ControlledFields() {
		const [time, setTime] = React.useState("09:00");
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
	await screen.getByRole("textbox", { name: "Minute" }).fill("5");

	await expect.element(screen.getByText("09:05", { exact: true })).toBeVisible();
});

it("keeps hours before minutes in right-to-left locales", async () => {
	const screen = await render(
		<div dir="rtl">
			<PublishingDateTimeFields
				date={new Date(2035, 5, 15, 12)}
				time="09:05"
				dateAriaLabel="Publication date"
				onDateChange={vi.fn()}
				onTimeChange={vi.fn()}
			/>
		</div>,
	);
	const hour = screen.getByRole("textbox", { name: "Hour" }).element().getBoundingClientRect();
	const minute = screen.getByRole("textbox", { name: "Minute" }).element().getBoundingClientRect();

	expect(hour.left).toBeLessThan(minute.left);
});

it("restores an emptied time field when it loses focus", async () => {
	function ControlledFields() {
		const [time, setTime] = React.useState("14:30");
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
	const minute = screen.getByRole("textbox", { name: "Minute" });
	await minute.fill("");
	screen.getByRole("textbox", { name: "Hour" }).element().focus();

	await expect.element(minute).toHaveValue("30");
	await expect.element(screen.getByText("14:30", { exact: true })).toBeVisible();
});
