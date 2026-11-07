import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api.js")>()),
	fetchMediaList: vi.fn().mockResolvedValue({
		items: ["diagram.png", "landscape.png"].map((filename) => ({
			id: filename,
			filename,
			mimeType: "image/png",
			url: `/media/${filename}`,
			storageKey: filename,
			provider: "local",
			size: 1024,
			width: 800,
			height: 600,
			createdAt: "2026-10-01T00:00:00.000Z",
		})),
		totalCount: 2,
	}),
	fetchMediaFolders: vi.fn().mockResolvedValue({ items: [] }),
	fetchMediaProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "editor-1", role: 40 } }),
}));

const pluginBlocks: NonNullable<PortableTextEditorProps["pluginBlocks"]> = [
	{
		type: "test.slides",
		pluginId: "test-slides",
		label: "Slides",
		fields: [
			{
				type: "repeater",
				action_id: "slides",
				label: "Slides",
				item_label: "slide",
				fields: [
					{ type: "media_picker", action_id: "image", label: "Image" },
					{ type: "text_input", action_id: "caption", label: "Caption" },
				],
			},
		],
	},
];

describe("plugin block media repeater", () => {
	it("keeps selected images paired with captions through save, reload, reorder, and replacement", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		function Editor() {
			const [value, setValue] = React.useState<NonNullable<PortableTextEditorProps["value"]>>([
				{ _type: "test.slides", _key: "slides-1", slides: [] },
			]);
			const [generation, setGeneration] = React.useState(0);
			return (
				<>
					<PortableTextEditor
						key={generation}
						value={value}
						pluginBlocks={pluginBlocks}
						onChange={(next) => {
							setValue(next);
							onChange(next);
						}}
					/>
					<button onClick={() => setGeneration((previous) => previous + 1)}>Reload editor</button>
				</>
			);
		}
		const screen = await render(<Editor />);
		const openBlock = () => screen.getByRole("button", { name: "Edit", exact: true }).click();
		const saveBlock = () => screen.getByRole("button", { name: "Save", exact: true }).click();
		const chooseImage = async (filename: string) => {
			const picker = screen.getByRole("dialog", { name: /^(Select|Replace) Image$/ });
			await picker.getByRole("button", { name: filename, exact: true }).click();
			await picker.getByRole("button", { name: /^(Select|Replace)$/ }).click();
		};
		const expectSlides = async (slides: Array<{ image: string; caption: string }>) => {
			await vi.waitFor(() => {
				expect(onChange.mock.lastCall?.[0]).toEqual([
					expect.objectContaining({ _type: "test.slides", slides }),
				]);
			});
		};

		await openBlock();
		await screen.getByRole("button", { name: "Add slide", exact: true }).first().click();
		await screen.getByRole("textbox", { name: "Caption", exact: true }).fill("Diagram");
		await screen.getByRole("button", { name: "Select media", exact: true }).click();
		await chooseImage("diagram.png");
		await screen.getByRole("button", { name: "Diagram", exact: true }).click();
		await screen.getByRole("button", { name: "Add slide", exact: true }).click();
		await screen.getByRole("textbox", { name: "Caption", exact: true }).fill("Landscape");
		await screen.getByRole("button", { name: "Select media", exact: true }).click();
		await chooseImage("landscape.png");
		await saveBlock();
		const diagram = { image: "/_emdash/api/media/file/diagram.png", caption: "Diagram" };
		const landscape = { image: "/_emdash/api/media/file/landscape.png", caption: "Landscape" };
		await expectSlides([diagram, landscape]);

		await screen.getByRole("button", { name: "Reload editor", exact: true }).click();
		await openBlock();
		const dragHandle = screen.getByRole("button", { name: "Drag to reorder", exact: true }).first();
		await dragHandle.dropTo(
			screen.getByRole("button", { name: "Drag to reorder", exact: true }).last(),
		);
		await saveBlock();
		await expectSlides([landscape, diagram]);

		await screen.getByRole("button", { name: "Reload editor", exact: true }).click();
		await openBlock();
		await screen.getByRole("button", { name: "Landscape", exact: true }).click();
		const change = screen.getByRole("button", { name: "Replace Image", exact: true });
		change.element().focus();
		await change.click();
		await chooseImage("diagram.png");
		await saveBlock();
		await expectSlides([{ ...landscape, image: diagram.image }, diagram]);

		await openBlock();
		await screen.getByRole("button", { name: "Landscape", exact: true }).click();
		const remove = screen.getByRole("button", { name: "Remove Image", exact: true });
		remove.element().focus();
		await remove.click();
		await screen.getByRole("button", { name: "Remove item 2", exact: true }).click();
		await saveBlock();
		await expectSlides([{ image: "", caption: "Landscape" }]);
	});
});
