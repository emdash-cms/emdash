import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { RelationList } from "../../src/components/RelationList.js";
import type { RelationWithUsage } from "../../src/lib/api/relations.js";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: { children: React.ReactNode; to?: string }) => (
			<a href={typeof to === "string" ? to : "#"} {...props}>
				{children}
			</a>
		),
	};
});

const relations: RelationWithUsage[] = [
	{
		id: "rel-1",
		slug: "case_studies_featured_team_members",
		parentCollection: "case_studies",
		childCollection: "team_members",
		parentLabel: "Case studies",
		parentLabelSingular: "Case study",
		childLabel: "Featured team members",
		childLabelSingular: "Featured team member",
		maxChildrenPerParent: null,
		maxParentsPerChild: null,
		boundFields: [
			{ collectionSlug: "case_studies", fieldSlug: "featured_team_members", side: "parent" },
		],
		linkCount: 128,
	},
	{
		id: "rel-2",
		slug: "posts_authors",
		parentCollection: "posts",
		childCollection: "authors",
		parentLabel: "Posts",
		parentLabelSingular: "Post",
		childLabel: "Authors",
		childLabelSingular: "Author",
		maxChildrenPerParent: 1,
		maxParentsPerChild: null,
		boundFields: [],
		linkCount: 1,
	},
];

function renderList(width: number) {
	return render(
		<div style={{ width }}>
			<RelationList
				relations={relations}
				collections={[]}
				onCreateRelation={vi.fn(async () => ({}))}
				onUpdateRelation={vi.fn(async () => ({}))}
				onDeleteRelation={vi.fn(async () => ({}))}
			/>
		</div>,
	);
}

type Screen = Awaited<ReturnType<typeof renderList>>;

function slugCell(screen: Screen, slug: string) {
	return page.elementLocator(
		screen
			.getByRole("button", { name: `Edit ${slug}` })
			.element()
			.closest("td")!,
	);
}

function expectInside(element: Element, box: DOMRect) {
	const bounds = element.getBoundingClientRect();
	expect(bounds.left).toBeGreaterThanOrEqual(box.left);
	expect(bounds.right).toBeLessThanOrEqual(box.right);
}

function visibleCount(elements: Element[]) {
	return elements.filter((element) => element.checkVisibility()).length;
}

describe("Relations table at phone width", () => {
	it("fits the header's title and button on the page", async () => {
		const screen = await renderList(272);
		const box = screen.container.firstElementChild!.getBoundingClientRect();

		expectInside(screen.getByRole("button", { name: "New Relation" }).element(), box);
		const heading = screen.getByRole("heading", { name: "Relations" }).element();
		expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth);
	});

	it("keeps what each relation connects, its links and fields, and its actions in view", async () => {
		const screen = await renderList(272);
		const table = screen.getByRole("table").element();
		const tray = table.parentElement!;
		const featured = slugCell(screen, "case_studies_featured_team_members");

		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
		await expect.element(featured.getByText("team_members", { exact: true })).toBeVisible();
		await expect.element(featured.getByText("128 links")).toBeVisible();
		await expect.element(featured.getByText("1 field", { exact: true })).toBeVisible();
		await expect
			.element(slugCell(screen, "posts_authors").getByText("No fields", { exact: true }))
			.toBeVisible();
		const actions = screen.getByRole("button", { name: /^Actions for / }).elements();
		expect(actions).toHaveLength(2);
		for (const button of actions) {
			expectInside(button, tray.getBoundingClientRect());
		}
	});
});

describe("Relations table at tablet width", () => {
	it("shows each relation's ends, fields, and links once", async () => {
		const screen = await renderList(716);
		const table = screen.getByRole("table").element();
		const tray = table.parentElement!;

		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
		expect(visibleCount(screen.getByText("team_members", { exact: true }).elements())).toBe(1);
		expect(visibleCount(screen.getByText("128 links", { exact: true }).elements())).toBe(1);
		expect(visibleCount(screen.getByText("No fields", { exact: true }).elements())).toBe(1);
		await expect
			.element(screen.getByText("case_studies.featured_team_members", { exact: true }))
			.toBeVisible();
		await expect.element(screen.getByText("1 field", { exact: true })).not.toBeVisible();
	});
});

describe("Relations table at desktop width", () => {
	it("keeps a long slug on one line", async () => {
		const screen = await renderList(1200);
		const slug = screen
			.getByRole("button", { name: "Edit case_studies_featured_team_members" })
			.element()
			.querySelector("code")!;
		const range = document.createRange();
		range.selectNodeContents(slug);

		expect(range.getClientRects()).toHaveLength(1);
	});
});
