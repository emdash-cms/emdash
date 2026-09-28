import { beforeEach, describe, expect, it, vi } from "vitest";

const loadLabels = vi.fn();

vi.mock("@emdash-cms/admin/locales/server", () => ({
	loadVisualEditingToolbarLabels: loadLabels,
}));

describe("visual-editing toolbar labels route", () => {
	beforeEach(() => {
		loadLabels.mockResolvedValue({
			editMode: "Editar",
			hideToolbar: "Ocultar barra",
		});
	});

	it("returns localized bootstrap labels without shared caching", async () => {
		const { GET } = await import("../../../src/astro/routes/api/visual-editing/toolbar-labels.js");
		const request = new Request("https://example.com/_emdash/api/visual-editing/toolbar-labels");
		const response = await GET({ request } as never);

		expect(loadLabels).toHaveBeenCalledWith(request);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			success: true,
			data: { editMode: "Editar", hideToolbar: "Ocultar barra" },
		});
	});
});
