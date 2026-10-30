import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import {
	PublicationDateDialog,
	PublishingScheduleDialog,
} from "../../src/components/PublishingDateTimeEditor.js";
import { pressOutside } from "../utils/mouse.ts";
import { render } from "../utils/render.tsx";

// Both dialogs open from a button in the top corner of the page, so the tests press
// outside them in the bottom corner. A release over the button would open the dialog
// again once it had closed.
function ScheduleHarness({ onSchedule }: { onSchedule: (scheduledAt: string) => Promise<void> }) {
	const [open, setOpen] = React.useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<PublishingScheduleDialog
				open={open}
				entryKey="post-1:en"
				isLive={false}
				onOpenChange={setOpen}
				onSchedule={onSchedule}
			/>
		</>
	);
}

async function openSchedule(onSchedule: (scheduledAt: string) => Promise<void> = vi.fn()) {
	const screen = await render(<ScheduleHarness onSchedule={onSchedule} />);
	await screen.getByRole("button", { name: "Open" }).click();
	const dialog = screen.getByRole("dialog", { name: "Schedule publication" });
	await expect.element(dialog).toBeVisible();
	return { screen, dialog };
}

async function openPublicationDate(
	onPublishedAtChange: (publishedAt: string) => Promise<void> = vi.fn(),
) {
	const screen = await render(
		<PublicationDateDialog
			entryKey="post-1:en"
			publishedAt="2035-06-15T13:30:00.000Z"
			label="Published"
			formattedValue="Jun 15, 2035"
			onPublishedAtChange={onPublishedAtChange}
		/>,
	);
	await screen.getByRole("button", { name: /Change publication date/ }).click();
	const dialog = screen.getByRole("dialog", { name: "Change publication date" });
	await expect.element(dialog).toBeVisible();
	return { screen, dialog };
}

describe("PublishingScheduleDialog", () => {
	it("shows a refused request in the dialog's error banner, not on the time", async () => {
		const { dialog } = await openSchedule(vi.fn().mockRejectedValue(new Error("Entry is locked")));
		await dialog.getByRole("button", { name: "Schedule", exact: true }).click();

		await expect
			.element(dialog.getByRole("alert").filter({ hasText: "Entry is locked" }))
			.toBeVisible();
		const time = dialog.getByRole("group", { name: "Time" });
		expect(time.getByText("Entry is locked").query()).toBeNull();
		await expect
			.element(time.getByRole("textbox", { name: "Hour" }))
			.not.toHaveAttribute("aria-invalid");
	});

	it("refuses to close while the schedule is being saved", async () => {
		let finish: () => void = () => {};
		const onSchedule = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const { dialog } = await openSchedule(onSchedule);
		await dialog.getByRole("button", { name: "Schedule", exact: true }).click();
		await vi.waitFor(() => expect(onSchedule).toHaveBeenCalled());

		await userEvent.keyboard("{Escape}");
		await pressOutside("bottom");
		await expect.element(dialog).toHaveAttribute("data-open");

		finish();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps a changed time through a press outside, and closes when unchanged", async () => {
		const { screen, dialog } = await openSchedule();

		await pressOutside("bottom");
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Open" }).click();
		await expect.element(dialog).toBeVisible();
		await dialog.getByRole("textbox", { name: "Minute" }).fill("45");
		await pressOutside("bottom");
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByRole("textbox", { name: "Minute" })).toHaveValue("45");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});
});

describe("PublicationDateDialog", () => {
	it("shows a refused save in the dialog's error banner, not on the time", async () => {
		const { dialog } = await openPublicationDate(
			vi.fn().mockRejectedValue(new Error("Entry is locked")),
		);
		await dialog.getByRole("textbox", { name: "Minute" }).fill("45");
		await dialog.getByRole("button", { name: "Save date" }).click();

		await expect
			.element(dialog.getByRole("alert").filter({ hasText: "Entry is locked" }))
			.toBeVisible();
		const time = dialog.getByRole("group", { name: "Time" });
		expect(time.getByText("Entry is locked").query()).toBeNull();
		await expect
			.element(time.getByRole("textbox", { name: "Minute" }))
			.not.toHaveAttribute("aria-invalid");
		// Every control was disabled while the save ran, so focus has to be brought back.
		await vi.waitFor(() => expect(dialog.element().contains(document.activeElement)).toBe(true));
	});

	it("refuses to close while the date is being saved", async () => {
		let finish: () => void = () => {};
		const onPublishedAtChange = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const { dialog } = await openPublicationDate(onPublishedAtChange);
		await dialog.getByRole("textbox", { name: "Minute" }).fill("45");
		await dialog.getByRole("button", { name: "Save date" }).click();
		await vi.waitFor(() => expect(onPublishedAtChange).toHaveBeenCalled());

		await userEvent.keyboard("{Escape}");
		await pressOutside("bottom");
		await expect.element(dialog).toHaveAttribute("data-open");

		finish();
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("keeps a changed date through a press outside, and closes when unchanged", async () => {
		const { screen, dialog } = await openPublicationDate();

		await pressOutside("bottom");
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: /Change publication date/ }).click();
		await expect.element(dialog).toBeVisible();
		await dialog.getByRole("textbox", { name: "Minute" }).fill("45");
		await pressOutside("bottom");
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByRole("textbox", { name: "Minute" })).toHaveValue("45");
	});
});
