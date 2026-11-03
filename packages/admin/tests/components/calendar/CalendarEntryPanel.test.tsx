import { Toast } from "@cloudflare/kumo";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEntry } from "../../../src/lib/api/calendar";
import {
	fetchContent,
	publishContent,
	unscheduleContent,
	type ContentItem,
} from "../../../src/lib/api/content";
import type { CurrentUser } from "../../../src/lib/api/current-user";
import { createCalendarDisplay, toCalendarItems } from "../../../src/lib/calendar";
import { render } from "../../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual("@tanstack/react-router")),
	Link: ({ children, params: _params, search: _search, to: _to, ...props }: any) => (
		<a href="#editor" {...props}>
			{children}
		</a>
	),
}));

vi.mock("../../../src/lib/api/content", async () => ({
	...(await vi.importActual("../../../src/lib/api/content")),
	fetchContent: vi.fn(),
	fetchTranslations: vi.fn().mockResolvedValue({ translationGroup: "group", translations: [] }),
	publishContent: vi.fn(),
	scheduleContent: vi.fn(),
	unscheduleContent: vi.fn(),
	getPreviewUrl: vi.fn().mockResolvedValue(null),
}));

const { CalendarEntryPanel } = await import("../../../src/components/calendar/CalendarEntryPanel");

const now = Date.parse("2026-10-15T12:00:00.000Z");
const display = createCalendarDisplay({
	locale: "en",
	timeZone: "UTC",
	viewerTimeZone: "UTC",
	collections: [{ slug: "posts", label: "Posts" }],
	showLocale: false,
});

function scheduledItem(at: string) {
	const entry: CalendarEntry = {
		collection: "posts",
		id: "launch",
		locale: "en",
		title: "Launch",
		status: "scheduled",
		kind: "scheduled",
		at,
	};
	return toCalendarItems([entry], {
		timeZone: "UTC",
		loadedAt: now,
		collectionOrder: ["posts"],
	})[0]!;
}

function details(authorId: string): ContentItem {
	return {
		id: "launch",
		type: "posts",
		slug: "launch",
		status: "scheduled",
		locale: "en",
		translationGroup: null,
		data: { title: "Launch" },
		authorId,
		primaryBylineId: null,
		bylines: [
			{
				byline: { displayName: "Maya Chen" } as NonNullable<ContentItem["byline"]>,
				sortOrder: 0,
				roleLabel: null,
			},
		],
		createdAt: "2026-10-01T09:00:00.000Z",
		updatedAt: "2026-10-15T09:00:00.000Z",
		publishedAt: null,
		scheduledAt: "2026-10-20T09:00:00.000Z",
		liveRevisionId: null,
		draftRevisionId: null,
		_rev: "rev-1",
	};
}

function renderPanel(item: ReturnType<typeof scheduledItem>, user: CurrentUser) {
	const onClose = vi.fn();
	const screen = render(
		<CalendarEntryPanel
			item={item}
			display={display}
			now={now}
			compact={false}
			i18n={undefined}
			urlPatterns={{}}
			user={user}
			onClose={onClose}
			onRescheduled={() => {}}
		/>,
		{ wrapper: Toast.Provider },
	);
	return { screen, onClose };
}

const editor: CurrentUser = { id: "editor", email: "editor@example.com", role: 40 };

describe("CalendarEntryPanel", () => {
	beforeEach(() => {
		vi.mocked(fetchContent).mockResolvedValue(details("someone-else"));
		vi.mocked(publishContent).mockResolvedValue(details("someone-else"));
		vi.mocked(unscheduleContent).mockResolvedValue(details("someone-else"));
	});

	it("shows a schedule's details and lets an editor remove it", async () => {
		const { screen, onClose } = renderPanel(scheduledItem("2026-10-20T09:00:00.000Z"), editor);
		const panel = (await screen).getByRole("dialog", { name: "Launch" });

		await expect.element(panel.getByText("Tue, Oct 20, 9:00 AM UTC").first()).toBeVisible();
		await expect.element(panel.getByText("Maya Chen")).toBeVisible();
		await expect.element(panel.getByText("Goes live in 5 days")).toBeVisible();

		await panel.getByRole("button", { name: "Remove schedule" }).click();

		await expect.poll(() => onClose.mock.calls.length).toBe(1);
		expect(unscheduleContent).toHaveBeenCalledWith("posts", "launch", { locale: "en" });
	});

	it("publishes an overdue schedule now with the revision it loaded", async () => {
		const author: CurrentUser = { id: "author", email: "author@example.com", role: 30 };
		vi.mocked(fetchContent).mockResolvedValue(details("author"));
		const { screen } = renderPanel(scheduledItem("2026-10-15T11:00:00.000Z"), author);
		const panel = (await screen).getByRole("dialog", { name: "Launch" });

		await expect.element(panel.getByText(/was due 1 hour ago/)).toBeVisible();
		await panel.getByRole("button", { name: "Publish now" }).click();

		await expect
			.poll(() => vi.mocked(publishContent).mock.calls[0])
			.toEqual(["posts", "launch", { locale: "en", _rev: "rev-1" }]);
	});

	it("keeps publishing actions from roles that can't publish the entry", async () => {
		const contributor: CurrentUser = { id: "contributor", email: "c@example.com", role: 20 };
		const { screen } = renderPanel(scheduledItem("2026-10-15T11:00:00.000Z"), contributor);
		const panel = (await screen).getByRole("dialog", { name: "Launch" });

		await expect.element(panel.getByText("Maya Chen")).toBeVisible();
		await expect.element(panel.getByRole("link", { name: "Open in editor" })).toBeVisible();
		expect(panel.getByRole("button", { name: "Publish now" }).query()).toBeNull();
		expect(panel.getByRole("button", { name: "Reschedule" }).query()).toBeNull();
		expect(panel.getByRole("button", { name: "Remove schedule" }).query()).toBeNull();
	});
});
