import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor.js";
import type { ContentItem } from "../../src/lib/api";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
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

function blockType(slug: string, label: string, fields: BlockFieldDefinition[]): BlockType {
	return {
		id: `${slug}-type`,
		slug,
		label,
		currentVersion: 1,
		source: "seed",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: `${slug}-v1`,
				blockTypeId: `${slug}-type`,
				version: 1,
				fields,
				fingerprint: slug,
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

const hero = blockType("hero", "Hero", [
	{ slug: "eyebrow", label: "Eyebrow (shown above the headline)", type: "string" },
	{ slug: "headline", label: "Headline", type: "string" },
	{ slug: "subheadline", label: "Subheadline", type: "text" },
]);

const note = blockType("note", "Note", [
	{ slug: "title", label: "Title", type: "string", required: true },
]);

const testimonials = blockType("testimonials", "Testimonials", [
	{
		slug: "quotes",
		label: "Testimonials",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "quote", label: "Quote", type: "text" },
				{ slug: "author", label: "Author name", type: "string" },
				{ slug: "role", label: "Role or title", type: "string" },
				{ slug: "avatar", label: "Avatar", type: "image" },
			],
		},
	},
]);

function heroBlock(key: string): StoredBlockValue {
	return { _type: "hero", _version: 1, _key: key, headline: key };
}

const quotes = [
	{ author: "Maya Okafor", quote: "Savings in the first month." },
	{ author: "Jonas Berg", quote: "The numbers add up." },
	{ author: "Ines Duarte", quote: "Our buildings run themselves." },
];

type HarnessProps = Partial<Omit<BlocksFieldProps, "value" | "onChange">> & {
	initial: StoredBlockValue[];
	onValue?: (value: StoredBlockValue[]) => void;
};

function Harness({ initial, onValue, ...props }: HarnessProps) {
	const [value, setValue] = React.useState(initial);
	return (
		<BlocksField
			id="field-layout"
			fieldPath="layout"
			label="Layout"
			value={value}
			onChange={(next) => {
				setValue(next);
				onValue?.(next);
			}}
			blockTypes={[hero, note, testimonials]}
			allowedTypes={["hero", "note", "testimonials"]}
			retiredTypes={[]}
			renderField={({ name, value: fieldValue, onChange, chrome }) => (
				<input
					id={`field-${name}`}
					aria-labelledby={chrome.labelledBy}
					aria-describedby={chrome.describedBy}
					aria-invalid={chrome.invalid || undefined}
					placeholder={chrome.placeholder}
					value={typeof fieldValue === "string" ? fieldValue : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			)}
			{...props}
		/>
	);
}

/** The field with room beside it for its gutter. */
function harness(props: HarnessProps) {
	return (
		<div style={{ width: 480, marginInline: 80 }}>
			<Harness {...props} />
		</div>
	);
}

function renderHarness(props: HarnessProps) {
	return render(harness(props), { wrapper: Toasty });
}

function renderEditor(
	content: unknown[],
	blockTypes: BlockType[],
	props: Partial<ContentEditorProps> = {},
) {
	const item: ContentItem = {
		id: "page-1",
		type: "pages",
		slug: "home",
		status: "draft",
		data: { title: "Home", content },
		authorId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
	const fields: Record<string, FieldDescriptor> = {
		title: { kind: "string", label: "Title" },
		content: {
			kind: "blocks",
			label: "Content",
			validation: { allowedTypes: blockTypes.map((type) => type.slug), retiredTypes: [] },
			blockTypes,
		},
	};
	return render(
		// A bounded height, as the admin gives it, so the editor's canvas scrolls.
		<div style={{ height: 600 }}>
			<ContentEditor
				collection="pages"
				collectionLabel="Page"
				fields={fields}
				isNew={false}
				item={item}
				onSave={vi.fn()}
				{...props}
			/>
		</div>,
		{ wrapper: Toasty },
	);
}

function rowKeys() {
	return Array.from(
		document.querySelectorAll<HTMLElement>("[data-block-key]"),
		(element) => element.dataset.blockKey,
	);
}

function row(key: string) {
	return page.elementLocator(document.querySelector(`[data-block-key="${key}"]`)!);
}

/** A row's toggle as an element, which stays the same element wherever its row moves. */
function toggleOf(key: string) {
	return document.querySelector<HTMLElement>(`[data-block-key="${key}"] [data-block-toggle]`)!;
}

function focused() {
	return document.activeElement;
}

function authors(onValue: ReturnType<typeof vi.fn>): unknown[] {
	const blocks = onValue.mock.lastCall?.[0] as StoredBlockValue[];
	const saved = blocks[0]?.quotes as Array<{ author: unknown }>;
	return saved.map((quote) => quote.author);
}

/**
 * Lays out each row's gutter, which the stylesheet shows only with a hover-capable fine pointer.
 * Chromium on Linux loses both once an earlier test file in the same page ends touch emulation.
 */
function showGutters() {
	for (const add of document.querySelectorAll<HTMLElement>('[aria-label^="Add block below"]')) {
		add.parentElement!.style.display = "flex";
	}
}

function gutterShows(key: string) {
	return document
		.querySelector<HTMLElement>(`[data-block-key="${key}"] [aria-label^="Add block below"]`)!
		.checkVisibility({ opacityProperty: true });
}

async function moveKey(arrow: "ArrowUp" | "ArrowDown") {
	await userEvent.keyboard(`{Alt>}{Shift>}{${arrow}}{/Shift}{/Alt}`);
}

interface FrameTree {
	frame: { id: string; url: string };
	childFrames?: FrameTree[];
}

function frameAt(tree: FrameTree, url: string): string | undefined {
	if (tree.frame.url === url) return tree.frame.id;
	for (const child of tree.childFrames ?? []) {
		const id = frameAt(child, url);
		if (id) return id;
	}
	return undefined;
}

/** The text a screen reader finds in this test's page, leaving out descriptions it reads with controls. */
async function textNodes(): Promise<string[]> {
	const { frameTree } = (await cdp().send("Page.getFrameTree")) as { frameTree: FrameTree };
	const { nodes } = (await cdp().send("Accessibility.getFullAXTree", {
		frameId: frameAt(frameTree, location.href),
	})) as {
		nodes: Array<{ ignored: boolean; role?: { value: string }; name?: { value: string } }>;
	};
	return nodes
		.filter((node) => !node.ignored && node.role?.value === "StaticText")
		.map((node) => node.name?.value ?? "");
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await page.viewport(1280, 800);
});

describe("Blocks field keyboard", () => {
	it("keeps the gutter's add and reorder buttons out of the Tab order, named for their block", async () => {
		const screen = await renderHarness({ initial: [heroBlock("one"), heroBlock("two")] });
		const toggle = (key: string) => row(key).getByRole("button", { name: "Hero", exact: true });

		(toggle("one").element() as HTMLElement).focus();
		await userEvent.keyboard("{Tab}");
		await expect.element(row("one").getByRole("button", { name: "Hero actions" })).toHaveFocus();
		await userEvent.keyboard("{Tab}");
		await expect.element(toggle("two")).toHaveFocus();
		await userEvent.keyboard("{Shift>}{Tab}{Tab}{/Shift}");
		await expect.element(toggle("one")).toHaveFocus();

		await expect
			.element(row("two").getByRole("button", { name: "Add block below Hero" }))
			.toBeInTheDocument();
		await expect
			.element(row("two").getByRole("button", { name: "Reorder Hero" }))
			.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add block below", exact: true }).query()).toBeNull();
	});

	it("shows a block's gutter while the menu opened from the keyboard is open, and offers adding and moving there", async () => {
		const screen = await renderHarness({ initial: [heroBlock("one"), heroBlock("two")] });
		showGutters();
		const menuButton = row("two").getByRole("button", { name: "Hero actions" });

		(menuButton.element() as HTMLElement).focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(screen.getByRole("menu")).toBeVisible();
		await expect.poll(() => gutterShows("two")).toBe(true);
		expect(gutterShows("one")).toBe(false);
		for (const name of [
			"Add block above",
			"Add block below",
			"Move up",
			"Move to top",
			"Move down",
			"Move to bottom",
		]) {
			await expect.element(screen.getByRole("menuitem", { name, exact: true })).toBeVisible();
		}
		await expect
			.element(screen.getByRole("menuitem", { name: "Move to bottom" }))
			.toHaveAttribute("aria-disabled", "true");

		await userEvent.keyboard("{Escape}");
		await expect.element(menuButton).toHaveFocus();
	});

	it("puts focus back on the drag handle when its menu closes, and hides the gutter once the pointer has left", async () => {
		const screen = await renderHarness({ initial: [heroBlock("one"), heroBlock("two")] });
		showGutters();
		const handle = row("one").getByRole("button", { name: "Reorder Hero" });

		await handle.click();
		await expect.element(screen.getByRole("menu")).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
		await expect.element(handle).toHaveFocus();
		await userEvent.hover(screen.getByText("Layout", { exact: true }));
		await expect.poll(() => gutterShows("one")).toBe(false);

		await userEvent.keyboard("{Shift}");
		await expect.poll(() => gutterShows("one")).toBe(true);
	});

	it("moves a block one place with Alt+Shift+Arrow from its head or menu button, keeping focus and announcing where", async () => {
		const onValue = vi.fn();
		const screen = await renderHarness({
			initial: [heroBlock("one"), heroBlock("two"), heroBlock("three")],
			onValue,
		});
		const toggle = toggleOf("one");

		toggle.focus();
		await moveKey("ArrowDown");
		expect(rowKeys()).toEqual(["two", "one", "three"]);
		await expect.poll(focused).toBe(toggle);
		await expect.element(screen.getByText("Moved Hero to position 2 of 3")).toBeInTheDocument();
		await moveKey("ArrowDown");
		expect(rowKeys()).toEqual(["two", "three", "one"]);
		await expect.poll(focused).toBe(toggle);
		await moveKey("ArrowDown");
		expect(rowKeys()).toEqual(["two", "three", "one"]);

		const menuButton = row("one").getByRole("button", { name: "Hero actions" }).element();
		(menuButton as HTMLElement).focus();
		await moveKey("ArrowUp");
		expect(rowKeys()).toEqual(["two", "one", "three"]);
		await expect.poll(focused).toBe(menuButton);
		expect(screen.getByRole("menu").query()).toBeNull();
		const saved = onValue.mock.lastCall?.[0] as StoredBlockValue[];
		expect(saved.map((block) => block._key)).toEqual(["two", "one", "three"]);
	});

	it("moves a block to the top or the bottom from its menu", async () => {
		const screen = await renderHarness({
			initial: [heroBlock("one"), heroBlock("two"), heroBlock("three")],
		});

		await row("two").getByRole("button", { name: "Hero actions" }).click();
		await screen.getByRole("menuitem", { name: "Move to bottom" }).click();
		expect(rowKeys()).toEqual(["one", "three", "two"]);
		await expect.element(screen.getByText("Moved Hero to position 3 of 3")).toBeInTheDocument();

		await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
		await row("two").getByRole("button", { name: "Hero actions" }).click();
		await screen.getByRole("menuitem", { name: "Move to top" }).click();
		expect(rowKeys()).toEqual(["two", "one", "three"]);
	});

	it("moves a list item with Alt+Shift+Arrow and to the top or bottom from its menu", async () => {
		const onValue = vi.fn();
		const screen = await renderHarness({
			initial: [{ _type: "testimonials", _version: 1, _key: "quotes-1", quotes }],
			onValue,
		});
		await screen.getByRole("button", { name: "Testimonials", exact: true }).click();
		const jonas = screen.getByRole("button", { name: "Jonas Berg", exact: true });
		await expect.element(jonas).toBeInTheDocument();
		const jonasToggle = jonas.element() as HTMLElement;

		jonasToggle.focus();
		await moveKey("ArrowUp");
		expect(authors(onValue)).toEqual(["Jonas Berg", "Maya Okafor", "Ines Duarte"]);
		await expect.poll(focused).toBe(jonasToggle);
		await expect
			.element(screen.getByText("Moved Jonas Berg to position 1 of 3"))
			.toBeInTheDocument();

		const menuButton = screen.getByRole("button", { name: "Jonas Berg actions" }).element();
		(menuButton as HTMLElement).focus();
		await moveKey("ArrowDown");
		expect(authors(onValue)).toEqual(["Maya Okafor", "Jonas Berg", "Ines Duarte"]);
		await expect.poll(focused).toBe(menuButton);
		expect(screen.getByRole("menu").query()).toBeNull();

		await screen.getByRole("button", { name: "Jonas Berg actions" }).click();
		await screen.getByRole("menuitem", { name: "Move to bottom" }).click();
		expect(authors(onValue)).toEqual(["Maya Okafor", "Ines Duarte", "Jonas Berg"]);
		await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
		await screen.getByRole("button", { name: "Jonas Berg actions" }).click();
		await screen.getByRole("menuitem", { name: "Move to top" }).click();
		expect(authors(onValue)).toEqual(["Jonas Berg", "Maya Okafor", "Ines Duarte"]);
	});

	it("opens a closed item from a click on its title with the caret in the title, and leaves focus on the toggle for Enter", async () => {
		const screen = await renderHarness({
			initial: [{ _type: "testimonials", _version: 1, _key: "quotes-1", quotes }],
		});
		await screen.getByRole("button", { name: "Testimonials", exact: true }).click();
		const jonas = screen.getByRole("button", { name: "Jonas Berg", exact: true });

		await screen.getByText("Jonas Berg", { exact: true }).click({ position: { x: 2, y: 8 } });
		const title = screen.getByRole("textbox", { name: "Author name", exact: true });
		await expect.element(title).toHaveFocus();
		await expect.element(title).toHaveValue("Jonas Berg");
		const input = title.element() as HTMLInputElement;
		expect(input.selectionStart).toBeLessThan(input.value.length);

		await jonas.click();
		await expect.element(jonas).toHaveAttribute("aria-expanded", "false");
		(jonas.element() as HTMLElement).focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(jonas).toHaveAttribute("aria-expanded", "true");
		await expect.element(jonas).toHaveFocus();
	});

	it("reaches an open item's fields with Tab before its menu button", async () => {
		const screen = await renderHarness({
			initial: [{ _type: "testimonials", _version: 1, _key: "quotes-1", quotes }],
		});
		await screen.getByRole("button", { name: "Testimonials", exact: true }).click();
		const jonas = screen.getByRole("button", { name: "Jonas Berg", exact: true });
		(jonas.element() as HTMLElement).focus();
		await userEvent.keyboard("{Enter}");
		const title = screen.getByRole("textbox", { name: "Author name", exact: true });
		(title.element() as HTMLElement).focus();
		const fields = screen
			.getByRole("group", { name: "Jonas Berg" })
			.getByRole("textbox")
			.elements();
		expect(fields.length).toBeGreaterThan(0);

		for (const field of fields) {
			await userEvent.keyboard("{Tab}");
			await expect.poll(focused).toBe(field);
		}
		await userEvent.keyboard("{Tab}");
		await expect.element(screen.getByRole("button", { name: "Jonas Berg actions" })).toHaveFocus();
	});

	it("reads a problem only as a description, once, and a current block's version not at all", async () => {
		const screen = await renderHarness({
			initial: [heroBlock("hero-1"), { _type: "note", _version: 1, _key: "note-1", title: "" }],
			reveal: { token: 0 },
		});
		await screen.rerender(
			harness({
				initial: [heroBlock("hero-1"), { _type: "note", _version: 1, _key: "note-1", title: "" }],
				reveal: { token: 1, focusId: "field-layout.note-1.title" },
			}),
		);
		await screen.getByRole("button", { name: "Hero", exact: true }).click();
		const eyebrow = screen.getByRole("textbox", {
			name: "Eyebrow (shown above the headline)",
			exact: true,
		});
		const noteTitle = screen.getByRole("textbox", { name: "Title", exact: true });
		await expect.element(eyebrow).not.toHaveAccessibleDescription();
		await expect.element(noteTitle).toHaveAttribute("aria-invalid", "true");
		await expect.element(noteTitle).toHaveAccessibleDescription("Required");
		await expect
			.element(row("hero-1").getByRole("button", { name: "Hero actions" }))
			.not.toHaveAccessibleDescription();

		const texts = await textNodes();
		expect(texts).not.toContain("Required");
		expect(texts).not.toContain("Version 1");
		expect(texts.filter((text) => /^Block \d/.test(text))).toEqual([]);
	});

	it("marks keyboard focus with an outline in forced colors, where rings aren't drawn", async () => {
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "forced-colors", value: "active" }],
		});
		try {
			await renderHarness({ initial: [heroBlock("one")] });
			const toggle = row("one").getByRole("button", { name: "Hero", exact: true });
			const menuButton = row("one").getByRole("button", { name: "Hero actions" });
			const outlined = (element: Element) => {
				const style = getComputedStyle(element);
				return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 1;
			};

			(menuButton.element() as HTMLElement).focus();
			await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
			await expect.element(toggle).toHaveFocus();
			expect(outlined(toggle.element())).toBe(true);
			await userEvent.keyboard("{Tab}");
			await expect.element(menuButton).toHaveFocus();
			expect(outlined(menuButton.element())).toBe(true);
		} finally {
			await cdp().send("Emulation.setEmulatedMedia", { features: [] });
		}
	});
});

describe("Blocks field inside the editor", () => {
	it("moves Enter in a block's one-line field to the next field instead of saving the page", async () => {
		const onSave = vi.fn();
		await renderEditor(
			[heroBlock("hero-1"), { _type: "note", _version: 1, _key: "note-1", title: "" }],
			[hero, note],
			{ onSave },
		);
		await page.getByRole("button", { name: "Hero", exact: true }).click();
		const headline = page.getByRole("textbox", { name: "Headline", exact: true });
		await headline.click();

		await userEvent.keyboard("{Enter}");
		await expect
			.element(page.getByRole("textbox", { name: "Subheadline", exact: true }))
			.toHaveFocus();
		await headline.click();
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		await expect.element(headline).toHaveFocus();
		expect(onSave).not.toHaveBeenCalled();
		await expect
			.element(page.getByRole("button", { name: "Note", exact: true }))
			.toHaveAttribute("aria-expanded", "false");
	});

	it("keeps focus that Shift+Tab moves up a block out from under its pinned head", async () => {
		const long = blockType(
			"long",
			"Long",
			Array.from({ length: 16 }, (_, index) => ({
				slug: `field_${index + 1}`,
				label: `Field ${index + 1}`,
				type: "text",
			})),
		);
		await renderEditor([{ _type: "long", _version: 1, _key: "long-1" }], [long]);
		await page.getByRole("button", { name: "Long", exact: true }).click();
		const field = (position: number) =>
			page.getByRole("textbox", { name: `Field ${position}`, exact: true });
		const head = document.querySelector<HTMLElement>("[data-block-head]")!;
		const canvas = document.querySelector<HTMLElement>("[data-emdash-editor-canvas]")!;
		let pinned = 0;

		await field(16).click();
		for (let position = 15; position >= 1; position--) {
			await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
			await expect.element(field(position)).toHaveFocus();
			const headBox = head.getBoundingClientRect();
			if (Math.abs(headBox.top - canvas.getBoundingClientRect().top) < 1) pinned++;
			expect(field(position).element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
				headBox.bottom,
			);
		}
		expect(pinned).toBeGreaterThan(0);
	});
});
