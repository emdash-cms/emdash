import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";

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

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: (props: { open: boolean; title?: string }) =>
		props.open ? <div data-testid="media-picker">{props.title}</div> : null,
}));

const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'/%3E";

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

function list(
	slug: string,
	label: string,
	subFields: Array<Record<string, unknown>>,
	limits: { minItems?: number; maxItems?: number } = {},
): BlockFieldDefinition {
	return { slug, label, type: "repeater", validation: { ...limits, subFields } };
}

const clients = blockType("clients", "Clients", [
	{ slug: "heading", label: "Heading", type: "string" },
	list("clients", "Clients", [{ slug: "name", label: "Name", type: "string", required: true }], {
		maxItems: 4,
	}),
]);

const testimonials = blockType("testimonials", "Testimonials", [
	{ slug: "headline", label: "Section label", type: "string" },
	list(
		"quotes",
		"Testimonials",
		[
			{ slug: "quote", label: "Quote", type: "text", required: true },
			{ slug: "author", label: "Author name", type: "string", required: true },
			{ slug: "role", label: "Role or title", type: "string" },
			{ slug: "company", label: "Company", type: "string" },
			{ slug: "avatar", label: "Avatar", type: "image" },
		],
		{ minItems: 1, maxItems: 4 },
	),
]);

const maya = {
	quote: "We found more savings in the first month.",
	author: "Maya Okafor",
	role: "Director of Facilities",
	company: "Calder University",
};
const jonas = { quote: "The numbers finally add up.", author: "Jonas Berg", role: "Operations" };
const ines = { quote: "Our buildings run themselves.", author: "Ines Duarte" };

function clientsBlock(names: string[], key = "clients-1"): StoredBlockValue {
	return {
		_type: "clients",
		_version: 1,
		_key: key,
		heading: "Clients",
		clients: names.map((name) => ({ name })),
	};
}

function testimonialsBlock(
	quotes: Array<Record<string, unknown>> = [maya, jonas, ines],
	key = "quotes-1",
): StoredBlockValue {
	return { _type: "testimonials", _version: 1, _key: key, quotes };
}

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
			blockTypes={[clients, testimonials]}
			allowedTypes={["clients", "testimonials"]}
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

function renderHarness(props: HarnessProps) {
	return render(<Harness {...props} />, { wrapper: Toasty });
}

function line(position: number): Locator {
	return page.getByRole("textbox", { name: `Name ${position}`, exact: true });
}

function lineValues(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLInputElement>("[role='list'] li input"),
		(input) => input.value,
	);
}

function lastNames(onValue: ReturnType<typeof vi.fn>): unknown[] {
	const blocks = onValue.mock.lastCall?.[0] as StoredBlockValue[];
	const names = blocks[0]?.clients as Array<{ name: unknown }>;
	return names.map((client) => client.name);
}

function paste(target: Locator, text: string) {
	const data = new DataTransfer();
	data.setData("text/plain", text);
	target
		.element()
		.dispatchEvent(
			new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
		);
}

async function openBlock(name: string) {
	await page.getByRole("button", { name, exact: true }).click();
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await page.viewport(1280, 800);
});

describe("Type-in lists inside a block", () => {
	it("adds a line after the current one on Enter, removes an empty one on Backspace, and moves with the arrow keys", async () => {
		const onValue = vi.fn();
		await renderHarness({ initial: [clientsBlock(["Hotel Wilde", "Norma"])], onValue });
		await openBlock("Clients");

		await line(1).click();
		await userEvent.keyboard("{Enter}");
		await expect.element(line(2)).toHaveFocus();
		expect(lineValues()).toEqual(["Hotel Wilde", "", "Norma"]);
		await userEvent.keyboard("Arc");
		expect(lastNames(onValue)).toEqual(["Hotel Wilde", "Arc", "Norma"]);

		await userEvent.keyboard("{ArrowUp}");
		await expect.element(line(1)).toHaveFocus();
		await userEvent.keyboard("{ArrowDown}{ArrowDown}");
		await expect.element(line(3)).toHaveFocus();

		await line(2).click();
		await userEvent.keyboard("{Enter}");
		await expect.element(line(3)).toHaveFocus();
		await userEvent.keyboard("{Backspace}");
		expect(lineValues()).toEqual(["Hotel Wilde", "Arc", "Norma"]);
		await expect.element(line(2)).toHaveFocus();
		const input = line(2).element() as HTMLInputElement;
		expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
		expect(lastNames(onValue)).toEqual(["Hotel Wilde", "Arc", "Norma"]);
	});

	it("keeps blank lines out of the value and drops them when focus leaves the list", async () => {
		const onValue = vi.fn();
		await renderHarness({ initial: [clientsBlock(["Hotel Wilde", "Norma"])], onValue });
		await openBlock("Clients");

		await line(2).click();
		await userEvent.keyboard("{Enter}");
		await userEvent.keyboard("   ");
		await userEvent.keyboard("{Enter}");
		expect(lineValues()).toEqual(["Hotel Wilde", "Norma", "   ", ""]);
		for (const [blocks] of onValue.mock.calls as Array<[StoredBlockValue[]]>) {
			expect(blocks[0]?.clients).toEqual([{ name: "Hotel Wilde" }, { name: "Norma" }]);
		}

		await page.getByRole("textbox", { name: "Heading" }).click();
		await expect.poll(lineValues).toEqual(["Hotel Wilde", "Norma"]);
		expect(page.getByRole("list", { name: "Clients" }).getByRole("listitem").all()).toHaveLength(2);
		for (const [blocks] of onValue.mock.calls as Array<[StoredBlockValue[]]>) {
			expect(blocks[0]?.clients).toEqual([{ name: "Hotel Wilde" }, { name: "Norma" }]);
		}
	});

	it("turns a pasted block of lines into one item per line, up to maxItems", async () => {
		const onValue = vi.fn();
		await renderHarness({ initial: [clientsBlock(["Hotel Wilde", "Norma"])], onValue });
		await openBlock("Clients");

		await line(2).click();
		await userEvent.keyboard("{Enter}");
		paste(line(3), "Arc Studio\n\n  Ola Ceramics  \nHet Bouwhuis\n");
		await expect.element(line(4)).toHaveFocus();
		expect(lineValues()).toEqual(["Hotel Wilde", "Norma", "Arc Studio", "Ola Ceramics"]);
		expect(lastNames(onValue)).toEqual(["Hotel Wilde", "Norma", "Arc Studio", "Ola Ceramics"]);
		expect(page.getByRole("button", { name: "Add item" }).query()).toBeNull();
	});
});

function listNamed(name: string): Locator {
	return page.getByRole("list", { name, exact: true });
}

function quotesOf(onValue: ReturnType<typeof vi.fn>): unknown {
	const blocks = onValue.mock.lastCall?.[0] as StoredBlockValue[];
	return blocks.find((block) => block._type === "testimonials")?.quotes;
}

async function itemMenu(name: string, action: string) {
	await page.getByRole("button", { name: `${name} actions`, exact: true }).click();
	await page.getByRole("menuitem", { name: action }).click();
}

describe("Expandable items inside a block", () => {
	it("edits an open item's title in its row and shows it on the closed item", async () => {
		const onValue = vi.fn();
		await renderHarness({ initial: [testimonialsBlock()], onValue });
		await openBlock("Testimonials");

		const first = page.getByRole("button", { name: "Maya Okafor", exact: true });
		await expect.element(first).toHaveAttribute("aria-expanded", "false");
		await expect
			.element(first)
			.toHaveAccessibleDescription("Director of Facilities · Calder University");
		await first.click();
		const title = page.getByRole("textbox", { name: "Author name", exact: true });
		await expect.element(title).toHaveValue("Maya Okafor");
		await expect.element(title).toHaveAttribute("placeholder", "Author name");
		await expect
			.element(page.getByRole("textbox", { name: "Quote", exact: true }))
			.toHaveValue(maya.quote);

		await title.fill("Maya O.");
		expect((quotesOf(onValue) as unknown[])[0]).toEqual({ ...maya, author: "Maya O." });
		await page.getByRole("button", { name: "Maya O.", exact: true }).click();
		await expect
			.element(page.getByRole("button", { name: "Maya O.", exact: true }))
			.toHaveAttribute("aria-expanded", "false");

		await page.getByRole("button", { name: "Ines Duarte", exact: true }).click();
		await page.getByRole("textbox", { name: "Author name", exact: true }).fill("");
		await page.getByRole("button", { name: "Untitled", exact: true }).click();
		await expect
			.element(listNamed("Testimonials").getByText("Untitled", { exact: true }))
			.toBeVisible();
	});

	it("moves, duplicates and deletes items from their menu, and Undo puts a deleted item back", async () => {
		const onValue = vi.fn();
		await renderHarness({ initial: [testimonialsBlock()], onValue });
		await openBlock("Testimonials");

		await itemMenu("Maya Okafor", "Move down");
		expect(quotesOf(onValue)).toEqual([jonas, maya, ines]);
		await itemMenu("Maya Okafor", "Move up");
		expect(quotesOf(onValue)).toEqual([maya, jonas, ines]);

		await itemMenu("Jonas Berg", "Duplicate");
		expect(quotesOf(onValue)).toEqual([maya, jonas, jonas, ines]);
		const copies = page.getByRole("button", { name: "Jonas Berg", exact: true });
		await expect.element(copies.nth(0)).toHaveAttribute("aria-expanded", "false");
		await expect.element(copies.nth(1)).toHaveAttribute("aria-expanded", "true");
		await page.getByRole("textbox", { name: "Role or title" }).fill("Head of Operations");
		const copy = { ...jonas, role: "Head of Operations" };
		expect(quotesOf(onValue)).toEqual([maya, jonas, copy, ines]);

		await page.getByRole("button", { name: "Jonas Berg actions" }).nth(1).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await expect.poll(() => quotesOf(onValue)).toEqual([maya, jonas, ines]);
		await expect.element(page.getByText("Deleted Jonas Berg")).toBeVisible();
		await page.getByRole("button", { name: "Undo" }).click();
		expect(quotesOf(onValue)).toEqual([maya, jonas, copy, ines]);
		await expect
			.element(page.getByRole("button", { name: "Jonas Berg", exact: true }).nth(1))
			.toHaveFocus();
	});

	it("shares Undo with blocks, so only the latest deletion of either comes back", async () => {
		const onValue = vi.fn();
		await renderHarness({
			initial: [testimonialsBlock(), clientsBlock(["Hotel Wilde"])],
			onValue,
		});
		await openBlock("Testimonials");

		await itemMenu("Ines Duarte", "Delete");
		await expect.element(page.getByText("Deleted Ines Duarte")).toBeVisible();
		await itemMenu("Clients", "Delete");
		await expect.element(page.getByText("Deleted Clients")).toBeVisible();
		await expect.poll(() => page.getByRole("button", { name: "Undo" }).all()).toHaveLength(1);
		await page.getByRole("button", { name: "Undo" }).click();
		const restored = onValue.mock.lastCall?.[0] as StoredBlockValue[];
		expect(restored.map((block) => block._key)).toEqual(["quotes-1", "clients-1"]);
		expect(quotesOf(onValue)).toEqual([maya, jonas]);

		await itemMenu("Clients", "Delete");
		await expect.element(page.getByText("Deleted Clients")).toBeVisible();
		await itemMenu("Jonas Berg", "Delete");
		await expect.element(page.getByText("Deleted Jonas Berg")).toBeVisible();
		await expect.poll(() => page.getByRole("button", { name: "Undo" }).all()).toHaveLength(1);
		await page.getByRole("button", { name: "Undo" }).click();
		const blocks = onValue.mock.lastCall?.[0] as StoredBlockValue[];
		expect(blocks.map((block) => block._key)).toEqual(["quotes-1"]);
		expect(quotesOf(onValue)).toEqual([maya, jonas]);
	});

	it("disables Delete at minItems, and hides Add item and disables Duplicate at maxItems", async () => {
		await renderHarness({
			initial: [
				testimonialsBlock([maya]),
				testimonialsBlock([maya, jonas, ines, { author: "Ola" }], "quotes-2"),
				clientsBlock(["Hotel Wilde", "Norma", "Arc", "Ola"]),
			],
		});
		await page.getByRole("button", { name: "Expand all" }).click();
		const [short, full] = listNamed("Testimonials").all();

		await short!.getByRole("button", { name: "Maya Okafor actions" }).click();
		await expect
			.element(page.getByRole("menuitem", { name: "Delete" }))
			.toHaveAttribute("aria-disabled", "true");
		await userEvent.keyboard("{Escape}");

		await full!.getByRole("button", { name: "Ola actions" }).click();
		await expect
			.element(page.getByRole("menuitem", { name: "Duplicate" }))
			.toHaveAttribute("aria-disabled", "true");
		await expect
			.element(page.getByRole("menuitem", { name: "Delete" }))
			.not.toHaveAttribute("aria-disabled");
		await userEvent.keyboard("{Escape}");
		expect(page.getByRole("button", { name: "Add item" }).all()).toHaveLength(1);

		await line(4).click();
		await userEvent.keyboard("{Enter}");
		expect(lineValues()).toEqual(["Hotel Wilde", "Norma", "Arc", "Ola"]);
	});
});

describe("Read-only lists", () => {
	it("show every item open and ignore Enter and Backspace, with no menus or Add item", async () => {
		const onValue = vi.fn();
		await renderHarness({
			initial: [testimonialsBlock([maya, jonas]), clientsBlock(["Hotel Wilde", ""])],
			readOnly: true,
			onValue,
		});

		await expect
			.element(page.getByRole("textbox", { name: "Author name" }).nth(1))
			.toHaveValue("Jonas Berg");
		expect(page.getByRole("button", { name: "Maya Okafor", exact: true }).query()).toBeNull();
		expect(page.getByRole("button", { name: / actions$/ }).all()).toHaveLength(0);
		expect(page.getByRole("button", { name: "Add item" }).query()).toBeNull();

		await line(2).click();
		await userEvent.keyboard("{Backspace}");
		await line(1).click();
		await userEvent.keyboard("{Enter}");
		await page.getByRole("textbox", { name: "Author name" }).nth(0).click();
		expect(lineValues()).toEqual(["Hotel Wilde", ""]);
		expect(onValue).not.toHaveBeenCalled();
	});
});

const stats = blockType("stats", "Stats", [
	list("stats", "Stats", [
		{ slug: "value", label: "Value", type: "string", required: true },
		{ slug: "label", label: "Label", type: "string", required: true },
	]),
]);

const logos = blockType("logos", "Logo wall", [
	list("logos", "Logos", [
		{ slug: "name", label: "Company name", type: "string", required: true },
		{ slug: "logo", label: "Logo", type: "image" },
	]),
]);

const scores = blockType("scores", "Scores", [
	list("scores", "Scores", [
		{ slug: "score", label: "Score", type: "number" },
		{ slug: "label", label: "Label", type: "string" },
	]),
]);

const events = blockType("events", "Events", [
	list("events", "Events", [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "starts", label: "Starts", type: "datetime" },
		{ slug: "kind", label: "Kind", type: "select", options: ["Talk", "Workshop"] },
		{ slug: "link", label: "Link", type: "url" },
	]),
	list("socials", "Social links", [
		{ slug: "network", label: "Network", type: "select", options: ["Mastodon", "Bluesky"] },
		{ slug: "url", label: "Profile", type: "url" },
	]),
]);

function editorFields(blockTypes: BlockType[]): Record<string, FieldDescriptor> {
	return {
		title: { kind: "string", label: "Title" },
		content: {
			kind: "blocks",
			label: "Content",
			validation: { allowedTypes: blockTypes.map((type) => type.slug), retiredTypes: [] },
			blockTypes,
		},
	};
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
	return render(
		<ContentEditor
			collection="pages"
			collectionLabel="Page"
			fields={editorFields(blockTypes)}
			isNew={false}
			item={item}
			onSave={vi.fn()}
			{...props}
		/>,
		{ wrapper: Toasty },
	);
}

function savedContent(onSave: ReturnType<typeof vi.fn>): StoredBlockValue[] {
	return onSave.mock.lastCall?.[0].data.content;
}

async function save() {
	await page.getByRole("button", { name: "Save" }).first().click();
}

describe("Tables inside a block", () => {
	it("edits each cell's sub-field, opens the media picker from an image cell, and widens a second text column", async () => {
		const onSave = vi.fn();
		await renderEditor(
			[
				{
					_type: "logos",
					_version: 1,
					_key: "logos-1",
					logos: [{ name: "Arc", logo: { id: "media-1", src: PHOTO } }, { name: "Norma" }],
				},
				{
					_type: "stats",
					_version: 1,
					_key: "stats-1",
					stats: [{ value: "23%", label: "Lower energy spend, on average" }],
				},
			],
			[logos, stats],
			{ onSave },
		);
		await page.getByRole("button", { name: "Expand all" }).click();

		const table = page.getByRole("table", { name: "Logos" });
		await expect.element(table.getByRole("columnheader", { name: "Company name" })).toBeVisible();
		await expect.element(table.getByRole("columnheader", { name: "Logo" })).toBeVisible();
		const rows = table.getByRole("row").all();
		expect(rows).toHaveLength(3);
		await rows[2]!.getByRole("textbox", { name: "Company name 2" }).fill("Norma Studio");
		await rows[1]!.getByRole("button", { name: "Replace Logo" }).click();
		await expect.element(page.getByTestId("media-picker")).toHaveTextContent("Replace Logo");

		const value = page.getByRole("textbox", { name: "Value 1" }).element();
		const label = page.getByRole("textbox", { name: "Label 1" }).element();
		expect(label.getBoundingClientRect().width / value.getBoundingClientRect().width).toBeCloseTo(
			3,
			0,
		);

		await page.getByRole("textbox", { name: "Title" }).fill("Home page");
		await save();
		expect(savedContent(onSave)[0]?.logos).toEqual([
			{ name: "Arc", logo: { id: "media-1", src: PHOTO } },
			{ name: "Norma Studio" },
		]);
	});

	it("focuses a new row's number input when its first column is a number", async () => {
		await renderEditor([{ _type: "scores", _version: 1, _key: "scores-1", scores: [] }], [scores]);
		await page.getByRole("button", { name: "Scores", exact: true }).click();

		await page.getByRole("button", { name: "Add item" }).click();
		await expect.element(page.getByRole("spinbutton", { name: "Score 1" })).toHaveFocus();
	});

	it("keeps the columns side by side at phone width", async () => {
		await page.viewport(375, 800);
		await renderEditor(
			[
				{
					_type: "stats",
					_version: 1,
					_key: "stats-1",
					stats: [{ value: "23%", label: "Lower energy spend, on average" }],
				},
			],
			[stats],
		);
		await page.getByRole("button", { name: "Stats", exact: true }).click();

		const value = page.getByRole("textbox", { name: "Value 1" }).element().getBoundingClientRect();
		const label = page.getByRole("textbox", { name: "Label 1" }).element().getBoundingClientRect();
		expect(Math.abs(value.top - label.top)).toBeLessThan(2);
		expect(label.left).toBeGreaterThanOrEqual(value.right);
	});
});

describe("Lists inside a block in the editor", () => {
	it("keeps a blank line while you type in the next one, and saves only the typed lines", async () => {
		const onSave = vi.fn();
		await renderEditor([clientsBlock(["Hotel Wilde"])], [clients], { onSave });
		await page.getByRole("button", { name: "Clients", exact: true }).click();

		await line(1).click();
		await userEvent.keyboard("{Enter}{Enter}Norma");
		expect(lineValues()).toEqual(["Hotel Wilde", "", "Norma"]);
		await expect.element(line(3)).toHaveFocus();

		await page.getByRole("textbox", { name: "Title", exact: true }).fill("Home page");
		expect(lineValues()).toEqual(["Hotel Wilde", "Norma"]);
		await save();
		expect(savedContent(onSave)[0]?.clients).toEqual([{ name: "Hotel Wilde" }, { name: "Norma" }]);
	});

	it("starts new items without empty text for link, choice and date sub-fields, and clears a link to null", async () => {
		const onSave = vi.fn();
		await renderEditor(
			[{ _type: "events", _version: 1, _key: "events-1", events: [], socials: [] }],
			[events],
			{ onSave },
		);
		await page.getByRole("button", { name: "Events", exact: true }).click();

		const [eventsAdd, socialsAdd] = page.getByRole("button", { name: "Add item" }).all();
		await eventsAdd!.click();
		const title = page.getByRole("textbox", { name: "Title", exact: true }).nth(1);
		await expect.element(title).toHaveFocus();
		await title.fill("Open day");
		await socialsAdd!.click();
		await expect.element(page.getByRole("combobox", { name: "Network 1" })).toHaveFocus();
		const profile = page.getByRole("textbox", { name: "Profile 1" });
		await profile.fill("https://example.com");
		await profile.fill("");

		await page.getByRole("textbox", { name: "Title", exact: true }).first().fill("Home page");
		await save();
		const [block] = savedContent(onSave);
		expect(block?.events).toEqual([{ title: "Open day" }]);
		expect(block?.socials).toEqual([{ url: null }]);
	});

	it("opens a closed item that fails on Save and focuses its field", async () => {
		const onSave = vi.fn();
		await renderEditor(
			[
				{
					_type: "testimonials",
					_version: 1,
					_key: "quotes-1",
					quotes: [maya, { ...jonas, quote: "" }],
				},
			],
			[testimonials],
			{ onSave },
		);

		await page.getByRole("textbox", { name: "Title" }).fill("Home page");
		await save();
		expect(onSave).not.toHaveBeenCalled();
		const item = page.getByRole("button", { name: "Jonas Berg", exact: true });
		await expect.element(item).toHaveAttribute("aria-expanded", "true");
		const quote = page.getByRole("textbox", { name: "Quote", exact: true });
		await expect.element(quote).toHaveFocus();
		await expect.element(quote).toHaveAttribute("aria-invalid", "true");
		await expect
			.element(page.getByRole("button", { name: "Maya Okafor", exact: true }))
			.toHaveAttribute("aria-expanded", "false");

		await item.click();
		await expect.element(item).toHaveAccessibleDescription(/^Has fields to fix/);
	});

	it("shows every item open with its fields disabled in a read-only entry", async () => {
		await renderEditor([testimonialsBlock([maya, jonas])], [testimonials], { readOnly: true });

		const titles = page.getByRole("textbox", { name: "Author name", exact: true });
		await expect.element(titles.nth(1)).toHaveValue("Jonas Berg");
		await expect.element(titles.nth(1)).toBeDisabled();
		expect(page.getByRole("button", { name: / actions$/ }).all()).toHaveLength(0);
		expect(page.getByRole("button", { name: "Add item" }).query()).toBeNull();
	});
});
