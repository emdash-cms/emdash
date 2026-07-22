import { describe, expect, it, vi } from "vitest";

import { ReferencesSidebar } from "../../src/components/ReferencesSidebar";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchCollections: vi.fn(async () => []),
	};
});

vi.mock("../../src/lib/api/relations.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/relations.js");
	return {
		...actual,
		fetchRelations: vi.fn(async () => []),
		fetchReferenceParents: vi.fn(async () => ({ parents: [] })),
	};
});

describe("ReferencesSidebar", () => {
	it("shows an empty state when the entry has no backlinks", async () => {
		const screen = await render(
			<ReferencesSidebar collection="posts" entryId="post-1" entryLocale="en" />,
		);

		await expect
			.element(screen.getByRole("heading", { name: "Referenced by" }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("No references yet.")).toBeInTheDocument();
	});
});
