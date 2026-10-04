/**
 * The relations admin surface: the list, the dialog that defines a relation,
 * and the routing that reaches them.
 *
 * `/content-types/relations` sits under the collection editor's own
 * `/content-types/$slug`, so the routing assertions here are the ones that
 * catch a relation page being served as a collection called "relations".
 */

import {
	Outlet,
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RelationList } from "../../src/components/RelationList";
import type { SchemaCollection } from "../../src/lib/api";
import type { RelationWithUsage } from "../../src/lib/api/relations.js";
import { createAdminRouter } from "../../src/router";
import { render } from "../utils/render.tsx";
import { createTestQueryClient } from "../utils/test-helpers";

function relation(overrides: Partial<RelationWithUsage> = {}): RelationWithUsage {
	return {
		id: "rel-1",
		slug: "posts_authors",
		parentCollection: "posts",
		childCollection: "authors",
		parentLabel: "Posts",
		parentLabelSingular: "Post",
		childLabel: "Authors",
		childLabelSingular: "Author",
		maxChildrenPerParent: 1,
		maxParentsPerChild: null,
		boundFields: [{ collectionSlug: "posts", fieldSlug: "author", side: "parent" }],
		linkCount: 12,
		...overrides,
	};
}

const collections = [
	{ slug: "posts", label: "Posts", labelSingular: "Post" },
	{ slug: "authors", label: "Authors" },
] as SchemaCollection[];

function listProps(overrides: Partial<React.ComponentProps<typeof RelationList>> = {}) {
	return {
		relations: [relation()],
		collections,
		onCreateRelation: vi.fn(async () => ({})),
		onUpdateRelation: vi.fn(async () => ({})),
		onDeleteRelation: vi.fn(async () => ({})),
		...overrides,
	};
}

/** Render `element` inside a router, so `<Link>` targets resolve the way they
 * do in the admin. */
async function renderWithRoutes(element: React.ReactNode) {
	const rootRoute = createRootRoute({ component: Outlet });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => element,
	});
	const listRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/content-types/relations",
		component: () => <div>Relations list</div>,
	});
	const contentTypesRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/content-types",
		component: () => <div>Content types</div>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, contentTypesRoute, listRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const screen = await render(<RouterProvider router={router} />);
	return { router, screen };
}

type Screen = Awaited<ReturnType<typeof renderWithRoutes>>["screen"];

/** Kumo's Select is a combobox button over a listbox, not a native select; the
 * dialog's inert overlay blocks Playwright's actionability checks, so drive it
 * through the DOM as the other dialog tests do. */
async function selectOption(screen: Screen, label: string, option: string) {
	const trigger = screen.getByRole("combobox", { name: label, exact: true });
	await expect.element(trigger).toBeInTheDocument();
	trigger.element().click();
	// Scoped to this select's own list: a list on its way out still answers a
	// role query, and clicking it would set the select it belongs to.
	await vi.waitFor(() => {
		const listId = trigger.element().getAttribute("aria-controls");
		const list = listId ? document.getElementById(listId) : null;
		const choice = [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
			(el) => el.textContent?.trim() === option,
		);
		if (!choice) throw new Error(`No "${option}" option open under ${label}`);
		choice.click();
	});
	await vi.waitFor(() => {
		if (trigger.element().getAttribute("aria-expanded") !== "false") {
			throw new Error(`The ${label} list is still open`);
		}
	});
}

describe("RelationList", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows each relation's ends, bound fields and link count", async () => {
		const { screen } = await renderWithRoutes(<RelationList {...listProps()} />);

		await expect.element(screen.getByText("posts_authors")).toBeInTheDocument();
		await expect.element(screen.getByText("posts.author")).toBeInTheDocument();
		await expect.element(screen.getByText("picks Authors")).toBeInTheDocument();
		await expect.element(screen.getByText("12 links")).toBeInTheDocument();
	});

	it("says which end a child-side field picks from", async () => {
		const { screen } = await renderWithRoutes(
			<RelationList
				{...listProps({
					relations: [
						relation({
							boundFields: [{ collectionSlug: "authors", fieldSlug: "posts", side: "child" }],
						}),
					],
				})}
			/>,
		);

		await expect.element(screen.getByText("picks Posts")).toBeInTheDocument();
	});

	// Unbinding the last field leaves a relation behind; without a row here it
	// is unreachable and undeletable.
	it("lists a relation with no bound fields", async () => {
		const { screen } = await renderWithRoutes(
			<RelationList {...listProps({ relations: [relation({ boundFields: [], linkCount: 0 })] })} />,
		);

		await expect.element(screen.getByText("posts_authors")).toBeInTheDocument();
		await expect.element(screen.getByText("No fields")).toBeInTheDocument();
	});

	// Editing a relation is a dialog over the list, not a page of its own: the
	// list is where the relation was found and where the roles land.
	it("edits a relation's roles in a dialog", async () => {
		const onUpdateRelation = vi.fn(async () => ({}));
		const { screen } = await renderWithRoutes(
			<RelationList {...listProps({ onUpdateRelation })} />,
		);

		await screen.getByRole("button", { name: "Edit posts_authors" }).click();

		await expect.element(screen.getByLabelText("Slug", { exact: true })).toBeDisabled();
		await screen.getByLabelText("Linked side (plural)").fill("Writers");
		screen.getByRole("button", { name: "Save Relation" }).element().click();

		await vi.waitFor(() => {
			expect(onUpdateRelation).toHaveBeenCalledWith("rel-1", {
				parentLabel: "Posts",
				parentLabelSingular: "Post",
				childLabel: "Writers",
				childLabelSingular: "Author",
				maxChildrenPerParent: 1,
				maxParentsPerChild: null,
			});
		});
	});

	it("will not save an 'At most…' limit with no number in it", async () => {
		const onUpdateRelation = vi.fn(async () => ({}));
		const { screen } = await renderWithRoutes(
			<RelationList {...listProps({ onUpdateRelation })} />,
		);

		await screen.getByRole("button", { name: "Edit posts_authors" }).click();

		// Kumo's Select is a combobox button over a listbox, and the dialog's inert
		// overlay blocks Playwright's actionability checks — drive it through the
		// DOM, as the other dialog tests do.
		const trigger = screen.getByRole("combobox", { name: "Each Post links to", exact: true });
		await expect.element(trigger).toBeInTheDocument();
		trigger.element().click();
		await vi.waitFor(() => {
			screen.getByRole("option", { name: "At most…", exact: true }).element().click();
		});

		// Blank means the editor has not said how many yet. Saving it as "any
		// number" is the opposite of what they picked.
		await expect.element(screen.getByLabelText("Maximum")).toHaveValue(null);
		await expect.element(screen.getByRole("button", { name: "Save Relation" })).toBeDisabled();

		await screen.getByLabelText("Maximum").fill("3");
		await expect.element(screen.getByRole("button", { name: "Save Relation" })).toBeEnabled();
	});

	// The delete cascades to the fields on both ends, so the dialog says so
	// before it runs rather than reporting it afterwards.
	it("names what a delete takes before it runs", async () => {
		const onDeleteRelation = vi.fn(async () => ({}));
		const { screen } = await renderWithRoutes(
			<RelationList {...listProps({ onDeleteRelation })} />,
		);

		await screen.getByRole("button", { name: "Delete posts_authors" }).click();

		await expect
			.element(screen.getByText(/the author field on posts, which picks entries it links to/))
			.toBeInTheDocument();
		screen.getByRole("button", { name: "Delete", exact: true }).element().click();

		expect(onDeleteRelation).toHaveBeenCalledWith("rel-1");
	});

	it("keeps the dialog up when the delete fails, with the error and a retry", async () => {
		const onDeleteRelation = vi.fn(() => Promise.reject(new Error("Relation is in use")));
		const { screen } = await renderWithRoutes(
			<RelationList
				{...listProps({ onDeleteRelation, deleteError: new Error("Relation is in use") })}
			/>,
		);

		await screen.getByRole("button", { name: "Delete posts_authors" }).click();
		screen.getByRole("button", { name: "Delete", exact: true }).element().click();
		await expect.element(screen.getByText("Relation is in use")).toBeInTheDocument();

		// A dialog that closed on the rejected delete would take its own error
		// message with it and leave nothing to try again from.
		screen.getByRole("button", { name: "Delete", exact: true }).element().click();
		await vi.waitFor(() => expect(onDeleteRelation).toHaveBeenCalledTimes(2));
	});

	it("creates a relation from the list", async () => {
		const onCreateRelation = vi.fn(async () => ({}));
		const { screen } = await renderWithRoutes(
			<RelationList {...listProps({ relations: [], onCreateRelation })} />,
		);

		await screen.getByRole("button", { name: "New Relation" }).click();
		await selectOption(screen, "Links from", "Posts");
		await selectOption(screen, "Links to", "Authors");
		screen.getByRole("button", { name: "Create Relation" }).element().click();

		await vi.waitFor(() => {
			expect(onCreateRelation).toHaveBeenCalledWith({
				slug: "posts_authors",
				parentCollection: "posts",
				childCollection: "authors",
				parentLabel: "Posts",
				parentLabelSingular: "Post",
				childLabel: "Authors",
				childLabelSingular: "Author",
				maxChildrenPerParent: null,
				maxParentsPerChild: null,
			});
		});
	});

	// The roles come from the content types, and the slug from the roles — so a
	// renamed side renames the relation with it.
	it("names the relation after the roles rather than the content types", async () => {
		const onCreateRelation = vi.fn(async () => ({}));
		const { screen } = await renderWithRoutes(
			<RelationList {...listProps({ relations: [], onCreateRelation })} />,
		);

		await screen.getByRole("button", { name: "New Relation" }).click();
		await selectOption(screen, "Links from", "Posts");
		await selectOption(screen, "Links to", "Authors");
		await screen.getByLabelText("Linked side (plural)").fill("Writers");

		await expect
			.element(screen.getByLabelText("Slug", { exact: true }))
			.toHaveValue("posts_writers");
	});
});

describe("relation routes", () => {
	// `/content-types/relations` sits inside `/content-types/$slug`'s space. If
	// the dynamic route ever wins, the page becomes a collection editor for a
	// collection named "relations" — a 404 the user cannot act on.
	it("prefers the relations route over the collection editor", () => {
		const router = createAdminRouter(createTestQueryClient());

		const matchIds = (pathname: string) =>
			router.matchRoutes({ pathname, search: {}, hash: "", href: pathname, state: {} }).at(-1)
				?.routeId;

		expect(matchIds("/content-types/relations")).toBe("/_admin/content-types/relations");
		expect(matchIds("/content-types/posts")).toBe("/_admin/content-types/$slug");
	});
});
