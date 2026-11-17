import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { BlockTypeList } from "../../src/components/BlockTypeList.js";
import { ContentTypeList } from "../../src/components/ContentTypeList.js";
import type { SchemaCollection } from "../../src/lib/api";
import type { BlockType } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
	return { ...actual, fetchRelations: vi.fn(async () => []) };
});

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

const collections = [
	{
		id: "1",
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		supports: ["drafts", "revisions", "preview", "scheduling", "search"],
		hasSeo: true,
		source: "dashboard",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	},
	{
		id: "2",
		slug: "testimonial_carousel_with_attribution",
		label: "Testimonials",
		labelSingular: "Testimonial",
		description: "Quotes from customers, shown in a carousel on the home page.",
		supports: ["drafts"],
		source: "code",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	},
] as SchemaCollection[];

function trayOf(table: Element) {
	return table.parentElement!;
}

function expectInside(element: Element, box: DOMRect) {
	const bounds = element.getBoundingClientRect();
	expect(bounds.left).toBeGreaterThanOrEqual(box.left);
	expect(bounds.right).toBeLessThanOrEqual(box.right);
}

function visibleCount(elements: Element[]) {
	return elements.filter((element) => element.checkVisibility()).length;
}

describe("Content types table", () => {
	it("keeps the header's buttons on the page in a phone-width layout", async () => {
		const screen = await render(
			<div style={{ width: 272 }}>
				<ContentTypeList collections={collections} onReorder={vi.fn()} />
			</div>,
		);
		const box = screen.container.firstElementChild!.getBoundingClientRect();

		expectInside(screen.getByRole("link", { name: "Relations" }).element(), box);
		expectInside(screen.getByRole("link", { name: "New Content Type" }).element(), box);
	});

	it("keeps each row's slug, source, and actions in a phone-width table", async () => {
		const screen = await render(
			<div style={{ width: 272 }}>
				<ContentTypeList collections={collections} onReorder={vi.fn()} />
			</div>,
		);
		const table = screen.getByRole("table").element();
		const tray = trayOf(table).getBoundingClientRect();
		const nameCell = (name: string) =>
			page.elementLocator(screen.getByRole("link", { name, exact: true }).element().closest("td")!);

		expect(trayOf(table).scrollWidth).toBeLessThanOrEqual(trayOf(table).clientWidth);
		await expect
			.element(nameCell("Testimonials").getByText("testimonial_carousel_with_attribution"))
			.toBeVisible();
		await expect.element(nameCell("Testimonials").getByText("Code")).toBeVisible();
		const actions = screen.getByRole("button", { name: /^Actions for / }).elements();
		expect(actions).toHaveLength(2);
		for (const button of actions) {
			expectInside(button, tray);
		}
	});

	it.each(["ltr", "rtl"] as const)(
		"sets the drag handle's icon 16px in from the table's edge in %s",
		async (direction) => {
			const screen = await render(
				<div dir={direction} style={{ width: 900 }}>
					<ContentTypeList collections={collections} onReorder={vi.fn()} />
				</div>,
			);
			const tray = trayOf(screen.getByRole("table").element()).getBoundingClientRect();
			const icon = screen
				.getByRole("button", { name: "Reorder Posts" })
				.element()
				.querySelector("svg")!
				.getBoundingClientRect();

			const inset = direction === "ltr" ? icon.left - tray.left : tray.right - icon.right;
			expect(inset).toBeCloseTo(16, 0);
		},
	);

	it("keeps a short slug on one line beside a long features list in a 716px table", async () => {
		const screen = await render(
			<div style={{ width: 716 }}>
				<ContentTypeList
					collections={[
						collections[0]!,
						{ ...collections[0]!, id: "3", slug: "pages", label: "Pages" },
					]}
					onReorder={vi.fn()}
				/>
			</div>,
		);
		const table = screen.getByRole("table").element();
		const slug = screen.getByRole("cell", { name: "posts", exact: true }).element();
		const range = document.createRange();
		range.selectNodeContents(slug.querySelector("code")!);

		expect(trayOf(table).scrollWidth).toBeLessThanOrEqual(trayOf(table).clientWidth);
		expect(range.getClientRects()).toHaveLength(1);
		expect(visibleCount(screen.getByText("posts", { exact: true }).elements())).toBe(1);
		expect(visibleCount(screen.getByText("pages", { exact: true }).elements())).toBe(1);
	});
});

const fingerprint = (seed: string) => `block-type:v1:sha256:${seed.repeat(64).slice(0, 64)}`;

const blockTypes: BlockType[] = [
	{
		id: "hero",
		slug: "hero_with_background_video_and_call_to_action",
		label: "Hero",
		description: "Page introduction with a heading, a lede, and a call to action.",
		currentVersion: 2,
		source: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [1, 2].map((version) => ({
			id: `v${version}`,
			blockTypeId: "hero",
			version,
			fields: [],
			fingerprint: fingerprint(String(version)),
			active: version === 2,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		})),
	},
];

describe("Block types table", () => {
	it("shows the slug and active version without scrolling sideways in a phone-width table", async () => {
		const screen = await render(
			<div style={{ width: 272 }}>
				<BlockTypeList blockTypes={blockTypes} />
			</div>,
		);
		const table = screen.getByRole("table").element();
		const nameCell = page.elementLocator(
			screen.getByText("Hero", { exact: true }).element().closest("td")!,
		);

		expect(trayOf(table).scrollWidth).toBeLessThanOrEqual(trayOf(table).clientWidth);
		await expect
			.element(nameCell.getByText("hero_with_background_video_and_call_to_action"))
			.toBeVisible();
		await expect.element(nameCell.getByText("2 versions")).toBeVisible();
		await expect.element(screen.getByText("Active v2")).toBeVisible();
	});

	it("lists every version's fingerprint without scrolling sideways in a 716px table", async () => {
		const screen = await render(
			<div style={{ width: 716 }}>
				<BlockTypeList blockTypes={blockTypes} />
			</div>,
		);
		const table = screen.getByRole("table").element();

		expect(trayOf(table).scrollWidth).toBeLessThanOrEqual(trayOf(table).clientWidth);
		await expect.element(screen.getByText(fingerprint("1"))).toBeVisible();
		await expect.element(screen.getByText(fingerprint("2"))).toBeVisible();
		expect(
			visibleCount(
				screen
					.getByText("hero_with_background_video_and_call_to_action", { exact: true })
					.elements(),
			),
		).toBe(1);
		await expect.element(screen.getByText("2 versions")).not.toBeVisible();
	});
});
