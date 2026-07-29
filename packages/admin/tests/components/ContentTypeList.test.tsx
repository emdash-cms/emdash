import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { ContentTypeList, moveCollection } from "../../src/components/ContentTypeList";
import type { SchemaCollection, OrphanedTable } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NO_CONTENT_TYPES_REGEX = /No content types yet/;

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

function makeCollection(overrides: Partial<SchemaCollection> = {}): SchemaCollection {
	return {
		id: "col_01",
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		supports: ["drafts", "revisions"],
		source: "dashboard",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-02T00:00:00Z",
		...overrides,
	};
}

function makeOrphan(overrides: Partial<OrphanedTable> = {}): OrphanedTable {
	return {
		slug: "legacy_posts",
		tableName: "ec_legacy_posts",
		rowCount: 42,
		...overrides,
	};
}

describe("ContentTypeList", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("rendering collections", () => {
		it("displays collections with labels and slugs", async () => {
			const collections = [
				makeCollection({ id: "1", slug: "articles", label: "Articles" }),
				makeCollection({ id: "2", slug: "landing_pages", label: "Landing Pages" }),
			];
			const screen = await render(<ContentTypeList collections={collections} />);
			await expect.element(screen.getByText("Articles", { exact: true })).toBeInTheDocument();
			await expect.element(screen.getByText("Landing Pages", { exact: true })).toBeInTheDocument();
			await expect.element(screen.getByText("articles", { exact: true })).toBeInTheDocument();
			await expect.element(screen.getByText("landing_pages", { exact: true })).toBeInTheDocument();
		});

		it("shows 'Code' badge for code-source collections", async () => {
			const collections = [makeCollection({ id: "1", source: "code" })];
			const screen = await render(<ContentTypeList collections={collections} />);
			await expect.element(screen.getByText("Code")).toBeInTheDocument();
		});

		it("shows 'Dashboard' badge for dashboard-source collections", async () => {
			const collections = [makeCollection({ id: "1", source: "dashboard" })];
			const screen = await render(<ContentTypeList collections={collections} />);
			await expect.element(screen.getByText("Dashboard")).toBeInTheDocument();
		});

		it("shows feature badges from supports array", async () => {
			const collections = [
				makeCollection({
					id: "1",
					supports: ["drafts", "revisions", "preview", "search"],
				}),
			];
			const screen = await render(<ContentTypeList collections={collections} />);
			await expect.element(screen.getByText("drafts")).toBeInTheDocument();
			await expect.element(screen.getByText("revisions")).toBeInTheDocument();
			await expect.element(screen.getByText("preview")).toBeInTheDocument();
			await expect.element(screen.getByText("search")).toBeInTheDocument();
		});
	});

	describe("navigation", () => {
		it("edit link navigates to /content-types/$slug", async () => {
			const collections = [makeCollection({ id: "1", slug: "articles", label: "Articles" })];
			const screen = await render(<ContentTypeList collections={collections} />);
			const editLink = screen.getByRole("link", { name: "Edit Articles" });
			await expect.element(editLink).toBeInTheDocument();
		});

		it("'New Content Type' link is present", async () => {
			const screen = await render(<ContentTypeList collections={[]} />);
			await expect.element(screen.getByText("New Content Type")).toBeInTheDocument();
		});
	});

	describe("delete", () => {
		it("delete button only shown for non-code-source collections", async () => {
			const collections = [
				makeCollection({ id: "1", slug: "from-code", label: "From Code", source: "code" }),
				makeCollection({
					id: "2",
					slug: "from-dash",
					label: "From Dashboard",
					source: "dashboard",
				}),
			];
			const screen = await render(<ContentTypeList collections={collections} />);
			// Code-sourced should have no delete button
			expect(screen.getByRole("button", { name: "Delete From Code" }).query()).toBeNull();
			// Dashboard-sourced should have delete button
			await expect
				.element(screen.getByRole("button", { name: "Delete From Dashboard" }))
				.toBeInTheDocument();
		});

		it("opens confirm dialog and calls onDelete after confirm", async () => {
			const onDelete = vi.fn();
			const collections = [
				makeCollection({ id: "1", slug: "posts", label: "Posts", source: "dashboard" }),
			];
			const screen = await render(
				<ContentTypeList collections={collections} onDelete={onDelete} />,
			);

			await screen.getByRole("button", { name: "Delete Posts" }).click();

			// ConfirmDialog should appear
			await expect.element(screen.getByText("Delete Content Type?")).toBeInTheDocument();

			// Direct DOM click to bypass Base UI inert overlay
			screen.getByRole("button", { name: "Delete" }).element().click();

			expect(onDelete).toHaveBeenCalledWith("posts");
		});

		it("does not call onDelete when confirm dialog is cancelled", async () => {
			const onDelete = vi.fn();
			const collections = [
				makeCollection({ id: "1", slug: "posts", label: "Posts", source: "dashboard" }),
			];
			const screen = await render(
				<ContentTypeList collections={collections} onDelete={onDelete} />,
			);

			await screen.getByRole("button", { name: "Delete Posts" }).click();

			// ConfirmDialog should appear
			await expect.element(screen.getByText("Delete Content Type?")).toBeInTheDocument();

			// Direct DOM click to bypass Base UI inert overlay
			screen.getByRole("button", { name: "Cancel" }).element().click();

			expect(onDelete).not.toHaveBeenCalled();
		});
	});

	describe("orphaned tables", () => {
		it("shows warning when orphanedTables has items", async () => {
			const orphans = [makeOrphan({ slug: "old_content", rowCount: 15 })];
			const screen = await render(<ContentTypeList collections={[]} orphanedTables={orphans} />);
			await expect
				.element(screen.getByText("Unregistered Content Tables Found"))
				.toBeInTheDocument();
			await expect.element(screen.getByText("old_content")).toBeInTheDocument();
			await expect.element(screen.getByText("(15 items)")).toBeInTheDocument();
		});

		it("register button calls onRegisterOrphan", async () => {
			const onRegisterOrphan = vi.fn();
			const orphans = [makeOrphan({ slug: "legacy_data", rowCount: 5 })];
			const screen = await render(
				<ContentTypeList
					collections={[]}
					orphanedTables={orphans}
					onRegisterOrphan={onRegisterOrphan}
				/>,
			);

			await screen.getByRole("button", { name: "Register" }).click();

			expect(onRegisterOrphan).toHaveBeenCalledWith("legacy_data");
		});

		it("does not show orphan warning when orphanedTables is empty", async () => {
			const screen = await render(<ContentTypeList collections={[]} orphanedTables={[]} />);
			expect(screen.getByText("Unregistered Content Tables Found").query()).toBeNull();
		});
	});

	describe("empty state", () => {
		it("shows 'No content types yet' when no collections", async () => {
			const screen = await render(<ContentTypeList collections={[]} />);
			await expect.element(screen.getByText(NO_CONTENT_TYPES_REGEX)).toBeInTheDocument();
		});
	});

	describe("loading state", () => {
		it("shows loading message when isLoading is true", async () => {
			const screen = await render(<ContentTypeList collections={[]} isLoading />);
			await expect.element(screen.getByText("Loading collections...")).toBeInTheDocument();
		});
	});

	describe("reordering", () => {
		const twoCollections = [
			makeCollection({ id: "1", slug: "posts", label: "Posts" }),
			makeCollection({ id: "2", slug: "pages", label: "Pages" }),
		];

		it("renders a labelled drag handle per row when onReorder is provided", async () => {
			const screen = await render(
				<ContentTypeList collections={twoCollections} onReorder={vi.fn()} />,
			);

			// The accessible name carries the collection, so screen-reader users
			// know which row the handle moves.
			await expect
				.element(screen.getByRole("button", { name: "Reorder Posts" }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: "Reorder Pages" }))
				.toBeInTheDocument();
		});

		it("renders no drag handles without onReorder", async () => {
			const screen = await render(<ContentTypeList collections={twoCollections} />);

			expect(screen.getByRole("button", { name: "Reorder Posts" }).query()).toBeNull();
		});

		it("renders no drag handles for a single collection (nothing to reorder)", async () => {
			const screen = await render(
				<ContentTypeList collections={[twoCollections[0]!]} onReorder={vi.fn()} />,
			);

			expect(screen.getByRole("button", { name: "Reorder Posts" }).query()).toBeNull();
		});

		it("renders collections in the order given, not alphabetically", async () => {
			// The server already returns them ordered; the list must not re-sort.
			const screen = await render(
				<ContentTypeList collections={twoCollections} onReorder={vi.fn()} />,
			);

			const rendered = screen.container.querySelectorAll("tbody code");
			expect(Array.from(rendered, (el) => el.textContent)).toEqual(["posts", "pages"]);
		});
	});

	describe("moveCollection", () => {
		it("moves an item down to the drop target index", () => {
			expect(moveCollection(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
		});

		it("moves an item up to the drop target index", () => {
			expect(moveCollection(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
		});

		it("returns the same reference when the move is a no-op", () => {
			const slugs = ["a", "b", "c"];
			// Same identity lets the caller skip both the state update and the
			// network request on a drop that changes nothing.
			expect(moveCollection(slugs, "b", "b")).toBe(slugs);
			expect(moveCollection(slugs, "b", "missing")).toBe(slugs);
			expect(moveCollection(slugs, "missing", "b")).toBe(slugs);
		});
	});
});
