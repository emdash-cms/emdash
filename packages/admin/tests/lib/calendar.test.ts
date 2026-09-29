import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCalendarRange, type CalendarEntry } from "../../src/lib/api/calendar";
import {
	calendarState,
	createCalendarDisplay,
	dayKeyInZone,
	fetchRange,
	filterItems,
	monthGridDays,
	parseCalendarSearch,
	toCalendarItems,
} from "../../src/lib/calendar";

describe("monthGridDays", () => {
	it("covers whole weeks from the locale's first day of the week", () => {
		const sundayFirst = monthGridDays("2026-10", 0);
		expect(sundayFirst[0]).toBe("2026-09-27");
		expect(sundayFirst.at(-1)).toBe("2026-10-31");
		expect(sundayFirst).toHaveLength(35);

		const saturdayFirst = monthGridDays("2026-10", 6);
		expect(saturdayFirst[0]).toBe("2026-09-26");
		expect(saturdayFirst.at(-1)).toBe("2026-11-06");
		expect(saturdayFirst).toHaveLength(42);
	});
});

describe("dayKeyInZone and fetchRange", () => {
	it("places an instant on the site zone's calendar day", () => {
		const instant = Date.parse("2026-10-15T03:30:00.000Z");

		expect(dayKeyInZone(instant, "America/New_York")).toBe("2026-10-14");
		expect(dayKeyInZone(instant, "Asia/Tokyo")).toBe("2026-10-15");
	});

	it("fetches every grid day in the most extreme UTC offsets", () => {
		const { from, to } = fetchRange(monthGridDays("2026-10", 0));
		const earliest = Date.parse("2026-09-26T10:30:00.000Z");
		const latest = Date.parse("2026-11-01T11:30:00.000Z");

		expect(dayKeyInZone(earliest, "Pacific/Kiritimati")).toBe("2026-09-27");
		expect(earliest).toBeGreaterThanOrEqual(Date.parse(from));
		expect(dayKeyInZone(latest, "Etc/GMT+12")).toBe("2026-10-31");
		expect(latest).toBeLessThan(Date.parse(to));
	});
});

describe("createCalendarDisplay", () => {
	const options = { locale: "en", collections: [], showLocale: false };

	it("shows the browser's time, with its weekday when the date differs", () => {
		const display = createCalendarDisplay({
			...options,
			timeZone: "America/New_York",
			viewerTimeZone: "Asia/Tokyo",
		});
		const lateEvening = Date.parse("2026-10-15T23:00:00.000Z");

		expect(display.viewerZoneDiffers).toBe(true);
		expect(display.formatTime(lateEvening)).toBe("7:00 PM");
		expect(display.formatViewerTime(lateEvening)).toMatch(/^Fri,? 8:00 AM/);
	});

	it("treats zones with the same name as the same, and falls back to UTC", () => {
		expect(
			createCalendarDisplay({
				...options,
				timeZone: "Europe/Paris",
				viewerTimeZone: "Europe/Berlin",
			}).viewerZoneDiffers,
		).toBe(false);
		expect(createCalendarDisplay({ ...options, timeZone: "Not/AZone" }).timeZone).toBe("UTC");
	});
});

describe("calendarState", () => {
	const now = Date.parse("2026-10-15T12:00:00.000Z");
	const entry = (kind: CalendarEntry["kind"], status: string, at: string) => ({ kind, status, at });

	it("derives each state, waiting out the grace period before Overdue", () => {
		expect(calendarState(entry("published", "published", "2026-10-15T09:00:00.000Z"), now)).toBe(
			"published",
		);
		expect(calendarState(entry("scheduled", "scheduled", "2026-10-16T09:00:00.000Z"), now)).toBe(
			"scheduled",
		);
		expect(calendarState(entry("scheduled", "published", "2026-10-16T09:00:00.000Z"), now)).toBe(
			"update",
		);
		expect(calendarState(entry("scheduled", "scheduled", "2026-10-15T11:59:00.000Z"), now)).toBe(
			"scheduled",
		);
		expect(calendarState(entry("scheduled", "published", "2026-10-15T11:57:00.000Z"), now)).toBe(
			"overdue",
		);
	});
});

describe("parseCalendarSearch", () => {
	it("keeps a known view and a month from 1970 to 9999", () => {
		expect(parseCalendarSearch({ view: "agenda", month: "2026-10" })).toMatchObject({
			view: "agenda",
			month: "2026-10",
		});
		expect(parseCalendarSearch({ view: "month", month: "9999-12" })).toMatchObject({
			view: "month",
			month: "9999-12",
		});
	});

	it("splits, de-duplicates, and bounds list params, keeping only known states", () => {
		const many = Array.from({ length: 60 }, (_, index) => `c${index}`).join(",");

		expect(
			parseCalendarSearch({
				collections: " posts, pages,posts,,",
				locales: `en,${"x".repeat(65)}`,
				states: "overdue,bogus,published",
			}),
		).toMatchObject({ collections: "posts,pages", locales: "en", states: "overdue,published" });
		expect(parseCalendarSearch({ collections: many }).collections?.split(",")).toHaveLength(50);
		expect(parseCalendarSearch({ states: "bogus", collections: 42 })).toMatchObject({
			states: undefined,
			collections: undefined,
		});
	});

	it("drops unknown views and invalid months", () => {
		for (const month of ["2026-13", "2026-00", "1969-12", "0099-01", "2026-1", 202610]) {
			expect(parseCalendarSearch({ view: "week", month })).toMatchObject({
				view: undefined,
				month: undefined,
			});
		}
	});
});

describe("filterItems", () => {
	const now = Date.parse("2026-10-15T12:00:00.000Z");
	const items = toCalendarItems(
		[
			{
				collection: "posts",
				id: "a",
				locale: "en",
				title: "A",
				status: "published",
				kind: "published",
				at: "2026-10-01T09:00:00.000Z",
			},
			{
				collection: "posts",
				id: "b",
				locale: "fr",
				title: "B",
				status: "scheduled",
				kind: "scheduled",
				at: "2026-10-20T09:00:00.000Z",
			},
			{
				collection: "pages",
				id: "c",
				locale: "fr",
				title: "C",
				status: "published",
				kind: "published",
				at: "2026-10-02T09:00:00.000Z",
			},
		],
		{ timeZone: "UTC", now, collectionOrder: ["posts", "pages"] },
	);
	const ids = (list: typeof items) => list.map((item) => item.id);

	it("combines filters and treats an empty filter as all", () => {
		expect(ids(filterItems(items, { collections: [], locales: [], states: [] }))).toEqual([
			"a",
			"c",
			"b",
		]);
		expect(
			ids(filterItems(items, { collections: ["posts"], locales: ["fr"], states: [] })),
		).toEqual(["b"]);
		expect(
			ids(filterItems(items, { collections: [], locales: ["fr"], states: ["published"] })),
		).toEqual(["c"]);
	});
});

describe("fetchCalendarRange", () => {
	const originalFetch = globalThis.fetch;
	const entry = (id: string): CalendarEntry => ({
		collection: "posts",
		id,
		locale: "en",
		title: id,
		status: "published",
		kind: "published",
		at: "2026-10-01T09:00:00.000Z",
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("stops after ten pages and drops entries that repeat across pages", async () => {
		let page = 0;
		const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
			page += 1;
			return Response.json({
				success: true,
				data: { items: [entry("repeated"), entry(`page-${page}`)], nextCursor: `cursor-${page}` },
			});
		});
		globalThis.fetch = fetchSpy;

		const result = await fetchCalendarRange("2026-09-26T10:00:00.000Z", "2026-11-01T14:00:00.000Z");

		expect(fetchSpy).toHaveBeenCalledTimes(10);
		expect(fetchSpy.mock.calls[1]?.[0]).toEqual(expect.stringContaining("cursor=cursor-1"));
		expect(result.truncated).toBe(true);
		expect(result.items.map((item) => item.id)).toEqual([
			"repeated",
			...Array.from({ length: 10 }, (_, index) => `page-${index + 1}`),
		]);
	});

	it("reports a complete walk when the last page has no cursor", async () => {
		const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({ success: true, data: { items: [entry("only")] } }),
		);
		globalThis.fetch = fetchSpy;

		const result = await fetchCalendarRange("2026-09-26T10:00:00.000Z", "2026-11-01T14:00:00.000Z");

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ items: [entry("only")], truncated: false });
	});
});
