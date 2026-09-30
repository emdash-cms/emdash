import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { calendarQueryOptions, type CalendarEntry } from "../../src/lib/api/calendar";
import { fetchRange, monthGridDays } from "../../src/lib/calendar";
import { CalendarPage } from "../../src/routes/calendar";
import { render } from "../utils/render.tsx";

const router = vi.hoisted(() => ({ search: {} as Record<string, unknown> }));

vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual("@tanstack/react-router")),
	useSearch: () => router.search,
	useNavigate: () => vi.fn(),
	Link: ({ children, params: _params, search: _search, to: _to, ...props }: any) => (
		<a href="#entry" {...props}>
			{children}
		</a>
	),
}));

vi.mock("../../src/lib/api/client.js", async () => ({
	...(await vi.importActual("../../src/lib/api/client.js")),
	fetchManifest: vi.fn().mockResolvedValue({
		timezone: "UTC",
		collections: {
			posts: { label: "Posts" },
			pages: { label: "Pages" },
		},
		i18n: { defaultLocale: "en", locales: ["en", "fr"] },
	}),
}));

const originalFetch = globalThis.fetch;

function entry(id: string, at: string): CalendarEntry {
	return {
		collection: "posts",
		id,
		locale: "en",
		title: `Entry ${id}`,
		status: "published",
		kind: "published",
		at,
	};
}

/** Serves calendar pages; `respond` gets the 1-based number of the request. */
function serveCalendar(respond: (request: number) => Response) {
	let request = 0;
	globalThis.fetch = vi.fn(async () => respond(++request));
}

describe("CalendarPage", () => {
	beforeEach(() => {
		router.search = {};
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await page.viewport(1280, 800);
	});

	it("ignores filters in the URL that match no collection or locale", async () => {
		router.search = { month: "2020-03", view: "agenda", collections: "gone", locales: "xx" };
		serveCalendar(() =>
			Response.json({ data: { items: [entry("launch", "2020-03-05T09:00:00.000Z")] } }),
		);

		const screen = await render(<CalendarPage />);

		await expect.element(screen.getByRole("link", { name: /Entry launch/ })).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Collection: All collections" }))
			.toBeVisible();
	});

	it("says where a range cut off at the entry cap ends", async () => {
		router.search = { month: "2020-03", view: "agenda" };
		serveCalendar((request) =>
			Response.json({
				data: {
					items: [
						entry(`day-${request}`, `2020-03-${String(request).padStart(2, "0")}T09:00:00.000Z`),
					],
					nextCursor: `cursor-${request}`,
				},
			}),
		);

		const screen = await render(<CalendarPage />);

		await expect
			.element(screen.getByText("The calendar shows the first 1,000, which end on March 10."))
			.toBeVisible();
		await expect.element(screen.getByText(/^Later entries weren't loaded\./)).toBeVisible();
		await expect
			.element(screen.getByRole("list", { name: "Entries this month" }))
			.not.toBeInTheDocument();
	});

	it("judges schedules by when the entries loaded, not by the current time", async () => {
		router.search = { month: "2020-03", view: "agenda" };
		const range = fetchRange(monthGridDays("2020-03", 0));
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			calendarQueryOptions(range.from, range.to).queryKey,
			{
				items: [
					{
						...entry("launch", "2020-03-05T09:00:30.000Z"),
						status: "scheduled",
						kind: "scheduled",
					},
				],
				truncated: false,
			},
			{ updatedAt: Date.parse("2020-03-05T09:00:00.000Z") },
		);
		// The refresh never completes, so the page keeps the entries loaded before the schedule's time.
		globalThis.fetch = vi.fn(() => new Promise<Response>(() => {}));

		const screen = await render(<CalendarPage />, {
			wrapper: ({ children }) => (
				<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
			),
		});

		await expect.element(screen.getByRole("link", { name: /Entry launch/ })).toBeVisible();
		expect(screen.getByText(/Overdue/).query()).toBeNull();
	});

	it("explains a permission error", async () => {
		serveCalendar(() =>
			Response.json(
				{ error: { code: "FORBIDDEN", message: "Insufficient permissions" } },
				{ status: 403 },
			),
		);

		const screen = await render(<CalendarPage />);

		await expect
			.element(screen.getByText("You don't have permission to view the calendar."))
			.toBeVisible();
	});

	it("opens the agenda on a narrow screen", async () => {
		await page.viewport(375, 800);
		router.search = { month: "2020-03" };
		serveCalendar(() =>
			Response.json({ data: { items: [entry("launch", "2020-03-05T09:00:00.000Z")] } }),
		);

		const screen = await render(<CalendarPage />);

		await expect
			.element(screen.getByRole("tab", { name: "Agenda" }))
			.toHaveAttribute("aria-selected", "true");
		await expect
			.element(screen.getByRole("list", { name: "Thursday, March 5, 2020" }))
			.toBeVisible();
	});
});
