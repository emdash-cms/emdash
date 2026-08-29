import { i18n } from "@lingui/core";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { ContentList } from "../../src/components/ContentList";
import type { ContentItem, TrashedContentItem } from "../../src/lib/api";
import type {
	ContentListColumnCellContext,
	ContentListColumnExtension,
} from "../../src/lib/content-list-columns.js";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context.js";
import { render } from "../utils/render.tsx";

const NO_RESULTS_PATTERN = /No results for/;
const HAS_MORE_ITEMS_PATTERN = /21\+ items/;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NO_POSTS_YET_REGEX = /No posts yet/;
const MOVE_TO_TRASH_CONFIRMATION_REGEX = /Move "Post" to trash/;
const PERMANENT_DELETE_CONFIRMATION_REGEX = /Permanently delete "Old Post"/;

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({
			children,
			to,
			params: _params,
			...props
		}: {
			children: React.ReactNode;
			to?: string;
			params?: Record<string, string>;
			[key: string]: unknown;
		}) => (
			<a href={typeof to === "string" ? to : "#"} {...props}>
				{children}
			</a>
		),
	};
});

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "item_01",
		type: "posts",
		slug: "hello-world",
		status: "draft",
		data: { title: "Hello World" },
		authorId: "user_01",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-02T00:00:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: "rev_01",
		...overrides,
	};
}

function makeTrashedItem(overrides: Partial<TrashedContentItem> = {}): TrashedContentItem {
	return {
		...makeItem(),
		deletedAt: "2025-01-03T00:00:00Z",
		...overrides,
	};
}

const defaultProps = {
	collection: "posts",
	collectionLabel: "Posts",
	items: [] as ContentItem[],
};

describe("ContentList", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("rendering items", () => {
		it("renders items in table with data.title", async () => {
			const items = [makeItem({ id: "1", data: { title: "My Post" } })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect.element(screen.getByText("My Post")).toBeInTheDocument();
		});

		it("falls back to data.name when title is missing", async () => {
			const items = [makeItem({ id: "1", data: { name: "Named Item" } })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect.element(screen.getByText("Named Item")).toBeInTheDocument();
		});

		it("falls back to slug when title and name are missing", async () => {
			const items = [makeItem({ id: "1", slug: "my-slug", data: {} })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect.element(screen.getByText("my-slug")).toBeInTheDocument();
		});

		it("falls back to id when title, name, and slug are missing", async () => {
			const items = [makeItem({ id: "item_xyz", slug: null, data: {} })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect.element(screen.getByText("item_xyz")).toBeInTheDocument();
		});

		it("renders multiple items", async () => {
			const items = [
				makeItem({ id: "1", data: { title: "First" } }),
				makeItem({ id: "2", data: { title: "Second" } }),
				makeItem({ id: "3", data: { title: "Third" } }),
			];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect.element(screen.getByText("First")).toBeInTheDocument();
			await expect.element(screen.getByText("Second")).toBeInTheDocument();
			await expect.element(screen.getByText("Third")).toBeInTheDocument();
		});

		it("renders configured custom fields using their field metadata", async () => {
			const items = [
				makeItem({
					data: {
						title: "Support request",
						ticket_number: "SUP-1042",
						priority: "urgent",
						labels: ["bug", "unknown"],
						vip: true,
					},
				}),
			];
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={items}
					listColumns={[
						{ slug: "ticket_number", label: "Ticket", kind: "string" },
						{
							slug: "priority",
							label: "Priority",
							kind: "select",
							options: [{ value: "urgent", label: "Urgent" }],
						},
						{
							slug: "labels",
							label: "Labels",
							kind: "multiSelect",
							options: [{ value: "bug", label: "Bug" }],
						},
						{ slug: "vip", label: "VIP", kind: "boolean" },
					]}
				/>,
			);

			await expect.element(screen.getByText("SUP-1042")).toBeInTheDocument();
			await expect.element(screen.getByText("Urgent")).toBeInTheDocument();
			await expect.element(screen.getByText("Bug, unknown")).toBeInTheDocument();
			await expect.element(screen.getByText("Yes")).toBeInTheDocument();
		});

		it("formats numeric, datetime, boolean, and missing custom-field values", async () => {
			const openedAt = "2025-01-02T00:00:00.000Z";
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={[
						makeItem({
							updatedAt: "2025-03-04T00:00:00.000Z",
							data: {
								title: "Invoice",
								amount: 12345.67,
								opened_at: openedAt,
								paid: false,
								owner: null,
							},
						}),
					]}
					listColumns={[
						{ slug: "amount", label: "Amount", kind: "number" },
						{ slug: "opened_at", label: "Opened", kind: "datetime" },
						{ slug: "paid", label: "Paid", kind: "boolean" },
						{ slug: "owner", label: "Owner", kind: "string" },
					]}
				/>,
			);

			await expect
				.element(screen.getByText(new Intl.NumberFormat("en").format(12345.67)))
				.toBeInTheDocument();
			await expect
				.element(screen.getByText(new Intl.DateTimeFormat("en").format(new Date(openedAt))))
				.toBeInTheDocument();
			await expect.element(screen.getByText("No", { exact: true })).toBeInTheDocument();
			await expect.element(screen.getByText("Not set")).toBeInTheDocument();
		});

		it("does not expose unconfigured custom-field data", async () => {
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={[
						makeItem({ data: { title: "Support request", priority: "urgent", secret: "Hidden" } }),
					]}
					listColumns={[{ slug: "priority", label: "Priority", kind: "string" }]}
				/>,
			);

			await expect.element(screen.getByText("urgent")).toBeInTheDocument();
			expect(screen.getByText("Hidden").query()).toBeNull();
		});
	});

	describe("empty states", () => {
		it("shows empty message for All tab", async () => {
			const screen = await render(<ContentList {...defaultProps} items={[]} />);
			await expect.element(screen.getByText(NO_POSTS_YET_REGEX)).toBeInTheDocument();
			await expect.element(screen.getByText("Create your first one")).toBeInTheDocument();
		});

		it("shows empty trash message in Trash tab", async () => {
			const screen = await render(<ContentList {...defaultProps} items={[]} trashedItems={[]} />);
			// Switch to Trash tab
			await screen.getByText("Trash").click();
			await expect.element(screen.getByText("Trash is empty")).toBeInTheDocument();
		});
	});

	describe("tab switching", () => {
		it("defaults to All tab", async () => {
			const items = [makeItem()];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			// Items should be visible (All tab active)
			await expect.element(screen.getByText("Hello World")).toBeInTheDocument();
		});

		it("switches to Trash tab", async () => {
			const trashed = [
				makeTrashedItem({
					id: "t1",
					data: { title: "Deleted Post" },
				}),
			];
			const screen = await render(
				<ContentList {...defaultProps} items={[makeItem()]} trashedItems={trashed} />,
			);
			await screen.getByText("Trash").click();
			await expect.element(screen.getByText("Deleted Post")).toBeInTheDocument();
		});

		it("shows trash count badge when items are trashed", async () => {
			const screen = await render(
				<ContentList {...defaultProps} items={[]} trashedItems={[]} trashedCount={42} />,
			);
			await expect.element(screen.getByText("42")).toBeInTheDocument();
		});
	});

	describe("status badges", () => {
		it.each([
			["draft", "Draft"],
			["published", "Published"],
			["scheduled", "Scheduled"],
			["archived", "Archived"],
		] as const)("shows the normalized %s status with its icon", async (status, label) => {
			const items = [makeItem({ id: "1", status })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			const badge = screen.getByText(label).element();

			expect(badge.querySelector("svg")).not.toBeNull();
		});

		it("keeps status icons before their labels in Arabic RTL mode", async () => {
			const previousLanguage = document.documentElement.lang;
			const previousDirection = document.documentElement.dir;
			document.documentElement.lang = "ar";
			document.documentElement.dir = "rtl";

			try {
				const items = [makeItem({ id: "1", status: "draft" })];
				const screen = await render(<ContentList {...defaultProps} items={items} />);
				const badge = screen.getByText("Draft").element();
				const icon = badge.querySelector("svg");
				const textNode = [...badge.childNodes].find(
					(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("Draft"),
				);

				expect(icon).not.toBeNull();
				expect(textNode).toBeDefined();
				const textRange = document.createRange();
				textRange.selectNode(textNode!);
				expect(icon!.getBoundingClientRect().left).toBeGreaterThan(
					textRange.getBoundingClientRect().left,
				);
			} finally {
				document.documentElement.lang = previousLanguage;
				document.documentElement.dir = previousDirection;
			}
		});

		it("shows the Pending changes companion badge when revisions differ", async () => {
			const items = [
				makeItem({
					id: "1",
					status: "published",
					draftRevisionId: "rev_draft",
					liveRevisionId: "rev_live",
				}),
			];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			const badge = screen.getByText("Pending changes").element();
			expect(badge.querySelector("svg")).not.toBeNull();
		});

		it("does not show pending badge when revisions match", async () => {
			const items = [
				makeItem({
					id: "1",
					status: "published",
					draftRevisionId: "rev_same",
					liveRevisionId: "rev_same",
				}),
			];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			expect(screen.getByText("Pending changes").query()).toBeNull();
		});

		it("renders unknown status names without treating object properties as lifecycle states", async () => {
			const items = [makeItem({ id: "1", status: "toString" })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);

			await expect.element(screen.getByText("toString", { exact: true })).toBeInTheDocument();
		});
	});

	describe("status filter", () => {
		it("shows icons with the selected status and each lifecycle option", async () => {
			const screen = await render(
				<ContentList {...defaultProps} statusFilter="draft" onStatusFilterChange={vi.fn()} />,
			);
			const filter = screen.getByRole("combobox", { name: "Filter by status" });

			expect(filter.element().querySelector("svg")).not.toBeNull();
			await filter.click();

			for (const label of ["Published", "Draft", "Scheduled", "Archived"]) {
				const option = screen.getByRole("option", { name: label });
				await expect.element(option).toBeInTheDocument();
				expect(option.element().querySelector("svg")).not.toBeNull();
			}
		});

		it("opens the date range calendar and clears the active range", async () => {
			const onDateFilterChange = vi.fn();
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={[makeItem()]}
					statusFilter="all"
					onStatusFilterChange={vi.fn()}
					dateFilter={{ field: "createdAt", from: "2026-08-10", to: "2026-08-18" }}
					onDateFilterChange={onDateFilterChange}
				/>,
			);

			await screen.getByRole("button", { name: /Filter by date range:/ }).click();
			await expect.element(screen.getByText("Choose a date range")).toBeInTheDocument();

			await screen.getByRole("button", { name: "Clear", exact: true }).click();
			expect(onDateFilterChange).toHaveBeenCalledWith({
				field: "createdAt",
				from: "",
				to: "",
			});
		});

		it("supports an upper-bound-only date filter", async () => {
			const onDateFilterChange = vi.fn();
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={[makeItem()]}
					statusFilter="all"
					onStatusFilterChange={vi.fn()}
					dateFilter={{ field: "createdAt", from: "2026-08-18", to: "2026-08-18" }}
					onDateFilterChange={onDateFilterChange}
				/>,
			);

			await screen.getByRole("button", { name: /Filter by date range:/ }).click();
			await screen.getByRole("button", { name: "Use as end date" }).click();

			expect(onDateFilterChange).toHaveBeenCalledWith({
				field: "createdAt",
				from: "",
				to: "2026-08-18",
			});
		});

		it("edits an upper-bound-only filter without converting it to a range", async () => {
			const onDateFilterChange = vi.fn();
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={[makeItem()]}
					statusFilter="all"
					onStatusFilterChange={vi.fn()}
					dateFilter={{ field: "createdAt", from: "", to: "2026-08-18" }}
					onDateFilterChange={onDateFilterChange}
				/>,
			);

			await screen.getByRole("button", { name: /Filter by date range:/ }).click();
			await screen.getByRole("button", { name: /August 20.*2026/ }).click();

			expect(onDateFilterChange).toHaveBeenCalledWith({
				field: "createdAt",
				from: "",
				to: "2026-08-20",
			});
		});

		it("uses the active admin locale and direction in the calendar", async () => {
			const previousLocale = i18n.locale;
			i18n.load("ar", {});
			i18n.activate("ar");

			try {
				const screen = await render(
					<ContentList
						{...defaultProps}
						items={[makeItem()]}
						statusFilter="all"
						onStatusFilterChange={vi.fn()}
						dateFilter={{ field: "createdAt", from: "2026-08-18", to: "" }}
						onDateFilterChange={vi.fn()}
					/>,
				);

				await screen.getByRole("button", { name: /Filter by date range:/ }).click();
				await expect.element(screen.getByText("أغسطس 2026")).toBeInTheDocument();
				await expect
					.element(screen.getByRole("button", { name: "اذهب إلى الشهر التالي" }))
					.toBeInTheDocument();
				expect(
					getComputedStyle(screen.getByRole("grid", { name: "أغسطس 2026" }).element()).direction,
				).toBe("rtl");
			} finally {
				i18n.activate(previousLocale);
			}
		});
	});

	describe("delete confirmation", () => {
		it("shows delete confirmation dialog with item title", async () => {
			const onDelete = vi.fn();
			const items = [makeItem({ id: "item_1", data: { title: "Post" } })];
			const screen = await render(
				<ContentList {...defaultProps} items={items} onDelete={onDelete} />,
			);

			// Click trash icon button to open the confirmation dialog
			await screen.getByRole("button", { name: "Move Post to trash" }).click();

			// Dialog should appear with confirmation text
			await expect.element(screen.getByText("Move to Trash?")).toBeInTheDocument();
			await expect.element(screen.getByText(MOVE_TO_TRASH_CONFIRMATION_REGEX)).toBeInTheDocument();
			// Confirm and Cancel buttons should be visible
			await expect
				.element(screen.getByRole("button", { name: "Move to Trash" }))
				.toBeInTheDocument();
			await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
		});
	});

	describe("permanent delete", () => {
		it("shows permanent delete dialog with item title", async () => {
			const onPermanentDelete = vi.fn();
			const trashed = [
				makeTrashedItem({
					id: "t1",
					data: { title: "Old Post" },
				}),
			];
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={[]}
					trashedItems={trashed}
					onPermanentDelete={onPermanentDelete}
				/>,
			);

			// Switch to trash tab
			await screen.getByText("Trash").click();

			// Click permanent delete trigger button
			await screen.getByRole("button", { name: "Permanently delete Old Post" }).click();

			// Dialog should appear with correct text
			await expect.element(screen.getByText("Delete Permanently?")).toBeInTheDocument();
			await expect
				.element(screen.getByText(PERMANENT_DELETE_CONFIRMATION_REGEX))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: "Delete Permanently" }))
				.toBeInTheDocument();
		});
	});

	describe("restore", () => {
		it("calls onRestore when restore button is clicked", async () => {
			const onRestore = vi.fn();
			const trashed = [
				makeTrashedItem({
					id: "t1",
					data: { title: "Restorable" },
				}),
			];
			const screen = await render(
				<ContentList {...defaultProps} items={[]} trashedItems={trashed} onRestore={onRestore} />,
			);

			await screen.getByText("Trash").click();
			await screen.getByRole("button", { name: "Restore Restorable" }).click();

			expect(onRestore).toHaveBeenCalledWith("t1");
		});
	});

	describe("duplicate", () => {
		it("calls onDuplicate when duplicate button is clicked", async () => {
			const onDuplicate = vi.fn();
			const items = [makeItem({ id: "item_1", data: { title: "Copyable" } })];
			const screen = await render(
				<ContentList {...defaultProps} items={items} onDuplicate={onDuplicate} />,
			);

			await screen.getByRole("button", { name: "Duplicate Copyable" }).click();

			expect(onDuplicate).toHaveBeenCalledWith("item_1");
		});
	});

	describe("load more", () => {
		it("shows Load More button when hasMore is true", async () => {
			const onLoadMore = vi.fn();
			const items = [makeItem()];
			const screen = await render(
				<ContentList {...defaultProps} items={items} hasMore={true} onLoadMore={onLoadMore} />,
			);
			await expect.element(screen.getByRole("button", { name: "Load More" })).toBeInTheDocument();
		});

		it("does not show Load More when hasMore is false", async () => {
			const items = [makeItem()];
			const screen = await render(<ContentList {...defaultProps} items={items} hasMore={false} />);
			expect(screen.getByRole("button", { name: "Load More" }).query()).toBeNull();
		});

		it("auto-fetches when user navigates to the last client-side page", async () => {
			const onLoadMore = vi.fn();
			// 21 items = 2 pages of 20; user starts on page 0 (not the last page)
			const items = Array.from({ length: 21 }, (_, i) => makeItem({ id: `item_${i}` }));
			const screen = await render(
				<ContentList {...defaultProps} items={items} hasMore={true} onLoadMore={onLoadMore} />,
			);

			// On mount, page 0 is not the last page — no fetch yet
			expect(onLoadMore).not.toHaveBeenCalled();

			// Navigate to page 2 (the last page)
			await screen.getByRole("button", { name: "Next page" }).click();

			expect(onLoadMore).toHaveBeenCalledOnce();
		});

		it("does not auto-fetch when a search query is active", async () => {
			const onLoadMore = vi.fn();
			// 21 items so pagination exists, but search will collapse to 1 result / 1 page
			const items = [
				...Array.from({ length: 20 }, (_, i) =>
					makeItem({ id: `item_${i}`, data: { title: `Post ${i}` } }),
				),
				makeItem({ id: "unique", data: { title: "Unique Title" } }),
			];
			const screen = await render(
				<ContentList {...defaultProps} items={items} hasMore={true} onLoadMore={onLoadMore} />,
			);

			// No fetch on mount (page 0 is not the last page with 21 items)
			expect(onLoadMore).not.toHaveBeenCalled();

			// Search collapses results to 1 item — totalPages becomes 1, but should NOT fetch
			await screen.getByRole("searchbox").fill("Unique Title");

			expect(onLoadMore).not.toHaveBeenCalled();
		});

		it("shows '+' suffix on item count when hasMore is true and no search is active", async () => {
			const items = Array.from({ length: 21 }, (_, i) => makeItem({ id: `item_${i}` }));
			const screen = await render(<ContentList {...defaultProps} items={items} hasMore={true} />);

			await expect.element(screen.getByText(HAS_MORE_ITEMS_PATTERN)).toBeInTheDocument();
		});

		it("calls onLoadMore when Load More is clicked", async () => {
			const onLoadMore = vi.fn();
			const items = [makeItem()];
			const screen = await render(
				<ContentList {...defaultProps} items={items} hasMore={true} onLoadMore={onLoadMore} />,
			);

			// With 1 item and hasMore=true, the auto-fetch effect fires on mount
			// because page 0 is already the last client-side page.
			// The button click adds a second call on top of that.
			expect(onLoadMore).toHaveBeenCalledOnce();

			await screen.getByRole("button", { name: "Load More" }).click();

			expect(onLoadMore).toHaveBeenCalledTimes(2);
		});
	});

	describe("header", () => {
		it("shows collection label as heading", async () => {
			const screen = await render(<ContentList {...defaultProps} collectionLabel="Articles" />);
			await expect.element(screen.getByRole("heading", { name: "Articles" })).toBeInTheDocument();
		});

		it("shows Add New link", async () => {
			const screen = await render(<ContentList {...defaultProps} />);
			await expect.element(screen.getByText("Add New")).toBeInTheDocument();
		});
	});

	describe("search", () => {
		it("shows search input when items exist", async () => {
			const items = [makeItem({ id: "1", data: { title: "Post" } })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect
				.element(screen.getByRole("searchbox", { name: "Search posts" }))
				.toBeInTheDocument();
		});

		it("hides search input when no items", async () => {
			const screen = await render(<ContentList {...defaultProps} items={[]} />);
			expect(screen.getByRole("searchbox").query()).toBeNull();
		});

		it("filters items by title", async () => {
			const items = [
				makeItem({ id: "1", data: { title: "Alpha post" } }),
				makeItem({ id: "2", data: { title: "Beta post" } }),
				makeItem({ id: "3", data: { title: "Gamma post" } }),
			];
			const screen = await render(<ContentList {...defaultProps} items={items} />);

			await screen.getByRole("searchbox").fill("beta");

			await expect.element(screen.getByText("Beta post")).toBeInTheDocument();
			expect(screen.getByText("Alpha post").query()).toBeNull();
			expect(screen.getByText("Gamma post").query()).toBeNull();
		});

		it("shows no results message when search has no matches", async () => {
			const items = [makeItem({ id: "1", data: { title: "Hello" } })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);

			await screen.getByRole("searchbox").fill("zzzzz");

			await expect.element(screen.getByText(NO_RESULTS_PATTERN)).toBeInTheDocument();
		});

		// #1219: when the caller opts into server-side search it reports the
		// (debounced) query and must NOT also filter the loaded page client-side
		// (the server already returned the matching rows).
		it("reports the query upward and does not client-filter in server mode", async () => {
			const onSearchChange = vi.fn();
			const items = [
				makeItem({ id: "1", data: { title: "Alpha post" } }),
				makeItem({ id: "2", data: { title: "Beta post" } }),
			];
			const screen = await render(
				<ContentList {...defaultProps} items={items} onSearchChange={onSearchChange} />,
			);

			await screen.getByRole("searchbox").fill("beta");

			// Debounced callback fires with the typed term.
			await vi.waitFor(() => {
				expect(onSearchChange).toHaveBeenCalledWith("beta");
			});

			// Server mode shows whatever `items` the caller supplied — it does not
			// hide "Alpha post" by filtering locally.
			await expect.element(screen.getByText("Alpha post")).toBeInTheDocument();
			await expect.element(screen.getByText("Beta post")).toBeInTheDocument();
		});

		// #1219: in server mode a zero-match query empties `items`. The search box
		// must stay mounted so the user can clear the query.
		it("keeps the search input mounted in server mode when there are no items", async () => {
			const onSearchChange = vi.fn();
			const screen = await render(
				<ContentList {...defaultProps} items={[]} onSearchChange={onSearchChange} />,
			);
			await expect
				.element(screen.getByRole("searchbox", { name: "Search posts" }))
				.toBeInTheDocument();
		});

		// #1219: a zero-match server search must not show "Create your first one"
		// (there is content, it just doesn't match), it must report the query.
		it("shows a no-results message, not the empty state, for a zero-match server search", async () => {
			const onSearchChange = vi.fn();
			const screen = await render(
				<ContentList {...defaultProps} items={[]} total={0} onSearchChange={onSearchChange} />,
			);

			await screen.getByRole("searchbox").fill("zzzzz");

			await expect.element(screen.getByText(NO_RESULTS_PATTERN)).toBeInTheDocument();
			expect(screen.getByText("Create your first one").query()).toBeNull();
		});

		// #1219: the match count must come from the server `total`, not the loaded
		// page length, otherwise it undercounts when matches span multiple pages.
		it("counts server-search matches using total, not the loaded page", async () => {
			const onSearchChange = vi.fn();
			const items = Array.from({ length: 20 }, (_, i) =>
				makeItem({ id: `item_${i}`, data: { title: `Post ${i}` } }),
			);
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={items}
					total={143}
					hasMore={true}
					onSearchChange={onSearchChange}
				/>,
			);

			await screen.getByRole("searchbox").fill("post");

			await expect.element(screen.getByText(/143 items matching "post"/)).toBeInTheDocument();
		});
	});

	describe("pagination", () => {
		it("shows pagination when items exceed page size", async () => {
			const items = Array.from({ length: 25 }, (_, i) =>
				makeItem({ id: `item_${i}`, data: { title: `Post ${i}` } }),
			);
			const screen = await render(<ContentList {...defaultProps} items={items} />);

			await expect.element(screen.getByText("1 / 2")).toBeInTheDocument();
			await expect.element(screen.getByRole("button", { name: "Next page" })).toBeInTheDocument();
		});

		it("does not show pagination when items fit on one page", async () => {
			const items = [makeItem({ id: "1", data: { title: "Post" } })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			expect(screen.getByRole("button", { name: "Next page" }).query()).toBeNull();
		});

		it("navigates between pages", async () => {
			const items = Array.from({ length: 25 }, (_, i) =>
				makeItem({ id: `item_${i}`, data: { title: `Post ${i}` } }),
			);
			const screen = await render(<ContentList {...defaultProps} items={items} />);

			// Page 1 should show Post 0
			await expect.element(screen.getByText("Post 0")).toBeInTheDocument();

			// Go to page 2
			await screen.getByRole("button", { name: "Next page" }).click();

			await expect.element(screen.getByText("2 / 2")).toBeInTheDocument();
			// Post 20 should be on page 2
			await expect.element(screen.getByText("Post 20")).toBeInTheDocument();
			// Post 0 should not be visible
			expect(screen.getByText("Post 0").query()).toBeNull();
		});

		// Regression: before this change `totalPages` was derived only from
		// loaded items, so the denominator grew in increments of 5 (API
		// fetches 100, page size 20 → 5 client pages per fetch). When the
		// parent supplies an authoritative `total`, the denominator must
		// reflect it from the first render.
		it("uses `total` as a stable denominator instead of items.length", async () => {
			// Only the first 20 items have been loaded, but the server knows
			// there are 143 total.
			const items = Array.from({ length: 20 }, (_, i) =>
				makeItem({ id: `item_${i}`, data: { title: `Post ${i}` } }),
			);
			const screen = await render(
				<ContentList {...defaultProps} items={items} total={143} hasMore={true} />,
			);

			// 143 / 20 = 8 pages. The denominator should read 8, not "/5".
			await expect.element(screen.getByText("1 / 8")).toBeInTheDocument();
		});
	});

	describe("sortable headers", () => {
		it("calls onSortChange when a header is clicked", async () => {
			const onSortChange = vi.fn();
			const items = [makeItem({ id: "1", data: { title: "Post" } })];
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={items}
					sort={{ field: "updatedAt", direction: "desc" }}
					onSortChange={onSortChange}
				/>,
			);

			await screen.getByRole("button", { name: "Title" }).click();

			expect(onSortChange).toHaveBeenCalledWith({ field: "title", direction: "desc" });
		});

		it("toggles direction when clicking the active column", async () => {
			const onSortChange = vi.fn();
			const items = [makeItem({ id: "1", data: { title: "Post" } })];
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={items}
					sort={{ field: "title", direction: "desc" }}
					onSortChange={onSortChange}
				/>,
			);

			await screen.getByRole("button", { name: "Title" }).click();

			expect(onSortChange).toHaveBeenCalledWith({ field: "title", direction: "asc" });
		});

		it("exposes sort state via aria-sort on the active header", async () => {
			const items = [makeItem({ id: "1", data: { title: "Post" } })];
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={items}
					sort={{ field: "title", direction: "asc" }}
					onSortChange={vi.fn()}
				/>,
			);

			const titleHeader = screen.getByRole("columnheader", { name: "Title" });
			const statusHeader = screen.getByRole("columnheader", { name: "Status" });
			await expect.element(titleHeader).toHaveAttribute("aria-sort", "ascending");
			// Inactive columns explicitly advertise "none" so the header still
			// announces as sortable.
			await expect.element(statusHeader).toHaveAttribute("aria-sort", "none");
		});

		it("falls back to static headers when onSortChange is not provided", async () => {
			const items = [makeItem({ id: "1", data: { title: "Post" } })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);

			// The header must not render as a button — it's just a label.
			expect(screen.getByRole("button", { name: "Title" }).query()).toBeNull();
		});

		it("keeps configured custom columns display-only", async () => {
			const screen = await render(
				<ContentList
					{...defaultProps}
					items={[makeItem({ data: { title: "Post", priority: "urgent" } })]}
					listColumns={[{ slug: "priority", label: "Priority", kind: "string" }]}
					sort={{ field: "title", direction: "asc" }}
					onSortChange={vi.fn()}
				/>,
			);

			await expect
				.element(screen.getByRole("columnheader", { name: "Priority" }))
				.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Priority" }).query()).toBeNull();
		});
	});

	describe("trusted plugin columns", () => {
		function listWithColumns(
			columns: readonly ContentListColumnExtension[],
			props: Partial<React.ComponentProps<typeof ContentList>> = {},
		) {
			const pluginAdmins: PluginAdmins = {
				"editorial-workflow": { contentListColumns: columns },
			};
			return (
				<PluginAdminProvider pluginAdmins={pluginAdmins}>
					<ContentList
						{...defaultProps}
						items={[makeItem({ data: { title: "Plugin Post", reviewStatus: "Needs review" } })]}
						pluginStates={{ "editorial-workflow": { enabled: true } }}
						{...props}
					/>
				</PluginAdminProvider>
			);
		}

		function renderWithColumns(
			columns: readonly ContentListColumnExtension[],
			props: Partial<React.ComponentProps<typeof ContentList>> = {},
		) {
			return render(listWithColumns(columns, props));
		}

		it("renders contributed headers and cells inside the host table", async () => {
			function ReviewStatusCell({ item }: { item: ContentItem }) {
				return <span>{String(item.data.reviewStatus)}</span>;
			}

			const screen = await renderWithColumns([
				{
					id: "review-status",
					label: "Review status",
					cell: ReviewStatusCell,
				},
			]);

			await expect
				.element(screen.getByRole("columnheader", { name: "Review status" }))
				.toBeVisible();
			await expect.element(screen.getByText("Needs review")).toBeVisible();
			await expect.element(screen.getByText("Plugin Post")).toBeVisible();
		});

		it("updates contributed header labels when the shared catalog changes", async () => {
			const previousLocale = i18n.locale;
			const translatedLabel = "حالة المراجعة";

			try {
				const screen = await renderWithColumns([
					{ id: "review-status", label: "Review status", cell: () => null },
				]);
				await expect
					.element(screen.getByRole("columnheader", { name: "Review status" }))
					.toBeVisible();

				i18n.load("ar", { "Review status": translatedLabel });
				i18n.activate("ar");

				await expect
					.element(screen.getByRole("columnheader", { name: translatedLabel }))
					.toBeVisible();
				await expect.element(screen.getByText(translatedLabel)).toBeVisible();
			} finally {
				i18n.activate(previousLocale);
			}
		});

		it("localizes a contributed header's render fallback", async () => {
			const previousLocale = i18n.locale;
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const translatedLabel = "حالة المراجعة";
			i18n.load("ar", { "Review status": translatedLabel });
			i18n.activate("ar");

			function BrokenHeader(): React.ReactNode {
				throw new Error("render failed");
			}

			try {
				const screen = await renderWithColumns([
					{
						id: "review-status",
						label: "Review status",
						header: BrokenHeader,
						cell: () => null,
					},
				]);

				await expect.element(screen.getByText(translatedLabel)).toBeVisible();
			} finally {
				i18n.activate(previousLocale);
				error.mockRestore();
			}
		});

		it("passes the current visible page to contributed cells", async () => {
			const pages: string[][] = [];
			const items = Array.from({ length: 21 }, (_, index) =>
				makeItem({
					id: `item-${index}`,
					data: { title: `Post ${index + 1}` },
				}),
			);
			function PageCell({ item, visibleItems }: ContentListColumnCellContext) {
				if (item.id === "item-0" || item.id === "item-20") {
					pages.push(visibleItems.map((visibleItem) => visibleItem.id));
				}
				return null;
			}

			const screen = await renderWithColumns(
				[{ id: "page", label: "Page context", cell: PageCell }],
				{ items },
			);

			expect(pages).toContainEqual(items.slice(0, 20).map((item) => item.id));
			await screen.getByRole("button", { name: "Next page" }).click();
			await expect.element(screen.getByText("Post 21")).toBeVisible();
			expect(pages).toContainEqual(["item-20"]);
		});

		it("preserves contributed cell state when an existing row updates", async () => {
			let mounts = 0;
			function StatefulCell({ item }: ContentListColumnCellContext) {
				const [mount] = React.useState(() => ++mounts);
				return (
					<span>
						{String(item.data.title)}:mount-{mount}
					</span>
				);
			}
			const columns = [{ id: "stateful", label: "Stateful", cell: StatefulCell }] as const;
			const screen = await renderWithColumns(columns, {
				items: [
					makeItem({
						id: "item-1",
						updatedAt: "2025-01-02T00:00:00Z",
						data: { title: "Before update" },
					}),
				],
			});

			await expect.element(screen.getByText("Before update:mount-1")).toBeVisible();
			await screen.rerender(
				listWithColumns(columns, {
					items: [
						makeItem({
							id: "item-1",
							updatedAt: "2025-01-03T00:00:00Z",
							data: { title: "After update" },
						}),
					],
				}),
			);

			await expect.element(screen.getByText("After update:mount-1")).toBeVisible();
			expect(mounts).toBe(1);
		});

		it("retries a failed cell when an existing row updates", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			let shouldThrow = true;
			function FlakyCell({ item }: ContentListColumnCellContext) {
				if (shouldThrow) throw new Error("render failed");
				return <span data-testid="flaky-cell">{String(item.data.title)}</span>;
			}
			const columns = [{ id: "flaky", label: "Flaky", cell: FlakyCell }] as const;
			const screen = await renderWithColumns(columns, {
				items: [
					makeItem({
						id: "item-1",
						updatedAt: "2025-01-02T00:00:00Z",
						data: { title: "Before update" },
					}),
				],
			});

			await expect.element(screen.getByText("Plugin column unavailable")).toBeInTheDocument();
			shouldThrow = false;
			await screen.rerender(
				listWithColumns(columns, {
					items: [
						makeItem({
							id: "item-1",
							updatedAt: "2025-01-03T00:00:00Z",
							data: { title: "After update" },
						}),
					],
				}),
			);

			await expect.element(screen.getByTestId("flaky-cell")).toHaveTextContent("After update");
			error.mockRestore();
		});

		it("keeps configured and plugin columns aligned in rows and empty states", async () => {
			function ReviewStatusCell({ item }: { item: ContentItem }) {
				return <span>{String(item.data.reviewStatus)}</span>;
			}
			const columns = [
				{
					id: "review-status",
					label: "Review status",
					cell: ReviewStatusCell,
				},
			] as const;
			const listColumns = [{ slug: "ticket_number", label: "Ticket", kind: "string" }];
			const screen = await renderWithColumns(columns, {
				items: [
					makeItem({
						data: {
							title: "Plugin Post",
							ticket_number: "SUP-1042",
							reviewStatus: "Needs review",
						},
					}),
				],
				listColumns,
			});

			await expect.element(screen.getByRole("columnheader", { name: "Ticket" })).toBeVisible();
			await expect
				.element(screen.getByRole("columnheader", { name: "Review status" }))
				.toBeVisible();
			await expect.element(screen.getByText("SUP-1042")).toBeVisible();
			await expect.element(screen.getByText("Needs review")).toBeVisible();

			await screen.rerender(listWithColumns(columns, { items: [], isLoading: true, listColumns }));
			await expect
				.element(screen.getByRole("cell", { name: "Loading..." }))
				.toHaveAttribute("colspan", "6");
		});

		it("isolates broken headers and cells while healthy columns and core rows remain", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			function Broken(): React.ReactNode {
				throw new Error("render failed");
			}
			function HealthyCell() {
				return <span>Healthy value</span>;
			}

			const screen = await renderWithColumns([
				{ id: "broken", label: "Broken fallback", header: Broken, cell: Broken },
				{ id: "healthy", label: "Healthy", cell: HealthyCell },
			]);

			await expect.element(screen.getByText("Broken fallback")).toBeVisible();
			const unavailableCell = screen.getByRole("cell", {
				name: "Plugin column unavailable",
			});
			await expect.element(unavailableCell).toHaveTextContent("-");
			const visualFallback = unavailableCell.element().querySelector('[aria-hidden="true"]');
			expect(visualFallback).toHaveTextContent("-");
			await expect.element(screen.getByText("Healthy value")).toBeVisible();
			await expect.element(screen.getByText("Plugin Post")).toBeVisible();
			expect(error).toHaveBeenCalled();
			error.mockRestore();
		});

		it("retries a failed cell when the row locale changes", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			let shouldThrow = true;
			function LocaleCell({ item }: { item: ContentItem }) {
				if (shouldThrow) throw new Error("render failed");
				return <span>{item.locale}</span>;
			}
			const columns = [{ id: "locale", label: "Locale", cell: LocaleCell }] as const;
			const screen = await renderWithColumns(columns, {
				items: [makeItem({ locale: "en" })],
			});

			await expect.element(screen.getByText("Plugin column unavailable")).toBeInTheDocument();
			shouldThrow = false;
			await screen.rerender(listWithColumns(columns, { items: [makeItem({ locale: "fr" })] }));

			await expect.element(screen.getByText("fr")).toBeVisible();
			error.mockRestore();
		});

		it("extends loading and empty-state colspans", async () => {
			function Cell(): React.ReactNode {
				return null;
			}
			const screen = await renderWithColumns(
				[{ id: "review-status", label: "Review status", cell: Cell }],
				{
					items: [],
					isLoading: true,
				},
			);

			await expect
				.element(screen.getByRole("cell", { name: "Loading..." }))
				.toHaveAttribute("colspan", "5");
		});

		it("does not render contributed columns in Trash", async () => {
			function Cell() {
				return <span>Plugin value</span>;
			}
			const screen = await renderWithColumns(
				[{ id: "review-status", label: "Review status", cell: Cell }],
				{
					trashedItems: [makeTrashedItem({ data: { title: "Deleted" } })],
				},
			);

			await screen.getByText("Trash").click();
			await expect
				.element(screen.getByRole("cell", { name: "Deleted", exact: true }))
				.toBeVisible();
			expect(screen.getByRole("columnheader", { name: "Review status" }).query()).toBeNull();
			expect(screen.getByText("Plugin value").query()).toBeNull();
		});
	});
});
