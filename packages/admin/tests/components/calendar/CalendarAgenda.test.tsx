import { describe, expect, it, vi } from "vitest";

import type { CalendarEntry } from "../../../src/lib/api/calendar";
import { createCalendarDisplay, groupByDay, toCalendarItems } from "../../../src/lib/calendar";
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

const { CalendarAgenda } = await import("../../../src/components/calendar/CalendarAgenda");

const now = Date.parse("2026-10-15T12:00:00.000Z");
const display = createCalendarDisplay({
	locale: "en",
	timeZone: "UTC",
	viewerTimeZone: "UTC",
	collections: [
		{ slug: "posts", label: "Posts" },
		{ slug: "pages", label: "Pages" },
	],
	showLocale: false,
});

function entry(overrides: Partial<CalendarEntry> & Pick<CalendarEntry, "id" | "title" | "at">) {
	return {
		collection: "posts",
		locale: "en",
		status: "published",
		kind: "published",
		...overrides,
	} satisfies CalendarEntry;
}

const days = groupByDay(
	toCalendarItems(
		[
			entry({ id: "welcome", title: "Welcome back", at: "2026-10-02T09:00:00.000Z" }),
			entry({ id: "about", collection: "pages", title: "About", at: "2026-10-05T09:00:00.000Z" }),
			entry({
				id: "launch",
				title: "Launch",
				status: "scheduled",
				kind: "scheduled",
				at: "2026-10-15T09:00:00.000Z",
			}),
			entry({ id: "pricing", title: "Pricing", kind: "scheduled", at: "2026-10-20T10:00:00.000Z" }),
		],
		{ timeZone: "UTC", now, collectionOrder: ["posts", "pages"] },
	),
);

describe("CalendarAgenda", () => {
	it("lists the month's days in order and reveals the days before today", async () => {
		const screen = await render(
			<CalendarAgenda month="2026-10" days={days} today="2026-10-15" now={now} display={display} />,
		);
		const dayLists = () =>
			screen
				.getByRole("list")
				.elements()
				.map((list) => list.getAttribute("aria-label"));

		expect(dayLists()).toEqual(["Thursday, October 15, 2026", "Tuesday, October 20, 2026"]);
		await expect.element(screen.getByText("Overdue · 3 hours ago")).toBeVisible();
		await expect.element(screen.getByText("Update", { exact: true })).toBeVisible();

		await screen.getByRole("button", { name: "Show 2 earlier entries" }).click();

		await expect
			.poll(dayLists)
			.toEqual([
				"Friday, October 2, 2026",
				"Monday, October 5, 2026",
				"Thursday, October 15, 2026",
				"Tuesday, October 20, 2026",
			]);
		await expect
			.element(screen.getByRole("link", { name: /Welcome back/ }))
			.toHaveAttribute("href", "/content/posts/welcome?locale=en");
	});

	it("marks the present between days and says when nothing follows it", async () => {
		const upcoming = groupByDay(
			toCalendarItems(
				[
					entry({ id: "early", title: "Early", at: "2026-10-14T09:00:00.000Z" }),
					entry({ id: "later", title: "Later", kind: "scheduled", at: "2026-10-20T09:00:00.000Z" }),
				],
				{ timeZone: "UTC", now, collectionOrder: ["posts"] },
			),
		);
		const screen = await render(
			<CalendarAgenda
				month="2026-10"
				days={upcoming}
				today="2026-10-15"
				now={now}
				display={display}
			/>,
		);

		const nowLine = screen.getByText("Now · 12:00 PM").element();
		const laterList = screen.getByRole("list", { name: "Tuesday, October 20, 2026" }).element();
		expect(
			nowLine.compareDocumentPosition(laterList) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		await expect
			.element(screen.getByText("Nothing else is scheduled this month."))
			.not.toBeInTheDocument();

		const past = groupByDay(
			toCalendarItems([entry({ id: "early", title: "Early", at: "2026-10-14T09:00:00.000Z" })], {
				timeZone: "UTC",
				now,
				collectionOrder: ["posts"],
			}),
		);
		await screen.rerender(
			<CalendarAgenda month="2026-10" days={past} today="2026-10-15" now={now} display={display} />,
		);

		await expect.element(screen.getByText("Now · 12:00 PM")).toBeVisible();
		await expect.element(screen.getByText("Nothing else is scheduled this month.")).toBeVisible();
	});

	it("keeps earlier days open while one of them holds an overdue entry", async () => {
		const missed = groupByDay(
			toCalendarItems(
				[
					entry({
						id: "missed",
						title: "Missed",
						status: "scheduled",
						kind: "scheduled",
						at: "2026-10-14T09:00:00.000Z",
					}),
				],
				{ timeZone: "UTC", now, collectionOrder: ["posts"] },
			),
		);
		const screen = await render(
			<CalendarAgenda
				month="2026-10"
				days={missed}
				today="2026-10-15"
				now={now}
				display={display}
			/>,
		);

		await expect
			.element(screen.getByRole("list", { name: "Wednesday, October 14, 2026" }))
			.toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Hide earlier entries" }))
			.toBeVisible();
	});
});
