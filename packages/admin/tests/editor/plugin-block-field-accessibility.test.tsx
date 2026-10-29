import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
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

const pluginBlocks: NonNullable<PortableTextEditorProps["pluginBlocks"]> = [
	{
		type: "test.accessibility",
		pluginId: "test-blocks",
		label: "Accessibility test block",
		fields: [
			{ type: "text_input", action_id: "title", label: "Title" },
			{
				type: "text_input",
				action_id: "description",
				label: "Description",
				multiline: true,
			},
			{ type: "number_input", action_id: "priority", label: "Priority" },
			{
				type: "select",
				action_id: "category",
				label: "Category",
				options: [
					{ label: "News", value: "news" },
					{ label: "Guides", value: "guides" },
				],
			},
			{ type: "toggle", action_id: "featured", label: "Featured" },
			{
				type: "media_picker",
				action_id: "image",
				label: "Image",
				placeholder: "Select media",
			},
			{
				type: "repeater",
				action_id: "cards",
				label: "Cards",
				item_label: "card",
				fields: [{ type: "text_input", action_id: "title", label: "Title" }],
			},
		],
	},
];

const rtlPluginBlocks: NonNullable<PortableTextEditorProps["pluginBlocks"]> = [
	{
		...pluginBlocks[0]!,
		label: "كتلة الوصول",
		fields: [
			{ type: "text_input", action_id: "title", label: "العنوان" },
			{ type: "text_input", action_id: "description", label: "الوصف", multiline: true },
			{ type: "number_input", action_id: "priority", label: "الأولوية" },
			{
				type: "select",
				action_id: "category",
				label: "الفئة",
				options: [{ label: "أخبار", value: "news" }],
			},
			{ type: "toggle", action_id: "featured", label: "مميز" },
			{
				type: "media_picker",
				action_id: "image",
				label: "الصورة",
				placeholder: "Select media",
			},
			{
				type: "repeater",
				action_id: "cards",
				label: "البطاقات",
				item_label: "بطاقة",
				fields: [{ type: "text_input", action_id: "title", label: "العنوان" }],
			},
		],
	},
];

async function openBlock(
	value: Record<string, unknown>,
	blocks = pluginBlocks,
	wrapper?: React.ComponentType<React.PropsWithChildren>,
) {
	const screen = await render(
		<PortableTextEditor
			value={[{ _type: "test.accessibility", _key: "accessibility-1", ...value }]}
			onChange={vi.fn()}
			pluginBlocks={blocks}
		/>,
		wrapper ? { wrapper } : undefined,
	);
	await screen.getByRole("button", { name: "Edit" }).click();
	await expect.element(screen.getByRole("dialog")).toBeVisible();
	return screen;
}

describe("plugin block field accessibility", () => {
	it("names and associates every field while editing populated values", async () => {
		const screen = await openBlock({
			title: "Existing title",
			description: "Existing description",
			priority: 7,
			category: "guides",
			featured: true,
			image: "",
			cards: [{ title: "First card" }, { title: "Second card" }],
		});

		const title = screen.getByRole("textbox", { name: "Title", exact: true });
		const description = screen.getByRole("textbox", { name: "Description", exact: true });
		await expect.element(title).toHaveValue("Existing title");
		await expect.element(description).toHaveValue("Existing description");
		await expect
			.element(screen.getByRole("spinbutton", { name: "Priority", exact: true }))
			.toHaveValue(7);
		await expect
			.element(screen.getByRole("combobox", { name: "Category", exact: true }))
			.toHaveTextContent("Guides");
		await expect
			.element(screen.getByRole("switch", { name: "Featured", exact: true }))
			.toBeChecked();
		screen.getByText("Title", { exact: true }).element().click();
		await expect.element(title).toHaveFocus();

		const media = screen.getByRole("group", { name: "Image", exact: true });
		await expect
			.element(media.getByRole("button", { name: "Select media", exact: true }))
			.toBeVisible();

		const cards = screen.getByRole("group", { name: /^Cards/ });
		await expect.element(cards.getByRole("button", { name: "First card" })).toBeVisible();
		await expect.element(cards.getByRole("button", { name: "Second card" })).toBeVisible();
		cards.getByRole("button", { name: "First card" }).element().click();
		cards.getByRole("button", { name: "Second card" }).element().click();
		const rowTitles = cards.getByRole("textbox", { name: "Title", exact: true });
		await expect.element(rowTitles.nth(0)).toHaveValue("First card");
		await expect.element(rowTitles.nth(1)).toHaveValue("Second card");
		cards.getByText("Title", { exact: true }).nth(1).element().click();
		await expect.element(rowTitles.nth(1)).toHaveFocus();
	});

	it("keeps empty fields named in an RTL editing modal", async () => {
		const RtlWrapper = ({ children }: React.PropsWithChildren) => {
			React.useEffect(() => {
				const previousDir = document.documentElement.dir;
				document.documentElement.dir = "rtl";
				return () => {
					document.documentElement.dir = previousDir;
				};
			}, []);
			return <>{children}</>;
		};
		const screen = await openBlock(
			{
				title: "",
				description: "",
				priority: undefined,
				category: "",
				featured: false,
				image: "",
				cards: [],
			},
			rtlPluginBlocks,
			RtlWrapper,
		);

		await expect
			.element(screen.getByRole("textbox", { name: "العنوان", exact: true }))
			.toHaveValue("");
		await expect
			.element(screen.getByRole("textbox", { name: "الوصف", exact: true }))
			.toHaveValue("");
		await expect
			.element(screen.getByRole("spinbutton", { name: "الأولوية", exact: true }))
			.toHaveValue(null);
		await expect
			.element(screen.getByRole("combobox", { name: "الفئة", exact: true }))
			.toHaveTextContent("Select...");
		await expect
			.element(screen.getByRole("switch", { name: "مميز", exact: true }))
			.not.toBeChecked();
		await expect.element(screen.getByRole("group", { name: "الصورة", exact: true })).toBeVisible();
	});
});
