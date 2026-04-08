import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";

import { ContentList } from "../../src/components/ContentList";
import type { ContentItem, TrashedContentItem } from "../../src/lib/api";

const NO_RESULTS_PATTERN = /No results for/;

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
		it("shows draft status", async () => {
			const items = [makeItem({ id: "1", status: "draft" })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect.element(screen.getByText("draft")).toBeInTheDocument();
		});

		it("shows published status", async () => {
			const items = [makeItem({ id: "1", status: "published" })];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect.element(screen.getByText("published")).toBeInTheDocument();
		});

		it("shows pending badge when draftRevisionId differs from liveRevisionId", async () => {
			const items = [
				makeItem({
					id: "1",
					status: "published",
					draftRevisionId: "rev_draft",
					liveRevisionId: "rev_live",
				}),
			];
			const screen = await render(<ContentList {...defaultProps} items={items} />);
			await expect.element(screen.getByText("pending")).toBeInTheDocument();
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
			expect(screen.getByText("pending").query()).toBeNull();
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

		it("calls onLoadMore when Load More is clicked", async () => {
			const onLoadMore = vi.fn();
			const items = [makeItem()];
			const screen = await render(
				<ContentList {...defaultProps} items={items} hasMore={true} onLoadMore={onLoadMore} />,
			);

			await screen.getByRole("button", { name: "Load More" }).click();

			expect(onLoadMore).toHaveBeenCalledOnce();
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
	});
});
