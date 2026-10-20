import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
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

const EDITOR = { id: "editor", email: "editor@example.com", role: 40 };
const currentUser = vi.hoisted(() => ({ value: { id: "", email: "", role: 0 } }));

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: currentUser.value }),
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

/** Renders the page at the window's height, as the admin shell does. */
function renderPage(wrapper?: React.ComponentType<React.PropsWithChildren>) {
	const Inner = wrapper ?? React.Fragment;
	return render(<CalendarPage />, {
		wrapper: ({ children }) => (
			<Toasty>
				<Inner>
					<div style={{ height: "100vh" }}>{children}</div>
				</Inner>
			</Toasty>
		),
	});
}

describe("CalendarPage", () => {
	beforeEach(() => {
		currentUser.value = EDITOR;
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

	describe("dragging an entry", () => {
		let launch: CalendarEntry;
		let schedules: unknown[];
		let refuse: boolean;
		let calendarLoads: number;

		beforeEach(async () => {
			await page.viewport(1440, 900);
			launch = {
				...entry("launch", "2030-03-05T09:00:00.000Z"),
				status: "scheduled",
				kind: "scheduled",
				authorId: "someone",
			};
			schedules = [];
			refuse = false;
			calendarLoads = 0;
			router.search = { month: "2030-03", view: "month" };
			globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : input.toString();
				if (url.includes("/calendar?")) {
					// After a refused move, only the rollback can put the entry back: reloads never finish.
					if (refuse && ++calendarLoads > 1) return new Promise<Response>(() => {});
					return Response.json({ data: { items: [launch] } });
				}
				if (url.includes("/content/posts/launch/schedule")) {
					schedules.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
					return refuse
						? Response.json(
								{ error: { code: "CONFLICT", message: "Someone else is editing this entry" } },
								{ status: 409 },
							)
						: Response.json({ data: { item: { id: "launch" } } });
				}
				return Response.json(
					{ error: { code: "NOT_FOUND", message: "Not found" } },
					{ status: 404 },
				);
			});
		});

		const dayCell = (screen: Awaited<ReturnType<typeof renderPage>>, day: string) =>
			screen.getByRole("cell").filter({ hasText: new RegExp(`^${day}$`) });

		it("reschedules it to the day it's dropped on, at the same time", async () => {
			const screen = await renderPage();
			const chip = screen.getByRole("link", { name: /Entry launch/ });
			await expect.element(chip).toBeVisible();

			await userEvent.dragAndDrop(chip, dayCell(screen, "12"), { steps: 10 });

			await expect.poll(() => schedules).toEqual([{ scheduledAt: "2030-03-12T09:00:00.000Z" }]);
			// The drop doesn't also open the entry.
			expect(router.navigate).not.toHaveBeenCalled();
			await expect
				.element(page.getByText("Entry launch was dropped on Tuesday, March 12, 2030."))
				.toBeInTheDocument();
		});

		it("puts the entry back when the server refuses the move", async () => {
			refuse = true;
			const screen = await renderPage();
			const chip = screen.getByRole("link", { name: /Entry launch/ });
			await expect.element(chip).toBeVisible();

			await userEvent.dragAndDrop(chip, dayCell(screen, "12"), { steps: 10 });

			await expect.poll(() => schedules).toHaveLength(1);
			await expect
				.element(
					screen
						.getByRole("list", { name: "Tuesday, March 5, 2030" })
						.getByRole("link", { name: /Entry launch/ }),
				)
				.toBeVisible();
		});

		it("moves it back when the move is undone", async () => {
			const screen = await renderPage();
			const chip = screen.getByRole("link", { name: /Entry launch/ });
			await expect.element(chip).toBeVisible();

			await userEvent.dragAndDrop(chip, dayCell(screen, "12"), { steps: 10 });
			await page.getByRole("button", { name: "Undo" }).click();

			await expect
				.poll(() => schedules)
				.toEqual([
					{ scheduledAt: "2030-03-12T09:00:00.000Z" },
					{ scheduledAt: "2030-03-05T09:00:00.000Z" },
				]);
		});

		it("leaves other moves in place when one is refused", async () => {
			const notes = {
				...launch,
				id: "notes",
				title: "Entry notes",
				at: "2030-03-06T09:00:00.000Z",
			};
			let refuseLaunch: (() => void) | undefined;
			let loads = 0;
			globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
				const url = input instanceof Request ? input.url : input.toString();
				// Reloads never finish, so only the moves themselves place the entries.
				if (url.includes("/calendar?")) {
					if (++loads > 1) return new Promise<Response>(() => {});
					return Response.json({ data: { items: [launch, notes] } });
				}
				if (url.includes("/content/posts/launch/schedule")) {
					return new Promise<Response>((resolve) => {
						refuseLaunch = () =>
							resolve(
								Response.json(
									{ error: { code: "CONFLICT", message: "Someone else is editing this entry" } },
									{ status: 409 },
								),
							);
					});
				}
				// The other move is still on its way.
				return new Promise<Response>(() => {});
			});
			const screen = await renderPage();
			const chip = screen.getByRole("link", { name: /Entry launch/ });
			await expect.element(chip).toBeVisible();

			await userEvent.dragAndDrop(chip, dayCell(screen, "12"), { steps: 10 });
			await userEvent.dragAndDrop(
				screen.getByRole("link", { name: /Entry notes/ }),
				dayCell(screen, "13"),
				{ steps: 10 },
			);
			await expect.poll(() => refuseLaunch).toBeTypeOf("function");
			refuseLaunch?.();

			await expect
				.element(
					screen
						.getByRole("list", { name: "Tuesday, March 5, 2030" })
						.getByRole("link", { name: /Entry launch/ }),
				)
				.toBeVisible();
			await expect
				.element(
					screen
						.getByRole("list", { name: "Wednesday, March 13, 2030" })
						.getByRole("link", { name: /Entry notes/ }),
				)
				.toBeVisible();
		});

		it("leaves another author's entry where it is for an author", async () => {
			currentUser.value = { id: "author", email: "author@example.com", role: 30 };
			const screen = await renderPage();
			const chip = screen.getByRole("link", { name: /Entry launch/ });
			await expect.element(chip).toBeVisible();

			await userEvent.dragAndDrop(chip, dayCell(screen, "12"), { steps: 10 });
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(schedules).toEqual([]);
		});
	});

	it("moves between months and views with letter keys, but not while typing", async () => {
		await page.viewport(1440, 900);
		router.search = { month: "2030-03", view: "month" };
		serveCalendar(() => Response.json({ data: { items: [] } }));
		const screen = await renderPage(({ children }) => (
			<>
				<input aria-label="Notes" />
				{children}
			</>
		));
		await expect.element(screen.getByRole("heading", { name: "March 2030" })).toBeVisible();

		await userEvent.keyboard("j");
		expect(navigatedSearch(router.navigate.mock.lastCall).search).toMatchObject({
			month: "2030-04",
		});
		// On Dvorak, the key labelled K sits where QWERTY has V.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyV" }));
		expect(navigatedSearch(router.navigate.mock.lastCall).search).toMatchObject({
			month: "2030-02",
		});
		await userEvent.keyboard("a");
		expect(navigatedSearch(router.navigate.mock.lastCall).search).toMatchObject({ view: "agenda" });

		router.navigate.mockClear();
		await screen.getByLabelText("Notes").click();
		await userEvent.keyboard("ja");
		await expect.element(screen.getByLabelText("Notes")).toHaveValue("ja");
		expect(router.navigate).not.toHaveBeenCalled();
	});

	it("keeps the month beside the panel on a wide screen", async () => {
		await page.viewport(1440, 900);
		router.search = { month: "2020-03", view: "month", entry: "posts:launch:published" };
		serveCalendar(() =>
			Response.json({ data: { items: [entry("launch", "2020-03-05T09:00:00.000Z")] } }),
		);
		const screen = await renderPage();

		const panel = screen.getByRole("dialog", { name: "Entry launch" });
		await expect.element(panel).toBeVisible();
		const table = screen.getByRole("table");
		await expect
			.poll(
				() =>
					panel.element().getBoundingClientRect().left -
					table.element().getBoundingClientRect().right,
			)
			.toBeGreaterThanOrEqual(0);
		await expect.element(screen.getByRole("button", { name: "Next month" })).toBeVisible();
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

	it("switches entries from the calendar and closes the panel from empty space", async () => {
		router.search = { month: "2020-03", view: "agenda" };
		serveCalendar(() =>
			Response.json({
				data: {
					items: [
						entry("launch", "2020-03-05T09:00:00.000Z"),
						entry("recap", "2020-03-06T09:00:00.000Z"),
					],
				},
			}),
		);
		const screen = await renderPage();

		await screen.getByRole("link", { name: /Entry launch/ }).click();
		router.search = navigatedSearch(router.navigate.mock.lastCall).search;
		await screen.rerender(<CalendarPage />);
		await expect.element(screen.getByRole("dialog", { name: "Entry launch" })).toBeVisible();

		await screen.getByRole("link", { name: /Entry recap/ }).click();
		expect(navigatedSearch(router.navigate.mock.lastCall)).toMatchObject({
			replace: true,
			search: { entry: "posts:recap:published" },
		});
		expect(router.back).not.toHaveBeenCalled();

		await screen.getByRole("heading", { name: "March 2020" }).click();
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
