/**
 * Structured Block Kit fields: `portable_text` and `block_list`, plus the
 * plugin-block Duplicate affordance. Focused behaviour coverage:
 *   - portable_text mounts a real nested editor and emits Portable Text
 *     arrays (never strings), preserving marks on the emitted spans;
 *   - block_list adds a registered block through its own Block Kit form,
 *     edits it, duplicates it, removes it, reorders data, and moves an item
 *     to a sibling list registered in the same form;
 *   - the plugin-block node card duplicates a block in the document.
 */
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import type { PluginBlockDef } from "../../src/components/PortableTextEditor";
import {
	_BlockKitBlockListField,
	_BlockKitPortableTextField,
	_BlockKitRepeater,
	_BlockListSiblingsProvider,
	_PluginBlockCatalogContext,
	_visiblePluginBlocks,
	PortableTextEditor,
} from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));
vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

const catalog: PluginBlockDef[] = [
	{
		type: "acme.heading",
		pluginId: "acme",
		label: "Heading",
		fields: [{ type: "text_input", action_id: "text", label: "Text" }],
	},
	{
		type: "acme.note",
		pluginId: "acme",
		label: "Note",
		fields: [{ type: "text_input", action_id: "body", label: "Body" }],
	},
	{
		type: "acme.widget",
		pluginId: "acme",
		label: "Widget",
		hidden: true,
		fields: [{ type: "text_input", action_id: "title", label: "Title" }],
	},
];

function screenRoot(): HTMLElement {
	return document.body;
}

function query<T extends HTMLElement>(selector: string): T | null {
	return screenRoot().querySelector<T>(selector);
}

function queryAll<T extends HTMLElement>(selector: string): T[] {
	return [...screenRoot().querySelectorAll<T>(selector)];
}

function byAria(label: string): HTMLElement[] {
	return queryAll<HTMLElement>(`[aria-label="${label}"]`);
}

function click(el: HTMLElement | null | undefined) {
	expect(el, "expected an element to click").toBeTruthy();
	el!.click();
}

describe("portable_text field", () => {
	it("mounts a nested editor and emits Portable Text arrays, never strings", async () => {
		const onChange = vi.fn();
		await render(
			<_BlockKitPortableTextField
				field={{ type: "portable_text", action_id: "content", label: "Content" }}
				value={[
					{
						_type: "block",
						_key: "b1",
						style: "normal",
						markDefs: [],
						children: [{ _type: "span", _key: "s1", text: "seeded", marks: ["strong"] }],
					},
				]}
				onChange={onChange}
			/>,
		);
		await vi.waitFor(() => expect(query('[contenteditable="true"]')).toBeTruthy());
		expect(screenRoot().textContent).toContain("seeded");

		const pm = query<HTMLElement>('[contenteditable="true"]')!;
		pm.focus();
		document.execCommand("insertText", false, "!");
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });

		const [actionId, emitted] = onChange.mock.calls.at(-1)!;
		expect(actionId).toBe("content");
		expect(Array.isArray(emitted)).toBe(true);
		const blocks = emitted as Array<{ _type: string; children?: Array<{ marks?: string[] }> }>;
		expect(blocks[0]!._type).toBe("block");
		// the seeded strong mark survives the round trip
		expect(blocks[0]!.children?.some((span) => (span.marks ?? []).includes("strong"))).toBe(true);
	});
});

describe("block_list field", () => {
	function renderList(
		onChange: (actionId: string, value: unknown) => void,
		value: unknown = [],
		extra?: React.ReactNode,
	) {
		return render(
			<_PluginBlockCatalogContext.Provider value={catalog}>
				<_BlockListSiblingsProvider>
					<_BlockKitBlockListField
						field={{ type: "block_list", action_id: "blocks", label: "Blocks" }}
						value={value}
						onChange={onChange}
					/>
					{extra}
				</_BlockListSiblingsProvider>
			</_PluginBlockCatalogContext.Provider>,
		);
	}

	it("adds a registered block through its own Block Kit form", async () => {
		const onChange = vi.fn();
		await renderList(onChange);

		click(queryAll<HTMLButtonElement>("button").find((b) => b.textContent?.includes("Add block")));
		// two registered types -> a type picker appears; committing a choice opens the child form.
		await vi.waitFor(() => expect(queryAll("[role='combobox']").length).toBeGreaterThan(0));
		const trigger = queryAll<HTMLElement>("[role='combobox']").at(-1);
		expect(trigger).toBeTruthy();

		// drive the child form directly through the modal once a type is chosen
		// (the base-ui select needs a real pointer; choose via keyboard events instead)
		trigger!.focus();
		trigger!.click();
		await vi.waitFor(() => expect(queryAll("[role='option']").length).toBeGreaterThan(0));
		click(queryAll<HTMLElement>("[role='option']").find((o) => o.textContent === "Heading"));

		await vi.waitFor(() => expect(screenRoot().textContent).toContain("Insert Heading"));
		const textInput = queryAll<HTMLInputElement>("input[type='text']").at(-1)!;
		textInput.focus();
		const nativeSetter = Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)!.set!;
		nativeSetter.call(textInput, "Hello world");
		textInput.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.waitFor(() =>
			expect(
				queryAll<HTMLButtonElement>("button").find(
					(b) => b.type === "submit" && !b.disabled && b.textContent === "Insert",
				),
			).toBeTruthy(),
		);
		click(
			queryAll<HTMLButtonElement>("button").find(
				(b) => b.type === "submit" && b.textContent === "Insert",
			),
		);

		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		const [actionId, emitted] = onChange.mock.calls.at(-1)!;
		expect(actionId).toBe("blocks");
		const items = emitted as Array<Record<string, unknown>>;
		expect(items).toHaveLength(1);
		expect(items[0]!._type).toBe("acme.heading");
		expect(typeof items[0]!._key).toBe("string");
		expect(items[0]!.text).toBe("Hello world");
	});

	it("duplicates and removes items, keeping ordinary block objects", async () => {
		const onChange = vi.fn();
		await renderList(onChange, [
			{ _type: "acme.heading", _key: "k1", text: "One" },
			{ _type: "acme.note", _key: "k2", body: "Two" },
		]);

		click(byAria("Duplicate item 1")[0]);
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		let items = onChange.mock.calls.at(-1)![1] as Array<Record<string, unknown>>;
		expect(items.map((i) => i._type)).toEqual(["acme.heading", "acme.heading", "acme.note"]);
		expect(items[1]!.text).toBe("One");
		expect(items[1]!._key).not.toBe("k1");

		await vi.waitFor(() => expect(byAria("Remove item 3").length).toBeGreaterThan(0));
		click(byAria("Remove item 3")[0]);
		items = onChange.mock.calls.at(-1)![1] as Array<Record<string, unknown>>;
		expect(items.map((i) => i._key)).toEqual(["k1", items[1]!._key]);
	});

	it("moves an item to a sibling list registered in the same form", async () => {
		const first = vi.fn();
		const second = vi.fn();
		await render(
			<_PluginBlockCatalogContext.Provider value={catalog}>
				<_BlockListSiblingsProvider>
					<_BlockKitBlockListField
						field={{ type: "block_list", action_id: "colA", label: "Column A" }}
						value={[{ _type: "acme.heading", _key: "k1", text: "Movable" }]}
						onChange={first}
					/>
					<_BlockKitBlockListField
						field={{ type: "block_list", action_id: "colB", label: "Column B" }}
						value={[]}
						onChange={second}
					/>
				</_BlockListSiblingsProvider>
			</_PluginBlockCatalogContext.Provider>,
		);

		// the first list's item offers a move target naming the sibling
		const moveTrigger = queryAll<HTMLElement>("[role='combobox']").at(0);
		expect(moveTrigger).toBeTruthy();
		moveTrigger!.click();
		await vi.waitFor(() => expect(queryAll("[role='option']").length).toBeGreaterThan(0));
		click(queryAll<HTMLElement>("[role='option']").find((o) => o.textContent === "Column B"));

		await vi.waitFor(() => expect(second).toHaveBeenCalled());
		const received = second.mock.calls.at(-1)![1] as Array<Record<string, unknown>>;
		expect(received).toHaveLength(1);
		expect(received[0]!.text).toBe("Movable");
		const remaining = first.mock.calls.at(-1)![1] as Array<Record<string, unknown>>;
		expect(remaining).toHaveLength(0);
	});
});

describe("hidden plugin blocks", () => {
	it("visiblePluginBlocks keeps only defs without the hidden flag", () => {
		expect(_visiblePluginBlocks(catalog).map((b) => b.type)).toEqual(["acme.heading", "acme.note"]);
	});

	it("the default add picker offers only visible blocks", async () => {
		await render(
			<_PluginBlockCatalogContext.Provider value={catalog}>
				<_BlockListSiblingsProvider>
					<_BlockKitBlockListField
						field={{ type: "block_list", action_id: "blocks", label: "Blocks" }}
						value={[]}
						onChange={vi.fn()}
					/>
				</_BlockListSiblingsProvider>
			</_PluginBlockCatalogContext.Provider>,
		);

		click(queryAll<HTMLButtonElement>("button").find((b) => b.textContent?.includes("Add block")));
		await vi.waitFor(() => expect(queryAll("[role='combobox']").length).toBeGreaterThan(0));
		const trigger = queryAll<HTMLElement>("[role='combobox']").at(-1)!;
		trigger.focus();
		trigger.click();
		await vi.waitFor(() => expect(queryAll("[role='option']").length).toBeGreaterThan(0));
		const labels = queryAll<HTMLElement>("[role='option']").map((o) => o.textContent);
		expect(labels).toContain("Heading");
		expect(labels).toContain("Note");
		expect(labels).not.toContain("Widget");
	});

	it("an explicit allowed_types list still offers a hidden block", async () => {
		await render(
			<_PluginBlockCatalogContext.Provider value={catalog}>
				<_BlockListSiblingsProvider>
					<_BlockKitBlockListField
						field={{
							type: "block_list",
							action_id: "blocks",
							label: "Blocks",
							allowed_types: ["acme.widget"],
						}}
						value={[]}
						onChange={vi.fn()}
					/>
				</_BlockListSiblingsProvider>
			</_PluginBlockCatalogContext.Provider>,
		);

		// a single allowed type skips the picker and opens the child form directly
		click(queryAll<HTMLButtonElement>("button").find((b) => b.textContent?.includes("Add block")));
		await vi.waitFor(() => expect(screenRoot().textContent).toContain("Insert Widget"));
	});
});

describe("plugin block Duplicate affordance", () => {
	it("duplicates a plugin block in the document with identical data", async () => {
		const onChange = vi.fn();
		await render(
			<PortableTextEditor
				value={[{ _type: "acme.heading", _key: "pb1", text: "Duplicate me" } as never]}
				onChange={onChange}
				pluginBlocks={catalog}
			/>,
		);
		await vi.waitFor(() => expect(byAria("Duplicate").length).toBeGreaterThan(0), {
			timeout: 5000,
		});

		click(byAria("Duplicate")[0]);
		await vi.waitFor(() => {
			const blocks = (onChange.mock.calls.at(-1)?.[0] ?? []) as Array<Record<string, unknown>>;
			expect(blocks.filter((b) => b._type === "acme.heading")).toHaveLength(2);
		});
		const blocks = onChange.mock.calls.at(-1)![0] as Array<Record<string, unknown>>;
		const copies = blocks.filter((b) => b._type === "acme.heading");
		expect(copies[0]!.text).toBe("Duplicate me");
		expect(copies[1]!.text).toBe("Duplicate me");
	});
});

describe("late seeding and sibling moves inside a repeater", () => {
	it("a portable_text field re-seeds when its value arrives after mount, until the author types", async () => {
		const onChange = vi.fn();
		const Host = ({ value }: { value: unknown }) => (
			<_BlockKitPortableTextField
				field={{ type: "portable_text", action_id: "content", label: "Content" }}
				value={value}
				onChange={onChange}
			/>
		);
		const { rerender } = await render(<Host value={undefined} />);
		await vi.waitFor(() => expect(query('[contenteditable="true"]')).toBeTruthy());
		expect(screenRoot().textContent).not.toContain("arrived late");
		// the dialog's effect seeds the value a tick after the first render
		await rerender(
			<Host
				value={[
					{
						_type: "block",
						_key: "b1",
						style: "normal",
						markDefs: [],
						children: [{ _type: "span", _key: "s1", text: "arrived late", marks: [] }],
					},
				]}
			/>,
		);
		await vi.waitFor(() => expect(screenRoot().textContent).toContain("arrived late"));
		// typing keeps the seeded document and emits the FULL array (never just the typed text)
		const pm = query<HTMLElement>('[contenteditable="true"]')!;
		pm.focus();
		document.execCommand("insertText", false, "!");
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
		const emitted = onChange.mock.calls.at(-1)![1] as Array<{ children?: Array<{ text: string }> }>;
		const text = emitted
			.flatMap((b) => b.children ?? [])
			.map((s) => s.text)
			.join("");
		expect(text).toContain("arrived late");
	});

	it("moving a block between two repeater rows keeps it (the second row write does not erase the first)", async () => {
		const onChange = vi.fn();
		await render(
			<_PluginBlockCatalogContext.Provider value={catalog}>
				<_BlockListSiblingsProvider>
					<_BlockKitRepeater
						field={{
							type: "repeater",
							action_id: "columns",
							label: "Columns",
							fields: [
								{ type: "text_input", action_id: "width", label: "Width" },
								{ type: "block_list", action_id: "blocks", label: "Blocks" },
							],
						}}
						value={[
							{ width: "55", blocks: [{ _type: "acme.heading", _key: "k1", text: "Movable" }] },
							{ width: "45", blocks: [] },
						]}
						onChange={onChange}
					/>
				</_BlockListSiblingsProvider>
			</_PluginBlockCatalogContext.Provider>,
		);
		// expand both rows so both block lists mount and register as move targets
		const headers = () =>
			queryAll<HTMLButtonElement>('button[aria-expanded="false"]:not([aria-label])');
		await vi.waitFor(() => expect(headers().length).toBe(2));
		click(headers()[0]);
		await vi.waitFor(() => expect(headers().length).toBe(1));
		click(headers()[0]);
		await vi.waitFor(() => expect(byAria("Edit item 1").length).toBeGreaterThan(0));
		// the first row's item offers "Move to…" naming the sibling row (labelled by its width)
		// (it appears once the second row's list has registered — a tick after it mounts)
		const findMove = () =>
			queryAll<HTMLElement>("[role='combobox']").find((c) => c.textContent?.includes("Move to"));
		await vi.waitFor(() => expect(findMove(), "a Move to… control on the block row").toBeTruthy());
		findMove()!.click();
		await vi.waitFor(() => expect(queryAll("[role='option']").length).toBeGreaterThan(1));
		click(queryAll<HTMLElement>("[role='option']").find((o) => o.textContent === "45"));
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		const rows = onChange.mock.calls.at(-1)![1] as Array<{
			width: string;
			blocks: Array<{ text: string }>;
		}>;
		expect(rows[0]!.blocks).toHaveLength(0);
		expect(rows[1]!.blocks).toHaveLength(1);
		expect(rows[1]!.blocks[0]!.text).toBe("Movable");
	});
});
