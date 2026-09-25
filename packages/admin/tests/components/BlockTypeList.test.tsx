import { expect, it } from "vitest";

import { BlockTypeList } from "../../src/components/BlockTypeList.js";
import type { BlockType } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

it("shows active and retained versions with exact fingerprints", async () => {
	const blockType: BlockType = {
		id: "hero-id",
		slug: "hero",
		label: "Hero",
		description: "Page introduction",
		currentVersion: 2,
		source: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: "v1",
				blockTypeId: "hero-id",
				version: 1,
				fields: [],
				fingerprint: "sha256:first",
				active: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "v2",
				blockTypeId: "hero-id",
				version: 2,
				fields: [],
				fingerprint: "sha256:second",
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
	const screen = await render(<BlockTypeList blockTypes={[blockType]} />);

	await expect.element(screen.getByRole("heading", { name: "Block types" })).toBeInTheDocument();
	await expect.element(screen.getByText("Active v2")).toBeInTheDocument();
	await expect.element(screen.getByText(/Version 1/)).toBeInTheDocument();
	await expect.element(screen.getByText("sha256:first")).toBeInTheDocument();
	await expect.element(screen.getByText("sha256:second")).toBeInTheDocument();
});
