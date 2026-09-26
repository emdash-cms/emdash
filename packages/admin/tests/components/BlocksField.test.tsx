import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { BlocksField } from "../../src/components/BlocksField.js";
import type { BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { render } from "../utils/render.js";

const blockTypes: BlockType[] = [
	{
		id: "hero-id",
		slug: "hero",
		label: "Hero",
		description: "A page hero",
		category: "Layout",
		currentVersion: 2,
		source: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
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
	},
	{
		id: "quote-id",
		slug: "quote",
		label: "Quote",
		currentVersion: 1,
		source: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: "quote-v1",
				blockTypeId: "quote-id",
				version: 1,
				fields: [{ slug: "text", label: "Text", type: "text" }],
				fingerprint: "quote-v1",
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	},
];

function Harness({ initial }: { initial: StoredBlockValue[] }) {
	const [value, setValue] = React.useState(initial);
	return (
		<BlocksField
			id="field-layout"
			fieldPath="layout"
			label="Layout"
			value={value}
			onChange={setValue}
			blockTypes={blockTypes}
			allowedTypes={["hero", "quote"]}
			retiredTypes={["quote"]}
			renderField={({ name, field, value: fieldValue, onChange }) => (
				<input
					id={`field-${name}`}
					aria-label={field.label}
					value={typeof fieldValue === "string" ? fieldValue : ""}
					onChange={(event) => onChange(event.target.value)}
				/>
			)}
		/>
	);
}

describe("BlocksField", () => {
	it("edits retained versions with path-stable controls and badges", async () => {
		const screen = await render(
			<Harness
				initial={[
					{ _type: "hero", _version: 1, _key: "hero-key", heading: "Before" },
					{ _type: "quote", _version: 1, _key: "quote-key", text: "Quoted" },
				]}
			/>,
		);

		await expect.element(screen.getByText("Inactive version")).toBeInTheDocument();
		await expect.element(screen.getByText("Retired")).toBeInTheDocument();
		const heading = screen.getByLabelText("Heading");
		expect(heading.element().id).toBe("field-layout.hero-key.heading");
		await heading.fill("After");
		await expect.element(heading).toHaveValue("After");
		expect(screen.getByRole("button", { name: "Duplicate block" }).all()[1]).toBeDisabled();
	});

	it("adds, duplicates, collapses, and deletes without losing identity", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID")
			.mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
			.mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
		const screen = await render(
			<Harness initial={[{ _type: "hero", _version: 2, _key: "hero-key", title: "Hello" }]} />,
		);

		await userEvent.click(screen.getByRole("button", { name: "Add block" }));
		await userEvent.click(screen.getByRole("button", { name: "HeroA page hero" }));
		expect(
			document.querySelectorAll('[data-block-key="00000000-0000-4000-8000-000000000001"]'),
		).toHaveLength(1);

		await userEvent.click(screen.getByRole("button", { name: "Collapse block" }).first());
		expect(screen.getByLabelText("Title").all()).toHaveLength(1);
		await userEvent.click(screen.getByRole("button", { name: "Expand block" }));
		await userEvent.click(screen.getByRole("button", { name: "Duplicate block" }).first());
		expect(document.querySelectorAll("[data-block-key]")).toHaveLength(3);
		await userEvent.click(screen.getByRole("button", { name: "Delete block" }).first());
		expect(document.querySelectorAll("[data-block-key]")).toHaveLength(2);
	});

	it("keeps unsupported stored versions read-only", async () => {
		const unsupportedTypes = [
			{
				...blockTypes[0]!,
				versions: [
					{
						...blockTypes[0]!.versions[0]!,
						unsupportedTypes: [{ type: "future", path: "fields[0].type" }],
					},
				],
			},
		];
		const screen = await render(
			<BlocksField
				id="field-layout"
				fieldPath="layout"
				label="Layout"
				value={[{ _type: "hero", _version: 1, _key: "unsupported" }]}
				onChange={vi.fn()}
				blockTypes={unsupportedTypes}
				allowedTypes={["hero"]}
				retiredTypes={[]}
				renderField={() => <input aria-label="Must not render" />}
			/>,
		);

		await expect.element(screen.getByText("Unsupported")).toBeInTheDocument();
		await expect
			.element(
				screen.getByText(
					"This block cannot be edited because its stored definition is unavailable.",
				),
			)
			.toBeInTheDocument();
		expect(screen.getByLabelText("Must not render").query()).toBeNull();
	});

	it("reorders the same stored values from the keyboard drag handle", async () => {
		const screen = await render(
			<Harness
				initial={[
					{ _type: "hero", _version: 2, _key: "first", title: "First" },
					{ _type: "hero", _version: 1, _key: "second", heading: "Second" },
				]}
			/>,
		);
		const firstHandle = screen.getByRole("button", { name: "Reorder Hero" }).first().element();
		firstHandle.focus();
		await userEvent.keyboard("{Space}");
		await userEvent.keyboard("{ArrowDown}");
		await userEvent.keyboard("{Space}");

		await vi.waitFor(() => {
			expect(
				Array.from(document.querySelectorAll<HTMLElement>("[data-block-key]"), (element) =>
					element.getAttribute("data-block-key"),
				),
			).toEqual(["second", "first"]);
		});
	});

	it("uses logical controls in RTL", async () => {
		document.documentElement.dir = "rtl";
		const screen = await render(
			<Harness initial={[{ _type: "hero", _version: 2, _key: "hero-key", title: "RTL" }]} />,
		);

		await userEvent.click(screen.getByRole("button", { name: "Collapse block" }));
		const expandIcon = screen
			.getByRole("button", { name: "Expand block" })
			.element()
			.querySelector("svg");
		expect(expandIcon?.classList.contains("rtl:-scale-x-100")).toBe(true);
		document.documentElement.dir = "ltr";
	});
});
