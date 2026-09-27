import { beforeEach, describe, expect, it, vi } from "vitest";

import { FieldEditor } from "../../src/components/FieldEditor.js";
import type { BlockType, CreateFieldInput } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

const blockTypes: BlockType[] = [
	{
		id: "hero-id",
		slug: "hero",
		label: "Hero",
		currentVersion: 2,
		source: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: "hero-v1",
				blockTypeId: "hero-id",
				version: 1,
				fields: [],
				fingerprint: "sha256:11111111",
				active: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "hero-v2",
				blockTypeId: "hero-id",
				version: 2,
				fields: [],
				fingerprint: "sha256:22222222",
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	},
];

describe("FieldEditor blocks configuration", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ success: true, data: { items: blockTypes } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);
	});

	it("creates an ordered blocks field from the read-only version inventory", async () => {
		const onSave = vi.fn<(input: CreateFieldInput) => void>();
		const screen = await render(<FieldEditor open onOpenChange={vi.fn()} onSave={onSave} />);

		screen
			.getByRole("button", { name: /^Blocks/ })
			.element()
			.click();
		await expect.element(screen.getByText("Active v2")).toBeInTheDocument();
		await expect.element(screen.getByText("v1")).toBeInTheDocument();
		await expect.element(screen.getByText("22222222")).toBeInTheDocument();

		await screen.getByLabelText("Label").fill("Page layout");
		screen.getByRole("checkbox", { name: "Hero" }).element().click();
		await screen.getByLabelText("Maximum blocks").fill("20");
		screen.getByRole("button", { name: "Add Field" }).element().click();

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				slug: "page_layout",
				type: "blocks",
				required: false,
				unique: false,
				indexed: false,
				validation: { allowedTypes: ["hero"], maxItems: 20 },
			}),
		);
	});
});
