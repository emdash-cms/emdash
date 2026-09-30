import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { CalendarEntry } from "../../../src/lib/api/calendar";
import {
	createCalendarDisplay,
	groupByDay,
	monthGridDays,
	toCalendarItems,
} from "../../../src/lib/calendar";
import { render } from "../../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual("@tanstack/react-router")),
	Link: ({ to, params, search, children, ...props }: any) => (
		<a
			href={`${String(to).replace("$collection", params.collection).replace("$id", params.id)}?locale=${search.locale}`}
			{...props}
		>
			{children}
		</a>
	),
}));

const { CalendarMonth } = await import("../../../src/components/calendar/CalendarMonth");

const timeZone = "Asia/Tokyo";
const now = Date.parse("2026-10-15T03:00:00.000Z");
const display = createCalendarDisplay({
	locale: "en",
	timeZone,
	viewerTimeZone: timeZone,
	collections: [{ slug: "posts", label: "Posts" }],
	showLocale: false,
});

function entry(id: string, at: string): CalendarEntry {
	return {
		collection: "posts",
		id,
		locale: "en",
		title: `Entry ${id}`,
		status: "scheduled",
		kind: "scheduled",
		at,
	};
}

const busyDay = Array.from({ length: 6 }, (_, index) =>
	entry(`busy-${index + 1}`, `2026-10-20T0${index}:00:00.000Z`),
);
const days = groupByDay(
	toCalendarItems([entry("late", "2026-10-13T20:00:00.000Z"), ...busyDay], {
		timeZone,
		loadedAt: now,
		collectionOrder: ["posts"],
	}),
);

function renderMonth({
	compact = false,
	today = "2026-10-15",
	at = now,
	loadedThrough,
	onMonthChange = () => {},
	onSelect,
}: {
	compact?: boolean;
	today?: string;
	at?: number;
	loadedThrough?: string;
	onMonthChange?: (month: string) => void;
	onSelect?: (item: { key: string }, element: HTMLElement) => void;
} = {}) {
	return render(
		<CalendarMonth
			month="2026-10"
			gridDays={monthGridDays("2026-10", 0)}
			days={days}
			today={today}
			now={at}
			display={display}
			compact={compact}
			loadedThrough={loadedThrough}
			onMonthChange={onMonthChange}
			onSelect={onSelect}
		/>,
	);
}

describe("CalendarMonth", () => {
	it("places entries on site-zone days and folds a busy day into a popover", async () => {
		const screen = await renderMonth();

		await expect
			.element(
				screen
					.getByRole("list", { name: "Wednesday, October 14, 2026" })
					.getByRole("link", { name: /Entry late/ }),
			)
			.toBeVisible();

		const busy = screen.getByRole("list", { name: "Tuesday, October 20, 2026" });
		expect(busy.getByRole("link").elements()).toHaveLength(3);

		await busy.getByRole("button", { name: "3 more entries on Tuesday, October 20, 2026" }).click();

		const popover = screen.getByRole("dialog");
		await expect.element(popover.getByText("Tuesday, October 20, 2026")).toBeVisible();
		expect(popover.getByRole("link").elements()).toHaveLength(6);
	});

	it("opens an entry card, or one from a busy day's popover, in the panel", async () => {
		const onSelect = vi.fn();
		const screen = await renderMonth({ onSelect });

		await screen.getByRole("link", { name: /Entry late/ }).click();
		expect(onSelect).toHaveBeenLastCalledWith(
			expect.objectContaining({ key: "posts:late:scheduled" }),
			expect.any(HTMLElement),
		);

		const more = screen.getByRole("button", {
			name: "3 more entries on Tuesday, October 20, 2026",
		});
		await more.click();
		await screen
			.getByRole("dialog")
			.getByRole("link", { name: /Entry busy-6/ })
			.click();

		expect(onSelect).toHaveBeenLastCalledWith(
			expect.objectContaining({ key: "posts:busy-6:scheduled" }),
			more.element(),
		);
		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
	});

	it("draws the present in the popover when it falls among folded entries", async () => {
		// 12:30 in Tokyo: four of the six entries (9:00 to 12:00) are past, and only three show.
		const screen = await renderMonth({
			today: "2026-10-20",
			at: Date.parse("2026-10-20T03:30:00.000Z"),
		});
		const busy = screen.getByRole("list", { name: "Tuesday, October 20, 2026" });

		await busy.getByRole("button", { name: "3 more entries on Tuesday, October 20, 2026" }).click();

		const popover = screen.getByRole("dialog");
		const nowLine = popover.getByText("Now · 12:30 PM").element();
		const links = popover.getByRole("link").elements();
		expect(links).toHaveLength(6);
		expect(
			links[3]?.compareDocumentPosition(nowLine) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			nowLine.compareDocumentPosition(links[4]!) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("draws the present after the folded entries once they are all past", async () => {
		const screen = await renderMonth({
			today: "2026-10-20",
			at: Date.parse("2026-10-20T06:30:00.000Z"),
		});
		const busy = screen.getByRole("list", { name: "Tuesday, October 20, 2026" });
		const more = busy
			.getByRole("button", { name: /3 more entries/ })
			.element()
			.closest("li");
		const last = busy.element().lastElementChild;

		expect(last?.getAttribute("aria-hidden")).toBe("true");
		expect(last?.previousElementSibling).toBe(more);
	});

	it("lists the entries of the day picked on a phone", async () => {
		const screen = await renderMonth({ compact: true });

		await expect.element(screen.getByText("Nothing on this day.")).toBeVisible();

		await screen.getByRole("button", { name: /October 20th, 2026, 6 entries/ }).click();

		const list = screen.getByRole("list", { name: "Tuesday, October 20, 2026" });
		await expect.poll(() => list.getByRole("link").elements()).toHaveLength(6);
	});

	it("marks the grid's empty days from the cut-off onward as not loaded", async () => {
		const screen = await renderMonth({ loadedThrough: "2026-10-20" });

		// October 21 to 31; the 20th has entries, and the Sunday-first grid ends on the 31st.
		expect(screen.getByText("Not loaded").elements()).toHaveLength(11);
		await expect
			.element(screen.getByRole("list", { name: "Tuesday, October 20, 2026" }))
			.toBeVisible();
	});

	it("says a day past the loaded entries was not loaded instead of empty", async () => {
		const screen = await renderMonth({
			compact: true,
			today: "2026-10-25",
			loadedThrough: "2026-10-20",
		});

		await expect
			.element(
				screen.getByText(
					"This day wasn't loaded. The range has more entries than the calendar can show.",
				),
			)
			.toBeVisible();
		await expect.element(screen.getByText("Nothing on this day.")).not.toBeInTheDocument();
	});

	it("moves to the next month when the arrow keys cross the last day", async () => {
		const onMonthChange = vi.fn();
		const screen = await renderMonth({ compact: true, onMonthChange });

		await screen.getByRole("button", { name: /October 31st, 2026/ }).click();
		await userEvent.keyboard("{ArrowRight}");

		expect(onMonthChange).toHaveBeenCalledWith("2026-11");

		await screen.rerender(
			<CalendarMonth
				month="2026-11"
				gridDays={monthGridDays("2026-11", 0)}
				days={days}
				today="2026-10-15"
				now={now}
				display={display}
				compact
				onMonthChange={onMonthChange}
			/>,
		);

		await expect
			.poll(() => document.activeElement?.getAttribute("aria-label"))
			.toMatch(/November 1st, 2026/);
	});
});
