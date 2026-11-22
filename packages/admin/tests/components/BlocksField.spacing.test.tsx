import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, type Locator } from "vitest/browser";

import "../../dist/styles.css";
import { ContentEditor, type FieldDescriptor } from "../../src/components/ContentEditor.js";
import type { ContentItem } from "../../src/lib/api";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
		useBlocker: () => ({ status: "idle" }),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
		fetchReferenceChildren: vi.fn(async () => ({ children: [] })),
	};
});

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => null,
	useHasApplicableTaxonomies: () => false,
}));

const fields: BlockFieldDefinition[] = [
	{ slug: "headline", label: "Headline", type: "string" },
	{ slug: "subheadline", label: "Subheadline", type: "text" },
	{ slug: "eyebrow", label: "Label above headline", type: "string" },
	{
		slug: "testimonials",
		label: "Testimonials",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "name", label: "Name", type: "string" },
				{ slug: "quote", label: "Quote", type: "text" },
				{ slug: "role", label: "Role or title", type: "string" },
				{ slug: "company", label: "Company", type: "string" },
				{ slug: "avatar", label: "Avatar", type: "image" },
			],
		},
	},
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{ slug: "primary_cta_url", label: "Primary button link", type: "string" },
	{ slug: "secondary_cta_label", label: "Secondary button text", type: "string" },
	{ slug: "secondary_cta_url", label: "Secondary button link", type: "string" },
	{ slug: "anchor_id", label: "Section ID", type: "string" },
];

const showcase: BlockType = {
	id: "showcase-type",
	slug: "showcase",
	label: "Showcase",
	currentVersion: 1,
	source: "seed",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	versions: [
		{
			id: "showcase-v1",
			blockTypeId: "showcase-type",
			version: 1,
			fields,
			fingerprint: "showcase",
			active: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	],
};

const block = {
	_type: "showcase",
	_version: 1,
	_key: "showcase-1",
	headline: "Every building, running at its best.",
	subheadline: "Halden finds the waste and fixes it.",
	eyebrow: "Platform",
	testimonials: [
		{
			name: "Maya Okafor",
			quote: "We found more savings in the first month than in five years of audits.",
			role: "Director of Facilities",
			company: "Calder University",
		},
		{ name: "Daniel Reyes", quote: "It paid for itself.", role: "Head of Sustainability" },
	],
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	secondary_cta_label: "See how it works",
	secondary_cta_url: "/#platform",
	anchor_id: "pricing",
};

function renderEditor() {
	const descriptors: Record<string, FieldDescriptor> = {
		title: { kind: "string", label: "Title" },
		content: {
			kind: "blocks",
			label: "Content",
			validation: { allowedTypes: ["showcase"], retiredTypes: [] },
			blockTypes: [showcase],
		},
	};
	const item: ContentItem = {
		id: "page-1",
		type: "pages",
		slug: "home",
		status: "draft",
		data: { title: "Home", content: [block] },
		authorId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
	return render(
		<ContentEditor
			collection="pages"
			collectionLabel="Page"
			fields={descriptors}
			isNew={false}
			item={item}
			onSave={vi.fn()}
		/>,
		{ wrapper: Toasty },
	);
}

function box(target: Locator | Element): DOMRect {
	return (target instanceof Element ? target : target.element()).getBoundingClientRect();
}

/** The vertical space between two boxes, the first above the second. */
function gap(above: Locator | Element, below: Locator | Element): number {
	return box(below).top - box(above).bottom;
}

const control = (name: string) => page.getByRole("textbox", { name, exact: true });
const label = (text: string) =>
	page.getByText(text, { exact: true }).first().element().closest('label, [id$="-label"]')!;
const itemOf = (title: string) =>
	page.getByRole("button", { name: title, exact: true }).element().closest('[role="listitem"]')!;

async function openShowcase() {
	await renderEditor();
	await page.getByRole("button", { name: "Showcase", exact: true }).click();
	await page.getByRole("button", { name: "Maya Okafor", exact: true }).click();
	await expect.element(control("Quote")).toBeVisible();
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await page.viewport(1280, 800);
});

describe("Spacing inside an open block", () => {
	it("spaces each level further apart than the level inside it", async () => {
		await openShowcase();

		const head = page
			.getByRole("button", { name: "Showcase", exact: true })
			.element().parentElement!;
		const underHead = gap(head, label("Headline"));
		const afterInput = gap(control("Headline"), label("Subheadline"));
		const afterTextArea = gap(control("Subheadline"), label("Label above headline"));
		const beforeSettings = gap(
			page.getByRole("button", { name: "Add item" }),
			control("Primary button text"),
		);
		const betweenRows = gap(control("Primary button text"), control("Secondary button text"));
		const beforeAdvanced = gap(
			control("Secondary button text"),
			page.getByRole("button", { name: /^Advanced/ }),
		);

		// A text area leaves no more space under it than a one-line field.
		expect(Math.abs(afterTextArea - afterInput)).toBeLessThanOrEqual(0.5);
		expect(betweenRows).toBeLessThan(beforeAdvanced);
		expect(beforeAdvanced).toBeLessThan(underHead);
		expect(underHead).toBeLessThan(afterInput);
		expect(afterInput).toBeLessThan(beforeSettings);
	});

	it("keeps a list's rows close to its label, and an open item's fields closer than the block's", async () => {
		await openShowcase();

		const first = itemOf("Maya Okafor");
		const second = itemOf("Daniel Reyes");
		const underListLabel = gap(label("Testimonials"), first);
		const betweenItems = gap(first, second);
		const betweenBlockFields = gap(control("Headline"), label("Subheadline"));
		const betweenItemFields = gap(control("Quote"), label("Role or title"));
		const beforeItemSettings = gap(control("Company"), label("Avatar"));

		expect(betweenItems).toBeLessThan(underListLabel);
		expect(underListLabel).toBeLessThan(betweenItemFields);
		expect(betweenItemFields).toBeLessThan(betweenBlockFields);
		expect(beforeItemSettings).toBeLessThanOrEqual(betweenItemFields);

		const lines = [...first.querySelectorAll("*")].filter((element) => {
			const style = getComputedStyle(element);
			return style.borderTopStyle !== "none" && Number.parseFloat(style.borderTopWidth) > 0;
		});
		expect(lines.filter((line) => box(line).height <= 1)).toEqual([]);
	});

	it.each(["ltr", "rtl"] as const)(
		"leaves as much room after an open block's fields as before them (%s)",
		async (dir) => {
			document.documentElement.dir = dir;
			await openShowcase();

			const row = box(
				page
					.getByRole("button", { name: "Showcase", exact: true })
					.element()
					.closest("[data-block-key]")!,
			);
			const card = box(itemOf("Maya Okafor"));
			expect(card.left - row.left).toBeGreaterThan(30);
			expect(Math.abs(card.left - row.left - (row.right - card.right))).toBeLessThan(0.5);
		},
	);

	it("spaces an item's stacked settings like its fields on a narrow screen", async () => {
		await page.viewport(400, 800);
		await openShowcase();

		await expect
			.poll(() => box(label("Avatar")).bottom)
			.toBeLessThanOrEqual(box(page.getByRole("button", { name: "Select image" })).top);
		const betweenItemFields = gap(control("Role or title"), label("Company"));
		const beforeItemSettings = gap(control("Company"), label("Avatar"));
		expect(Math.abs(beforeItemSettings - betweenItemFields)).toBeLessThanOrEqual(0.5);
	});

	it.each(["ltr", "rtl"] as const)(
		"summarises the Advanced fields on the toggle's own line, by name (%s)",
		async (dir) => {
			document.documentElement.dir = dir;
			await openShowcase();

			const advanced = page.getByRole("button", { name: /^Advanced/ });
			const summary = advanced.getByText("Section ID: pricing", { exact: true });
			await expect.element(summary).toBeVisible();
			const name = box(advanced.getByText("Advanced", { exact: true }));
			const after = box(summary);
			expect(Math.abs(after.top + after.height / 2 - (name.top + name.height / 2))).toBeLessThan(2);
			const distance = dir === "rtl" ? name.left - after.right : after.left - name.right;
			expect(distance).toBeGreaterThan(0);
			expect(distance).toBeLessThan(32);

			await advanced.click();
			await expect.element(control("Section ID")).toHaveValue("pricing");
			expect(summary.query()).toBeNull();
		},
	);
});
