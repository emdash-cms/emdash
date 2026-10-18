import * as React from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { RevisionHistory } from "../../src/components/RevisionHistory";
import {
	REVISION_LIST_LIMIT,
	REVISION_LIST_LIMIT_ALL,
} from "../../src/components/revisions/revision-query.js";
import {
	RevisionViewProvider,
	type RevisionViewContextValue,
} from "../../src/components/revisions/revision-view-context.js";
import type { RevisionListItem, RevisionListResponse } from "../../src/lib/api";
import type { ChangeItem, RevisionDiff } from "../../src/lib/revision-diff/types.js";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return { ...actual, fetchRevisions: vi.fn() };
});

import { fetchRevisions } from "../../src/lib/api";

const mockFetchRevisions = fetchRevisions as Mock;

const REVISIONS_TRIGGER = /^Revisions/;
const MAYA_ROW = /^Today, 12:00\sPM, Current version, Maya Chen$/;
const SAM_ROW = /^Yesterday, 11:30\sPM, Published, Sam Okafor$/;
const UNKNOWN_ROW = /^Yesterday, 10:00\sAM, Unknown author$/;
const RESTORED_FROM_YESTERDAY = /^Restored the version from \u2068Yesterday, 10:00\sAM\u2069$/;

/** A SQLite timestamp (UTC, no zone) for a local wall-clock time `daysAgo` days back. */
function localTimestamp(daysAgo: number, hours: number, minutes: number): string {
	const now = new Date();
	const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hours, minutes);
	return date.toISOString().replace("T", " ").slice(0, 19);
}

function makeRevision(overrides: Partial<RevisionListItem> = {}): RevisionListItem {
	return {
		id: "rev-1",
		collection: "posts",
		entryId: "entry-1",
		data: { title: "Hello World" },
		authorId: "u-maya",
		author: { id: "u-maya", name: "Maya Chen" },
		createdAt: localTimestamp(0, 12, 0),
		...overrides,
	};
}

// Yesterday 11:30 PM in New York is already today in UTC, so grouping by UTC date would misfile it.
const threeVersions: RevisionListResponse = {
	items: [
		makeRevision({ id: "rev-3" }),
		makeRevision({
			id: "rev-2",
			authorId: "u-sam",
			author: { id: "u-sam", name: "Sam Okafor" },
			createdAt: localTimestamp(1, 23, 30),
		}),
		makeRevision({
			id: "rev-1",
			authorId: "u-gone",
			author: null,
			createdAt: localTimestamp(1, 10, 0),
		}),
	],
	total: 3,
};

function makeView(overrides: Partial<RevisionViewContextValue> = {}): RevisionViewContextValue {
	return {
		viewingId: null,
		viewingDiff: null,
		currentRevisionId: "rev-3",
		liveRevisionId: "rev-2",
		fields: { title: { kind: "string", label: "Title" } },
		rowToFocus: null,
		clearRowToFocus: vi.fn(),
		listLimit: REVISION_LIST_LIMIT,
		showOlderVersions: vi.fn(),
		view: vi.fn(),
		exit: vi.fn(),
		goToChange: vi.fn(),
		...overrides,
	};
}

function makeDiff(changes: ChangeItem[]): RevisionDiff {
	return { hasPrevious: true, fields: [], slug: null, changes };
}

async function renderExpanded(view: RevisionViewContextValue | null) {
	const history = <RevisionHistory collection="posts" entryId="entry-1" reserveHeaderEnd />;
	const screen = await render(
		view ? <RevisionViewProvider value={view}>{history}</RevisionViewProvider> : history,
	);
	await screen.getByRole("button", { name: REVISIONS_TRIGGER }).click();
	return screen;
}

beforeEach(() => {
	vi.resetAllMocks();
	mockFetchRevisions.mockResolvedValue(threeVersions);
});

describe("RevisionHistory", () => {
	it("does not fetch until expanded", async () => {
		const screen = await render(
			<RevisionViewProvider value={makeView()}>
				<RevisionHistory collection="posts" entryId="entry-1" />
			</RevisionViewProvider>,
		);
		expect(mockFetchRevisions).not.toHaveBeenCalled();

		await screen.getByRole("button", { name: REVISIONS_TRIGGER }).click();

		await expect.element(screen.getByRole("button", { name: MAYA_ROW })).toBeInTheDocument();
		await expect.element(screen.getByText("(3)")).toBeInTheDocument();
	});

	it("groups versions by local day with their status and author", async () => {
		const screen = await renderExpanded(makeView());

		const today = screen.getByRole("list", { name: "Today" });
		const yesterday = screen.getByRole("list", { name: "Yesterday" });
		await expect.element(today.getByRole("button", { name: MAYA_ROW })).toBeInTheDocument();
		await expect.element(yesterday.getByRole("button", { name: SAM_ROW })).toBeInTheDocument();
		await expect.element(yesterday.getByRole("button", { name: UNKNOWN_ROW })).toBeInTheDocument();
		await expect.element(screen.getByText("Current version", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("Published", { exact: true })).toBeVisible();
	});

	it("says which version a restored copy came from", async () => {
		mockFetchRevisions.mockResolvedValue({
			items: [
				makeRevision({ id: "rev-3", data: { title: "First draft" } }),
				makeRevision({ id: "rev-2", data: { title: "Second draft" } }),
				makeRevision({
					id: "rev-1",
					data: { title: "First draft" },
					createdAt: localTimestamp(1, 10, 0),
				}),
			],
			total: 3,
		});
		const screen = await renderExpanded(makeView({ liveRevisionId: null }));

		await expect
			.element(
				screen.getByRole("button", {
					name: /^Today, 12:00\sPM, Current version, Maya Chen, Restored from \u2068Yesterday, 10:00\sAM\u2069$/,
				}),
			)
			.toBeInTheDocument();
		expect(screen.getByText(/^Restored from/).elements()).toHaveLength(1);
	});

	it("doesn't repeat which version a restored copy came from in its changes", async () => {
		mockFetchRevisions.mockResolvedValue({
			items: [
				makeRevision({ id: "rev-3", data: { title: "First draft" } }),
				makeRevision({ id: "rev-2", data: { title: "Second draft" } }),
				makeRevision({
					id: "rev-1",
					data: { title: "First draft" },
					createdAt: localTimestamp(1, 10, 0),
				}),
			],
			total: 3,
		});
		const screen = await renderExpanded(
			makeView({
				liveRevisionId: null,
				viewingId: "rev-3",
				viewingDiff: makeDiff([
					{ kind: "restored", revisionId: "rev-1" },
					{ kind: "title", field: { slug: "title", label: "Title" }, target: "f-title" },
				]),
			}),
		);

		const changes = screen.getByRole("list", { name: "Changes in this version" });
		await expect.element(changes.getByRole("button", { name: "Changed the title" })).toBeVisible();
		expect(changes.getByRole("listitem").elements()).toHaveLength(1);
		expect(screen.getByText(/^Restored from/).elements()).toHaveLength(1);
	});

	it("moves focus from the version that was restored to the new current one", async () => {
		const history = <RevisionHistory collection="posts" entryId="entry-1" reserveHeaderEnd />;
		const screen = await renderExpanded(makeView());
		const sam = screen.getByRole("button", { name: SAM_ROW });
		await expect.element(sam).toBeInTheDocument();
		sam.element().focus();

		const clearRowToFocus = vi.fn();
		const rowToFocus = { revisionId: "rev-3", opener: sam.element() as HTMLElement };
		await screen.rerender(
			<RevisionViewProvider value={makeView({ rowToFocus, clearRowToFocus })}>
				{history}
			</RevisionViewProvider>,
		);
		await expect.element(screen.getByRole("button", { name: MAYA_ROW })).toHaveFocus();
		expect(clearRowToFocus).toHaveBeenCalled();
	});

	it("leaves focus where the writer moved it after the restore", async () => {
		const history = <RevisionHistory collection="posts" entryId="entry-1" reserveHeaderEnd />;
		const screen = await renderExpanded(makeView());
		const sam = screen.getByRole("button", { name: SAM_ROW });
		const unknown = screen.getByRole("button", { name: UNKNOWN_ROW });
		await expect.element(unknown).toBeInTheDocument();
		unknown.element().focus();

		const clearRowToFocus = vi.fn();
		const rowToFocus = { revisionId: "rev-3", opener: sam.element() as HTMLElement };
		await screen.rerender(
			<RevisionViewProvider value={makeView({ rowToFocus, clearRowToFocus })}>
				{history}
			</RevisionViewProvider>,
		);
		await vi.waitFor(() => expect(clearRowToFocus).toHaveBeenCalled());
		await expect.element(unknown).toHaveFocus();
	});

	it("names an account without a display name differently from a missing author", async () => {
		mockFetchRevisions.mockResolvedValue({
			items: [
				makeRevision({ id: "rev-2", authorId: "u-anon", author: { id: "u-anon", name: null } }),
				makeRevision({ id: "rev-1", authorId: null, author: null }),
			],
			total: 2,
		});
		const screen = await renderExpanded(
			makeView({ currentRevisionId: null, liveRevisionId: null }),
		);

		await expect
			.element(screen.getByRole("button", { name: /, Unnamed user$/ }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: /, Unknown author$/ }))
			.toBeInTheDocument();
	});

	it("gives each author their own colour and an unknown author the neutral one", async () => {
		const screen = await renderExpanded(makeView());
		const colorOf = async (name: RegExp) => {
			const row = screen.getByRole("button", { name });
			await expect.element(row).toBeInTheDocument();
			return row.element().querySelector("[data-author-color]")?.getAttribute("data-author-color");
		};

		const maya = await colorOf(MAYA_ROW);
		const sam = await colorOf(SAM_ROW);
		expect(maya).not.toBe(sam);
		expect([maya, sam]).not.toContain("neutral");
		expect(await colorOf(UNKNOWN_ROW)).toBe("neutral");
	});

	it("shows a version in the canvas when its row is clicked", async () => {
		const view = makeView();
		const screen = await renderExpanded(view);

		const row = screen.getByRole("button", { name: SAM_ROW });
		await row.click();

		expect(view.view).toHaveBeenCalledWith("rev-2", { opener: row.element() });
	});

	it("marks the version being shown", async () => {
		const view = makeView({ viewingId: "rev-2", viewingDiff: makeDiff([{ kind: "noChanges" }]) });
		const screen = await renderExpanded(view);

		await expect
			.element(screen.getByRole("button", { name: SAM_ROW }))
			.toHaveAttribute("aria-current", "true");
		await expect
			.element(screen.getByRole("button", { name: MAYA_ROW }))
			.not.toHaveAttribute("aria-current");
	});

	it("lists what changed in the version being viewed and jumps to a change", async () => {
		const view = makeView({
			viewingId: "rev-2",
			viewingDiff: makeDiff([
				{ kind: "restored", revisionId: "rev-1" },
				{ kind: "title", field: { slug: "title", label: "Title" }, target: "f-title" },
				{ kind: "slug", after: "hello-world" },
			]),
		});
		const screen = await renderExpanded(view);

		const changes = screen.getByRole("list", { name: "Changes in this version" });
		await expect.element(changes.getByText(RESTORED_FROM_YESTERDAY)).toBeInTheDocument();
		await expect.element(changes.getByText("Changed the slug to", { exact: false })).toBeVisible();
		expect(changes.getByRole("button").elements()).toHaveLength(1);

		await changes.getByRole("button", { name: "Changed the title" }).click();
		expect(view.goToChange).toHaveBeenCalledWith("f-title");
	});

	it("keeps a picked version under the pointer when the changes listed above it close", async () => {
		const changes = ["A", "B", "C", "D", "E"].map(
			(label): ChangeItem => ({
				kind: "field",
				field: { slug: label.toLowerCase(), label: `Field ${label}` },
				target: `f-${label}`,
			}),
		);
		function Picking() {
			const [viewingId, setViewingId] = React.useState("rev-3");
			const view = makeView({
				viewingId,
				viewingDiff: makeDiff(viewingId === "rev-3" ? changes : []),
				view: (revisionId) => setViewingId(revisionId),
			});
			return (
				<div data-testid="scroller" style={{ height: 240, overflowY: "auto" }}>
					<RevisionViewProvider value={view}>
						<RevisionHistory collection="posts" entryId="entry-1" />
					</RevisionViewProvider>
					<div style={{ height: 1000 }} />
				</div>
			);
		}
		const screen = await render(<Picking />);
		await screen.getByRole("button", { name: REVISIONS_TRIGGER }).click();
		await expect.element(screen.getByText("Field E", { exact: false })).toBeVisible();

		const scroller = screen.getByTestId("scroller").element();
		const row = screen.getByRole("button", { name: UNKNOWN_ROW });
		scroller.scrollTop = 200;
		const top = row.element().getBoundingClientRect().top;
		await row.click();

		await expect.element(screen.getByText("Field E", { exact: false })).not.toBeInTheDocument();
		expect(row.element().getBoundingClientRect().top).toBe(top);
	});

	it("shows five changes, then reveals the rest and focuses the first new one", async () => {
		const fields = ["A", "B", "C", "D", "E", "F", "G"].map(
			(label): ChangeItem => ({
				kind: "field",
				field: { slug: label.toLowerCase(), label: `Field ${label}` },
				target: `f-${label}`,
			}),
		);
		const screen = await renderExpanded(
			makeView({ viewingId: "rev-3", viewingDiff: makeDiff(fields) }),
		);

		const changes = screen.getByRole("list", { name: "Changes in this version" });
		await expect.element(changes.getByText("Field E", { exact: false })).toBeInTheDocument();
		await expect.element(changes.getByText("Field F", { exact: false })).not.toBeInTheDocument();

		await changes.getByRole("button", { name: "Show 2 more" }).click();

		const fieldF = changes.getByRole("button", { name: "Field F" });
		await expect.element(fieldF).toHaveFocus();
		await expect.element(changes.getByText("Field G", { exact: false })).toBeInTheDocument();
		await expect
			.element(changes.getByRole("button", { name: "Show 2 more" }))
			.not.toBeInTheDocument();
	});

	it("offers older versions when the list holds back some", async () => {
		const items = Array.from({ length: 21 }, (_, index) =>
			makeRevision({ id: `rev-${30 - index}`, createdAt: localTimestamp(0, 12, 0) }),
		);
		mockFetchRevisions.mockResolvedValue({ items, total: 30 });
		const view = makeView({ currentRevisionId: "rev-30" });
		const screen = await renderExpanded(view);

		const rows = screen.getByRole("list", { name: "Today" }).getByRole("button");
		await expect.poll(() => rows.elements().length).toBe(20);

		await screen.getByRole("button", { name: "Show older versions" }).click();
		expect(view.showOlderVersions).toHaveBeenCalledOnce();
	});

	it("asks for every version and stops offering older ones once they are requested", async () => {
		const items = Array.from({ length: 21 }, (_, index) =>
			makeRevision({ id: `rev-${30 - index}` }),
		);
		mockFetchRevisions.mockResolvedValue({ items, total: 30 });
		const screen = await renderExpanded(makeView({ listLimit: REVISION_LIST_LIMIT_ALL }));

		await expect.element(screen.getByRole("list", { name: "Today" })).toBeInTheDocument();
		expect(mockFetchRevisions).toHaveBeenCalledWith(
			"posts",
			"entry-1",
			expect.objectContaining({ limit: REVISION_LIST_LIMIT_ALL }),
		);
		await expect
			.element(screen.getByRole("button", { name: "Show older versions" }))
			.not.toBeInTheDocument();
	});

	it("lists versions without buttons outside the content editor", async () => {
		const screen = await renderExpanded(null);

		await expect.element(screen.getByText("Maya Chen", { exact: true })).toBeVisible();
		expect(screen.getByRole("button").elements()).toHaveLength(1);
	});

	it("says so when there are no versions yet", async () => {
		mockFetchRevisions.mockResolvedValue({ items: [], total: 0 });
		const screen = await renderExpanded(makeView());

		await expect.element(screen.getByText("No versions yet")).toBeVisible();
	});

	it("offers to try again when the versions can't be loaded", async () => {
		mockFetchRevisions.mockRejectedValueOnce(new Error("Network error"));
		const screen = await renderExpanded(makeView());

		await expect.element(screen.getByText("Couldn't load versions")).toBeVisible();
		await screen.getByRole("button", { name: "Try again" }).click();

		await expect.element(screen.getByRole("button", { name: MAYA_ROW })).toBeInTheDocument();
	});

	it("reserves a separate trailing area for an external header control", async () => {
		const screen = await render(
			<RevisionHistory collection="posts" entryId="entry-1" reserveHeaderEnd />,
		);

		const trigger = screen.getByRole("button", { name: REVISIONS_TRIGGER }).element();
		expect(trigger.style.width).toBe("calc(100% - 1.5rem)");
	});
});
