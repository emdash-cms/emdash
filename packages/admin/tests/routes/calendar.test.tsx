import { Toast } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { calendarQueryOptions, type CalendarEntry } from "../../src/lib/api/calendar";
import { fetchRange, monthGridDays } from "../../src/lib/calendar";
import { CalendarPage } from "../../src/routes/calendar";
import { render } from "../utils/render.tsx";

const router = vi.hoisted(() => ({
	search: {} as Record<string, unknown>,
	navigate: vi.fn(),
	back: vi.fn(),
}));

vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual("@tanstack/react-router")),
	useSearch: () => router.search,
	useNavigate: () => router.navigate,
	useRouter: () => ({ history: { back: router.back } }),
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

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "editor", email: "editor@example.com", role: 40 } }),
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

/** Serves calendar pages; `respond` gets the 1-based number of the calendar request. Other requests fail. */
function serveCalendar(respond: (request: number) => Response) {
	let request = 0;
	globalThis.fetch = vi.fn(async (input: string | URL | Request) =>
		(input instanceof Request ? input.url : input.toString()).includes("/calendar?")
			? respond(++request)
			: Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 }),
	);
}

function renderPage(wrapper?: React.ComponentType<React.PropsWithChildren>) {
	const Inner = wrapper ?? React.Fragment;
	return render(<CalendarPage />, {
		wrapper: ({ children }) => (
			<Toast.Provider>
				<Inner>{children}</Inner>
			</Toast.Provider>
		),
	});
}

describe("CalendarPage", () => {
	beforeEach(() => {
		router.search = {};
		router.navigate.mockReset();
		router.back.mockReset();
	});

	/** The search a navigate call would produce from the current one. */
	function navigatedSearch(call: unknown[] | undefined) {
		const options = call?.[0] as {
			replace?: boolean;
			search: (previous: Record<string, unknown>) => Record<string, unknown>;
		};
		return { replace: options.replace, search: options.search(router.search) };
	}

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await page.viewport(1280, 800);
	});

	it("ignores filters in the URL that match no collection or locale", async () => {
		router.search = { month: "2020-03", view: "agenda", collections: "gone", locales: "xx" };
		serveCalendar(() =>
			Response.json({ data: { items: [entry("launch", "2020-03-05T09:00:00.000Z")] } }),
		);

		const screen = await renderPage();

		await expect.element(screen.getByRole("link", { name: /Entry launch/ })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Filter", exact: true })).toBeVisible();
	});

	it("says when filters hide every entry in the month grid", async () => {
		router.search = { month: "2020-03", view: "month", states: "scheduled" };
		serveCalendar(() =>
			Response.json({ data: { items: [entry("launch", "2020-03-05T09:00:00.000Z")] } }),
		);

		const screen = await renderPage();

		await expect.element(screen.getByText("No entries match these filters")).toBeVisible();
		await screen.getByRole("button", { name: "Clear filters" }).click();
		expect(navigatedSearch(router.navigate.mock.lastCall).search).toMatchObject({
			collections: undefined,
			locales: undefined,
			states: undefined,
		});
		await expect.element(screen.getByRole("button", { name: "Filter: 1 selected" })).toHaveFocus();
	});

	it("counts only the month's own days on a phone, where the picker hides the rest", async () => {
		await page.viewport(375, 800);
		router.search = { month: "2020-03", view: "month", states: "published" };
		serveCalendar(() =>
			Response.json({ data: { items: [entry("april", "2020-04-02T09:00:00.000Z")] } }),
		);

		const screen = await renderPage();

		await expect.element(screen.getByText("No entries match these filters")).toBeVisible();
	});

	it("opens the entry named in the URL in the side panel", async () => {
		router.search = { month: "2020-03", view: "agenda", entry: "posts:launch:published" };
		serveCalendar(() =>
			Response.json({ data: { items: [entry("launch", "2020-03-05T09:00:00.000Z")] } }),
		);

		const screen = await renderPage();

		const panel = screen.getByRole("dialog", { name: "Entry launch" });
		await expect.element(panel).toBeVisible();
		await expect.element(panel.getByText("Thu, Mar 5, 9:00 AM UTC").first()).toBeVisible();
		await expect.element(panel.getByRole("link", { name: "Open in editor" })).toBeVisible();

		// The panel came from the link, not from a history entry this page added.
		await panel.getByRole("button", { name: "Close" }).click();
		expect(router.back).not.toHaveBeenCalled();
		expect(navigatedSearch(router.navigate.mock.lastCall)).toMatchObject({
			replace: true,
			search: { entry: undefined },
		});
	});

	it("adds a history entry for the panel and goes back to close it", async () => {
		router.search = { month: "2020-03", view: "agenda" };
		serveCalendar(() =>
			Response.json({ data: { items: [entry("launch", "2020-03-05T09:00:00.000Z")] } }),
		);
		const screen = await renderPage();

		await screen.getByRole("link", { name: /Entry launch/ }).click();
		const opened = navigatedSearch(router.navigate.mock.lastCall);
		expect(opened).toMatchObject({ replace: false, search: { entry: "posts:launch:published" } });

		router.search = opened.search;
		await screen.rerender(<CalendarPage />);
		await screen
			.getByRole("dialog", { name: "Entry launch" })
			.getByRole("button", { name: "Close" })
			.click();

		expect(router.back).toHaveBeenCalledTimes(1);
	});

	it("keeps the panel while another month loads and closes it if the entry isn't there", async () => {
		const key = "posts:launch:published";
		const april = fetchRange(monthGridDays("2020-04", 0)).from;
		let resolveApril: (response: Response) => void = () => {};
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input.toString(), location.origin);
			if (!url.pathname.endsWith("/calendar")) {
				return Response.json(
					{ error: { code: "NOT_FOUND", message: "Not found" } },
					{ status: 404 },
				);
			}
			if (url.searchParams.get("from") === april) {
				return new Promise<Response>((resolve) => {
					resolveApril = resolve;
				});
			}
			return Response.json({ data: { items: [entry("launch", "2020-03-05T09:00:00.000Z")] } });
		});
		router.search = { month: "2020-03", view: "agenda", entry: key };
		const screen = await renderPage();
		await expect.element(screen.getByRole("dialog", { name: "Entry launch" })).toBeVisible();

		router.search = { month: "2020-04", view: "agenda", entry: key };
		await screen.rerender(<CalendarPage />);
		await expect.poll(() => vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(1);

		// A closing panel stays visible while it slides out, so check that it is still open.
		await expect
			.element(screen.getByRole("dialog", { name: "Entry launch" }))
			.toHaveAttribute("data-open");
		expect(router.navigate).not.toHaveBeenCalled();

		resolveApril(Response.json({ data: { items: [] } }));

		await expect
			.poll(() => router.navigate.mock.lastCall && navigatedSearch(router.navigate.mock.lastCall))
			.toMatchObject({ replace: true, search: { entry: undefined } });
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

		const screen = await renderPage();

		await expect
			.element(screen.getByText("The calendar shows the first 1,000, which end on March 10."))
			.toBeVisible();
		await expect.element(screen.getByText(/^Later entries weren't loaded\./)).toBeVisible();
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

		const screen = await renderPage(({ children }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		));

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

		const screen = await renderPage();

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

		const screen = await renderPage();

		await expect
			.element(screen.getByRole("tab", { name: "Agenda" }))
			.toHaveAttribute("aria-selected", "true");
		await expect
			.element(screen.getByRole("list", { name: "Thursday, March 5, 2020" }))
			.toBeVisible();
	});
});
