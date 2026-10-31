import { Toasty } from "@cloudflare/kumo";
import { Cube, Images, Sparkle } from "@phosphor-icons/react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { render } from "../utils/render.js";

function blockType(
	slug: string,
	label: string,
	fields: BlockFieldDefinition[],
	extra: Partial<BlockType> = {},
): BlockType {
	return {
		id: `${slug}-id`,
		slug,
		label,
		currentVersion: 1,
		source: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: `${slug}-v1`,
				blockTypeId: `${slug}-id`,
				version: 1,
				fields,
				fingerprint: `${slug}-v1`,
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
		...extra,
	};
}

const hero = blockType("hero", "Hero", [], {
	description: "A page hero",
	category: "Layout",
	icon: "sparkle",
	currentVersion: 2,
	versions: [
		{
			id: "hero-v1",
			blockTypeId: "hero-id",
			version: 1,
			fields: [{ slug: "heading", label: "Heading", type: "string" }],
			fingerprint: "v1",
			active: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		{
			id: "hero-v2",
			blockTypeId: "hero-id",
			version: 2,
			fields: [{ slug: "title", label: "Title", type: "string" }],
			fingerprint: "v2",
			active: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	],
});
const quote = blockType("quote", "Quote", [{ slug: "text", label: "Text", type: "text" }]);
const gallery = blockType(
	"gallery",
	"Gallery",
	[{ slug: "caption", label: "Caption", type: "string" }],
	{
		category: "Media",
		icon: "not-a-phosphor-icon",
	},
);
const blockTypes = [hero, quote, gallery];

function heroBlock(key: string, title = key): StoredBlockValue {
	return { _type: "hero", _version: 2, _key: key, title };
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
			blockTypes={blockTypes}
			allowedTypes={["hero", "gallery"]}
			retiredTypes={["quote"]}
			renderField={({ name, field, value: fieldValue, onChange }) => (
				<input
					key={name}
					id={`field-${name}`}
					aria-label={field.label}
					value={typeof fieldValue === "string" ? fieldValue : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			)}
			{...props}
		/>
	);
}

function renderField(props: HarnessProps) {
	return render(<Harness {...props} />, { wrapper: Toasty });
}

type Screen = Awaited<ReturnType<typeof renderField>>;

function rowKeys() {
	return Array.from(
		document.querySelectorAll<HTMLElement>("[data-block-key]"),
		(element) => element.dataset.blockKey,
	);
}

function row(key: string) {
	return page.elementLocator(document.querySelector(`[data-block-key="${key}"]`)!);
}

async function openMenu(key: string) {
	await row(key)
		.getByRole("button", { name: /actions$/ })
		.last()
		.click();
	await expect.element(page.getByRole("menu")).toBeVisible();
}

async function pick(screen: Screen, name: string) {
	await screen.getByRole("option", { name: new RegExp(`^${name}`) }).click();
}

function iconMarkup(icon: React.ReactElement) {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(icon);
	return container.querySelector("svg")!.innerHTML;
}

function rendersIcon(scope: Element, icon: React.ReactElement) {
	const expected = iconMarkup(icon);
	return [...scope.querySelectorAll("svg")].some((svg) => svg.innerHTML === expected);
}

describe("BlocksField", () => {
	it("starts every stored block closed", async () => {
		const screen = await renderField({ initial: [heroBlock("first"), heroBlock("second")] });

		await expect
			.element(screen.getByRole("button", { name: "Hero", exact: true }).first())
			.toHaveAttribute("aria-expanded", "false");
		expect(screen.getByLabelText("Title").query()).toBeNull();

		await screen.getByRole("button", { name: "Hero", exact: true }).first().click();
		await expect.element(screen.getByLabelText("Title")).toHaveValue("first");
		expect(screen.getByLabelText("Title").all()).toHaveLength(1);
	});

	it("edits retained versions with path-stable controls and state tags", async () => {
		const screen = await renderField({
			initial: [
				{ _type: "hero", _version: 1, _key: "hero-key", heading: "Before" },
				{ _type: "quote", _version: 1, _key: "quote-key", text: "Quoted" },
			],
		});

		await expect.element(screen.getByText("Inactive version")).toBeVisible();
		await expect.element(screen.getByText("Retired")).toBeVisible();
		expect(screen.getByText("Version 1").query()).toBeNull();

		await screen.getByRole("button", { name: "Hero", exact: true }).click();
		const heading = screen.getByLabelText("Heading");
		expect(heading.element().id).toBe("field-layout.hero-key.heading");
		await heading.fill("After");
		await expect.element(heading).toHaveValue("After");

		await openMenu("quote-key");
		await expect.element(screen.getByText("Quote · version 1")).toBeVisible();
		await expect
			.element(screen.getByRole("menuitem", { name: "Duplicate" }))
			.toHaveAttribute("aria-disabled", "true");
	});

	it("passes retained block type and version to nested field rendering", async () => {
		let renderedField:
			| { field: { id?: string; blockType?: string; blockVersion?: number } }
			| undefined;
		const screen = await render(
			<BlocksField
				id="field-layout"
				fieldId="database-field"
				fieldPath="layout"
				label="Layout"
				value={[{ _type: "hero", _version: 1, _key: "retained", heading: "Before" }]}
				onChange={vi.fn()}
				blockTypes={blockTypes}
				allowedTypes={["hero"]}
				retiredTypes={[]}
				renderField={(input) => {
					renderedField = input;
					return <input key={input.name} aria-label={input.field.label} />;
				}}
			/>,
			{ wrapper: Toasty },
		);

		await screen.getByRole("button", { name: "Hero", exact: true }).click();
		await expect.element(screen.getByLabelText("Heading")).toBeInTheDocument();
		expect(renderedField?.field).toMatchObject({
			blockType: "hero",
			blockVersion: 1,
			id: "database-field:retained:heading",
		});
		expect(renderedField?.field.id).not.toContain("field-layout");
	});

	it("opens an added block at the end with its first field focused", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(
			"00000000-0000-4000-8000-000000000001",
		);
		const screen = await renderField({ initial: [heroBlock("first")] });

		await screen.getByRole("button", { name: "Add block", exact: true }).click();
		await expect
			.element(screen.getByRole("combobox", { name: "Search block types" }))
			.toHaveFocus();
		await pick(screen, "Hero");

		expect(rowKeys()).toEqual(["first", "00000000-0000-4000-8000-000000000001"]);
		const added = row("00000000-0000-4000-8000-000000000001");
		await expect
			.element(added.getByRole("button", { name: "Hero", exact: true }))
			.toHaveAttribute("aria-expanded", "true");
		await expect.element(added.getByLabelText("Title")).toHaveFocus();
		expect(screen.getByLabelText("Title").all()).toHaveLength(1);
	});

	it("adds above and below a block from its menu and the gutter", async () => {
		const onValue = vi.fn();
		vi.spyOn(globalThis.crypto, "randomUUID")
			.mockReturnValueOnce("00000000-0000-4000-8000-00000000000a")
			.mockReturnValueOnce("00000000-0000-4000-8000-00000000000b")
			.mockReturnValueOnce("00000000-0000-4000-8000-00000000000c")
			.mockReturnValueOnce("00000000-0000-4000-8000-00000000000d");
		const screen = await renderField({ initial: [heroBlock("one"), heroBlock("two")], onValue });

		await openMenu("two");
		await screen.getByRole("menuitem", { name: "Add block above" }).click();
		await pick(screen, "Gallery");
		expect(rowKeys()).toEqual(["one", "00000000-0000-4000-8000-00000000000a", "two"]);

		await openMenu("one");
		await screen.getByRole("menuitem", { name: "Add block below" }).click();
		await pick(screen, "Hero");
		expect(rowKeys()).toEqual([
			"one",
			"00000000-0000-4000-8000-00000000000b",
			"00000000-0000-4000-8000-00000000000a",
			"two",
		]);

		await row("two").getByRole("button", { name: "Add block below" }).click();
		await pick(screen, "Hero");
		expect(rowKeys().at(-1)).toBe("00000000-0000-4000-8000-00000000000c");

		await row("one")
			.getByRole("button", { name: "Add block below" })
			.click({ modifiers: ["Alt"] });
		await pick(screen, "Hero");
		expect(rowKeys()[0]).toBe("00000000-0000-4000-8000-00000000000d");
		expect(onValue.mock.lastCall?.[0]).toHaveLength(6);
	});

	it("searches the picker and moves through its options with the keyboard", async () => {
		const screen = await renderField({ initial: [heroBlock("one")] });
		const add = row("one").getByRole("button", { name: "Add block below" });

		// A click that leaves focus where it was, as in Safari.
		(add.element() as HTMLElement).click();
		const search = screen.getByRole("combobox", { name: "Search block types" });
		await expect.element(search).toHaveFocus();
		expect(screen.getByRole("group", { name: "Layout" }).getByRole("option").all()).toHaveLength(1);
		expect(screen.getByRole("group", { name: "Media" }).getByRole("option").all()).toHaveLength(1);
		await userEvent.keyboard("{ArrowDown}");
		await expect
			.element(screen.getByRole("option", { name: /^Gallery/ }))
			.toHaveAttribute("aria-selected", "true");
		await userEvent.keyboard("{ArrowDown}");
		await expect
			.element(screen.getByRole("option", { name: /^Hero/ }))
			.toHaveAttribute("aria-selected", "true");
		await userEvent.keyboard("{Escape}");
		await expect.element(search).not.toBeInTheDocument();
		await expect.element(add).toHaveFocus();

		await add.click();
		await userEvent.keyboard("med");
		expect(screen.getByRole("option").all()).toHaveLength(1);
		await userEvent.keyboard("{Enter}");
		expect(document.querySelectorAll("[data-block-key]")).toHaveLength(2);
		await expect.element(screen.getByLabelText("Caption")).toHaveFocus();
	});

	it("duplicates a block below the original and opens the copy", async () => {
		const onValue = vi.fn();
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(
			"00000000-0000-4000-8000-000000000002",
		);
		const screen = await renderField({ initial: [heroBlock("one"), heroBlock("two")], onValue });

		await openMenu("one");
		await screen.getByRole("menuitem", { name: "Duplicate" }).click();

		expect(rowKeys()).toEqual(["one", "00000000-0000-4000-8000-000000000002", "two"]);
		expect(onValue.mock.lastCall?.[0][1]).toEqual({
			...heroBlock("one"),
			_key: "00000000-0000-4000-8000-000000000002",
		});
		await expect
			.element(row("00000000-0000-4000-8000-000000000002").getByLabelText("Title"))
			.toHaveValue("one");
		await expect
			.element(row("one").getByRole("button", { name: "Hero", exact: true }))
			.toHaveAttribute("aria-expanded", "false");
	});

	it("collapses and expands every block", async () => {
		const screen = await renderField({ initial: [heroBlock("one"), heroBlock("two")] });

		await screen.getByRole("button", { name: "Expand all" }).click();
		expect(screen.getByLabelText("Title").all()).toHaveLength(2);

		await row("one").getByRole("button", { name: "Hero", exact: true }).click();
		await screen.getByRole("button", { name: "Collapse all" }).click();
		expect(screen.getByLabelText("Title").query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Expand all" })).toBeVisible();
	});

	it("summarizes closed blocks from their text or their list's item titles", async () => {
		const promo = blockType("promo", "Promo", [
			{ slug: "eyebrow", label: "Eyebrow", type: "string" },
			{ slug: "cta_url", label: "Button link", type: "string", required: true },
			{ slug: "anchor_id", label: "Section ID", type: "string", required: true },
			{ slug: "headline", label: "Headline", type: "string", required: true },
		]);
		const clients = blockType("clients", "Clients", [
			{ slug: "heading", label: "Heading", type: "string" },
			{
				slug: "clients",
				label: "Clients",
				type: "repeater",
				validation: {
					subFields: [
						{ slug: "website", label: "Website", type: "url" },
						{ slug: "name", label: "Name", type: "string" },
					],
				},
			},
		]);
		const names = ["Hotel Wilde", "Het Bouwhuis", "Ola Ceramics", "Studio Vaag", "Norma", "Arc"];
		const screen = await renderField({
			blockTypes: [promo, clients],
			allowedTypes: ["promo", "clients"],
			initial: [
				{
					_type: "promo",
					_version: 1,
					_key: "promo",
					eyebrow: "New",
					cta_url: "/contact",
					anchor_id: "promo",
					headline: "Heat pumps that pay for themselves",
				},
				{
					_type: "clients",
					_version: 1,
					_key: "clients",
					heading: "Clients",
					clients: names.map((name) => ({ name, website: "https://example.com" })),
				},
			],
		});

		await expect
			.element(row("promo").getByText("Heat pumps that pay for themselves"))
			.toBeVisible();
		await expect
			.element(row("clients").getByText("Hotel Wilde, Het Bouwhuis, Ola Ceramics +3"))
			.toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Clients", exact: true }))
			.toHaveAccessibleDescription("Hotel Wilde, Het Bouwhuis, Ola Ceramics +3");
	});

	it("opens the block menu from the drag handle with Enter or Space", async () => {
		const screen = await renderField({ initial: [heroBlock("one")] });
		const handle = row("one").getByRole("button", { name: "Hero actions" }).first();

		for (const key of ["{Enter}", " "]) {
			(handle.element() as HTMLElement).focus();
			await userEvent.keyboard(key);
			await expect.element(screen.getByRole("menu")).toBeVisible();
			await expect.element(handle).toHaveAttribute("aria-expanded", "true");
			await userEvent.keyboard("{Escape}");
			await expect.element(screen.getByRole("menu")).not.toBeInTheDocument();
			await expect.element(handle).toHaveFocus();
		}
	});

	it("moves blocks with the menu, keeping their keys and values", async () => {
		const onValue = vi.fn();
		const first = heroBlock("first", "First");
		const second: StoredBlockValue = {
			_type: "hero",
			_version: 1,
			_key: "second",
			heading: "Second",
		};
		const screen = await renderField({ initial: [first, second], onValue });

		await openMenu("first");
		await expect
			.element(screen.getByRole("menuitem", { name: "Move up" }))
			.toHaveAttribute("aria-disabled", "true");
		await screen.getByRole("menuitem", { name: "Move down" }).click();

		expect(onValue.mock.lastCall?.[0]).toEqual([second, first]);
		expect(rowKeys()).toEqual(["second", "first"]);
		await expect.element(screen.getByText("Moved Hero to position 2 of 2")).toBeInTheDocument();

		await openMenu("first");
		await expect
			.element(screen.getByRole("menuitem", { name: "Move down" }))
			.toHaveAttribute("aria-disabled", "true");
		await screen.getByRole("menuitem", { name: "Move up" }).click();
		expect(onValue.mock.lastCall?.[0]).toEqual([first, second]);
	});

	it("deletes a block and puts it back in place with Undo", async () => {
		const onValue = vi.fn();
		const middle = heroBlock("middle", "Middle");
		const screen = await renderField({
			initial: [heroBlock("one"), middle, heroBlock("three")],
			onValue,
		});

		await openMenu("middle");
		await screen.getByRole("menuitem", { name: "Delete" }).click();
		expect(rowKeys()).toEqual(["one", "three"]);
		await expect
			.element(row("three").getByRole("button", { name: "Hero", exact: true }))
			.toHaveFocus();
		await expect.element(screen.getByText("Deleted Hero")).toBeVisible();

		await screen.getByRole("button", { name: "Undo" }).click();
		expect(rowKeys()).toEqual(["one", "middle", "three"]);
		expect(onValue.mock.lastCall?.[0][1]).toBe(middle);
		await expect.element(screen.getByText("Deleted Hero")).not.toBeInTheDocument();
	});

	it("keeps only the latest deletion undoable", async () => {
		const screen = await renderField({ initial: [heroBlock("one"), heroBlock("two")] });

		await openMenu("one");
		await screen.getByRole("menuitem", { name: "Delete" }).click();
		await openMenu("two");
		await screen.getByRole("menuitem", { name: "Delete" }).click();

		await expect.poll(() => screen.getByRole("button", { name: "Undo" }).all()).toHaveLength(1);
		await screen.getByRole("button", { name: "Undo" }).click();
		expect(rowKeys()).toEqual(["two"]);
	});

	it("closes the Undo toast when the field goes away", async () => {
		const screen = await renderField({ initial: [heroBlock("one"), heroBlock("two")] });

		await openMenu("one");
		await screen.getByRole("menuitem", { name: "Delete" }).click();
		await expect.element(screen.getByText("Deleted Hero")).toBeVisible();

		await screen.rerender(<p>Another page</p>);
		await expect.element(page.getByText("Deleted Hero"), { timeout: 2000 }).not.toBeInTheDocument();
	});

	it.each([
		["an inactive-version", { _type: "hero", _version: 1, _key: "old", heading: "Old" }, "Hero"],
		["a retired", { _type: "quote", _version: 1, _key: "old", text: "Quoted" }, "Quote"],
	])("asks before deleting %s block and offers no Undo", async (_, block, label) => {
		const screen = await renderField({ initial: [block, heroBlock("current")] });

		await openMenu("old");
		await screen.getByRole("menuitem", { name: "Delete" }).click();
		const dialog = screen.getByRole("alertdialog", { name: `Delete ${label}?` });
		await expect.element(dialog).toBeVisible();
		expect(rowKeys()).toEqual(["old", "current"]);

		(dialog.getByRole("button", { name: "Delete" }).element() as HTMLElement).click();
		await expect.poll(rowKeys).toEqual(["current"]);
		await expect.element(dialog).not.toBeInTheDocument();
		await expect
			.element(row("current").getByRole("button", { name: "Hero", exact: true }))
			.toHaveFocus();
		expect(screen.getByRole("button", { name: "Undo" }).query()).toBeNull();
	});

	it("disables every add action and Duplicate at maxItems", async () => {
		const screen = await renderField({
			initial: [heroBlock("one"), heroBlock("two")],
			maxItems: 2,
		});
		const add = screen.getByRole("button", { name: "Add block", exact: true });
		const gutterAdd = row("one").getByRole("button", { name: "Add block below" });

		await expect.element(add).toHaveAttribute("aria-disabled", "true");
		await expect.element(add).toHaveAccessibleDescription("This field holds up to 2 blocks.");
		await expect.element(gutterAdd).toHaveAttribute("aria-disabled", "true");
		await add.click({ force: true });
		await gutterAdd.click({ force: true });
		expect(screen.getByRole("combobox").query()).toBeNull();

		await openMenu("one");
		for (const name of ["Add block above", "Add block below", "Duplicate"]) {
			await expect
				.element(screen.getByRole("menuitem", { name }))
				.toHaveAttribute("aria-disabled", "true");
		}
	});

	it("shows each block type's icon, or the generic icon", async () => {
		const screen = await renderField({
			initial: [heroBlock("hero"), { _type: "gallery", _version: 1, _key: "gallery" }],
			blockTypes: [hero, gallery, blockType("plain", "Plain", [])],
			allowedTypes: ["hero", "gallery", "plain"],
		});

		await vi.waitFor(() => {
			expect(rendersIcon(row("hero").element(), <Sparkle />)).toBe(true);
			expect(rendersIcon(row("gallery").element(), <Cube />)).toBe(true);
		});
		expect(rendersIcon(row("gallery").element(), <Images />)).toBe(false);

		await screen.getByRole("button", { name: "Add block", exact: true }).click();
		await vi.waitFor(() => {
			expect(
				rendersIcon(screen.getByRole("option", { name: /^Hero/ }).element(), <Sparkle />),
			).toBe(true);
			expect(
				rendersIcon(screen.getByRole("option", { name: /^Gallery/ }).element(), <Cube />),
			).toBe(true);
			expect(rendersIcon(screen.getByRole("option", { name: /^Plain/ }).element(), <Cube />)).toBe(
				true,
			);
		});
	});

	it("keeps unsupported stored versions read-only", async () => {
		const unsupportedTypes = [
			{
				...hero,
				versions: [
					{
						...hero.versions[0]!,
						unsupportedTypes: [{ type: "future", path: "fields[0].type" }],
					},
				],
			},
		];
		const screen = await renderField({
			initial: [{ _type: "hero", _version: 1, _key: "unsupported" }],
			blockTypes: unsupportedTypes,
			allowedTypes: ["hero"],
			retiredTypes: [],
			renderField: () => <input aria-label="Must not render" />,
		});

		await expect.element(screen.getByText("Unsupported")).toBeVisible();
		await screen.getByRole("button", { name: "Hero", exact: true }).click();
		await expect
			.element(
				screen.getByText(
					"This block cannot be edited because its stored definition is unavailable.",
				),
			)
			.toBeVisible();
		expect(screen.getByLabelText("Must not render").query()).toBeNull();
	});

	it("hides the gutter, the menu and Add block when read-only", async () => {
		const screen = await renderField({ initial: [heroBlock("one")], readOnly: true });

		expect(screen.getByRole("button", { name: "Add block", exact: true }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Add block below" }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Hero actions" }).query()).toBeNull();

		await screen.getByRole("button", { name: "Hero", exact: true }).click();
		await expect.element(screen.getByLabelText("Title")).toHaveValue("one");
		await screen.getByRole("button", { name: "Hero", exact: true }).click();
		expect(screen.getByLabelText("Title").query()).toBeNull();
	});
});
